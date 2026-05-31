import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 텍스트 코퍼스를 스캔할 최근 윈도우 (일)
const WINDOW_DAYS = 30
// alias 매칭 시 너무 짧은 토큰은 오탐이 많아 제외
const MIN_ALIAS_LEN = 2
// 문서 1건에서 추출되는 product 수 상한 (한 글에 사전 전체가 매칭되는 노이즈 방지)
const MAX_PRODUCTS_PER_DOC = 12
// 적재 시 최소 동시언급 수 (1회 동반은 노이즈로 보고 버림)
const MIN_DOC_COUNT = 2

type AliasRow = { alias: string; product_id: string }

/** 문서에서 검출 가능한 모든 텍스트를 하나로 합침 */
function collectText(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' \n ').toLowerCase()
}

/** payload(jsonb) 안의 문자열을 재귀적으로 모아 텍스트화 (깊이 제한) */
function flattenStrings(value: unknown, depth = 0, acc: string[] = []): string[] {
  if (depth > 4 || acc.length > 200) return acc
  if (typeof value === 'string') {
    acc.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) flattenStrings(v, depth + 1, acc)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) flattenStrings(v, depth + 1, acc)
  }
  return acc
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const sinceISO = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

  // 1) alias 사전 적재 → 길이 내림차순(긴 별칭 우선 매칭)
  const { data: aliasData, error: aliasErr } = await admin
    .from('jimscanner_trends_aliases')
    .select('alias, product_id')
    .limit(20_000)
  if (aliasErr) return NextResponse.json({ error: aliasErr.message }, { status: 500 })

  const aliases: { alias: string; pid: string }[] = []
  for (const a of (aliasData ?? []) as AliasRow[]) {
    const norm = (a.alias ?? '').trim().toLowerCase()
    if (norm.length >= MIN_ALIAS_LEN) aliases.push({ alias: norm, pid: a.product_id })
  }
  aliases.sort((x, y) => y.alias.length - x.alias.length)

  if (aliases.length === 0)
    return NextResponse.json({ ok: true, note: 'alias 사전 비어있음 — 매칭 불가', pairs: 0 })

  /** 한 문서 텍스트에서 등장 product id 집합을 추출 */
  function productsInDoc(text: string): Set<string> {
    const found = new Set<string>()
    for (const { alias, pid } of aliases) {
      if (found.size >= MAX_PRODUCTS_PER_DOC) break
      if (found.has(pid)) continue
      if (text.includes(alias)) found.add(pid)
    }
    return found
  }

  // 집계용 누산기
  const docFreq = new Map<string, number>() // product → 등장 문서 수
  const pairCount = new Map<string, number>() // "a|b" → 동반 문서 수
  const pairSources = new Map<string, Set<string>>() // "a|b" → source 집합
  const pairLastSeen = new Map<string, string>() // "a|b" → 최근 동반 시각
  let docsScanned = 0
  let docsWithProduct = 0

  function ingestDoc(text: string, source: string, seenAt: string) {
    docsScanned++
    if (!text) return
    const pids = productsInDoc(text)
    if (pids.size === 0) return
    docsWithProduct++
    const arr = [...pids]
    for (const p of arr) docFreq.set(p, (docFreq.get(p) ?? 0) + 1)
    if (arr.length < 2) return
    arr.sort() // uuid 텍스트 정렬 → product_a < product_b 보장
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
        let ss = pairSources.get(key)
        if (!ss) { ss = new Set(); pairSources.set(key, ss) }
        ss.add(source)
        const prev = pairLastSeen.get(key)
        if (!prev || seenAt > prev) pairLastSeen.set(key, seenAt)
      }
    }
  }

  // 2) market_raw 스캔 (title + metadata.description + query)
  const { data: marketRows } = await admin
    .from('jimscanner_market_raw')
    .select('source, title, query, metadata, captured_at')
    .gte('captured_at', sinceISO)
    .order('captured_at', { ascending: false })
    .limit(8_000)
  for (const r of (marketRows ?? []) as any[]) {
    const md = (r.metadata ?? {}) as Record<string, unknown>
    const text = collectText(r.title, r.query, md.description as string, md.snippet as string)
    ingestDoc(text, `market:${r.source}`, r.captured_at as string)
  }

  // 3) trends_raw 스캔 (payload 안의 모든 문자열)
  const { data: trendRows } = await admin
    .from('jimscanner_trends_raw')
    .select('source, payload, collected_at')
    .gte('collected_at', sinceISO)
    .order('collected_at', { ascending: false })
    .limit(4_000)
  for (const r of (trendRows ?? []) as any[]) {
    const text = flattenStrings(r.payload).join(' \n ').toLowerCase()
    ingestDoc(text, `trends:${r.source}`, r.collected_at as string)
  }

  // 4) PMI 계산 후 적재 행 구성
  const N = Math.max(docsWithProduct, 1)
  const nowISO = new Date().toISOString()
  const rows: {
    product_a: string
    product_b: string
    doc_count: number
    source_breadth: number
    pmi: number
    last_seen: string
    computed_at: string
  }[] = []

  for (const [key, count] of pairCount) {
    if (count < MIN_DOC_COUNT) continue
    const [a, b] = key.split('|')
    const fa = docFreq.get(a) ?? 1
    const fb = docFreq.get(b) ?? 1
    // PMI = log2( P(a,b) / (P(a)·P(b)) ) = log2( count·N / (fa·fb) )
    const pmi = Math.log2((count * N) / (fa * fb))
    rows.push({
      product_a: a,
      product_b: b,
      doc_count: count,
      source_breadth: pairSources.get(key)?.size ?? 1,
      pmi: Math.round(pmi * 1000) / 1000,
      last_seen: pairLastSeen.get(key) ?? nowISO,
      computed_at: nowISO,
    })
  }

  // 5) 전량 교체 (이 쌍 집합이 곧 최신 스냅샷). 빈 결과면 기존 유지.
  let upserted = 0
  if (rows.length > 0) {
    // 이번 윈도우에서 사라진 오래된 쌍 제거 후 재적재
    await (admin as any).from('jimscanner_trends_cooccurrence').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    // 청크 단위 insert (대량 행 대비)
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const { error } = await (admin as any).from('jimscanner_trends_cooccurrence').insert(chunk)
      if (error) return NextResponse.json({ error: error.message, upserted }, { status: 500 })
      upserted += chunk.length
    }
  }

  return NextResponse.json({
    ok: true,
    window_days: WINDOW_DAYS,
    aliases: aliases.length,
    docs_scanned: docsScanned,
    docs_with_product: docsWithProduct,
    distinct_products: docFreq.size,
    candidate_pairs: pairCount.size,
    stored_pairs: upserted,
    executed_at: nowISO,
  })
}
