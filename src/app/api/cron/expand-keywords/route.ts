import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// BFS 설정
const SEED_LIMIT = 10           // 상위 N개 trends_products 키워드를 시드로
const MAX_DEPTH = 2             // depth=0(seed) → depth=2 까지 펼침
const FANOUT = 6                // 노드당 자동완성 상위 N개만 사용
const SLEEP_MS = 150            // 요청 간 sleep
const MAX_NODES_PER_SEED = 80   // 시드당 안전 한계

type Source = 'google_suggest' | 'naver_suggest'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchGoogleSuggest(query: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    },
  })
  if (!res.ok) return []
  const json = (await res.json().catch(() => null)) as unknown
  if (!Array.isArray(json) || json.length < 2) return []
  const list = json[1]
  if (!Array.isArray(list)) return []
  return list.filter((x): x is string => typeof x === 'string').slice(0, FANOUT)
}

async function fetchNaverSuggest(query: string): Promise<string[]> {
  // 공개 자동완성 엔드포인트 (ac.search.naver.com).
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(query)}&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
      Referer: 'https://www.naver.com/',
    },
  }).catch(() => null)
  if (!res || !res.ok) return []
  const json = (await res.json().catch(() => null)) as unknown
  // 네이버 응답: { items: [[[ "키워드", ... ], ...], ...] }
  if (!json || typeof json !== 'object') return []
  const items = (json as { items?: unknown[] }).items
  if (!Array.isArray(items) || items.length === 0) return []
  const out: string[] = []
  for (const block of items) {
    if (!Array.isArray(block)) continue
    for (const row of block) {
      if (Array.isArray(row) && typeof row[0] === 'string') out.push(row[0])
    }
  }
  return out.slice(0, FANOUT)
}

type Node = { keyword: string; depth: number; parent: string | null }

async function bfsExpand(seed: string, source: Source): Promise<Node[]> {
  const visited = new Set<string>()
  const out: Node[] = [{ keyword: seed, depth: 0, parent: null }]
  visited.add(seed)
  let frontier: Node[] = [out[0]]

  for (let d = 1; d <= MAX_DEPTH; d++) {
    const next: Node[] = []
    for (const node of frontier) {
      if (out.length >= MAX_NODES_PER_SEED) break
      const sugs = source === 'google_suggest'
        ? await fetchGoogleSuggest(node.keyword)
        : await fetchNaverSuggest(node.keyword)
      await sleep(SLEEP_MS)
      for (const s of sugs) {
        const norm = s.trim()
        if (!norm || visited.has(norm)) continue
        visited.add(norm)
        const child: Node = { keyword: norm, depth: d, parent: node.keyword }
        out.push(child)
        next.push(child)
        if (out.length >= MAX_NODES_PER_SEED) break
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return out
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const startedAt = Date.now()
  const admin = createAdminClient()

  // 시드: trends_products 상위 N개 (alias_count desc, last_seen_at desc)
  const { data: seedRows, error: seedErr } = await admin
    .from('jimscanner_trends_products')
    .select('id, canonical_name, alias_count, last_seen_at')
    .order('alias_count', { ascending: false })
    .order('last_seen_at', { ascending: false })
    .limit(SEED_LIMIT)

  if (seedErr) {
    return NextResponse.json({ error: seedErr.message }, { status: 500 })
  }
  const seeds = seedRows ?? []
  if (seeds.length === 0) {
    return NextResponse.json({ ok: true, seeds: 0, note: 'no trends_products yet' })
  }

  // 매칭용: 현재 trends_products canonical_name 목록 (소문자 비교)
  const { data: allProds } = await admin
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
  type Prod = { id: string; canonical_name: string }
  const products = (allProds ?? []) as Prod[]
  const nameToId = new Map<string, string>()
  for (const p of products) nameToId.set(p.canonical_name.toLowerCase().trim(), p.id)

  function findMapping(kw: string): string | null {
    const k = kw.toLowerCase().trim()
    if (nameToId.has(k)) return nameToId.get(k)!
    // 부분일치: trends_products canonical_name 이 확장키워드의 부분문자열이거나 그 역
    for (const [name, id] of nameToId) {
      if (name.length >= 2 && (k.includes(name) || name.includes(k))) return id
    }
    return null
  }

  const errors: { seed: string; reason: string }[] = []
  const allRows: {
    seed_keyword: string
    expanded_keyword: string
    depth: number
    parent_keyword: string | null
    source: Source
    est_volume: number | null
    mapped_product_id: string | null
    mapped_at: string
  }[] = []

  const now = new Date().toISOString()
  const sources: Source[] = ['google_suggest', 'naver_suggest']

  for (const seed of seeds) {
    for (const source of sources) {
      try {
        const nodes = await bfsExpand(seed.canonical_name, source)
        // depth=0 (seed 본인) 도 트리 루트 행으로 함께 저장
        for (const n of nodes) {
          const mapped = findMapping(n.keyword)
          // depth=0 의 est_volume 은 시드 alias_count 사용, 자식은 (FANOUT - 순위) / FANOUT 근사
          allRows.push({
            seed_keyword: seed.canonical_name,
            expanded_keyword: n.keyword,
            depth: n.depth,
            parent_keyword: n.parent,
            source,
            est_volume: n.depth === 0 ? Number(seed.alias_count ?? 0) : null,
            mapped_product_id: mapped,
            mapped_at: now,
          })
        }
      } catch (e) {
        errors.push({
          seed: `${seed.canonical_name}/${source}`,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  // upsert: 같은 (seed, expanded, source) 는 갱신
  let inserted = 0
  if (allRows.length > 0) {
    // jimscanner_keyword_expansion 은 신규 테이블 — 타입 재생성 전이라 캐스팅.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('jimscanner_keyword_expansion')
      .upsert(allRows, {
        onConflict: 'seed_keyword,expanded_keyword,source',
        ignoreDuplicates: false,
      })
      .select('id')
    if (error) {
      return NextResponse.json(
        { error: error.message, fetched: allRows.length, errors },
        { status: 500 },
      )
    }
    inserted = data?.length ?? 0
  }

  const gaps = allRows.filter((r) => r.mapped_product_id === null).length

  return NextResponse.json({
    ok: true,
    seeds: seeds.length,
    fetched: allRows.length,
    inserted,
    gap_candidates: gaps,
    duration_ms: Date.now() - startedAt,
    errors,
    executed_at: now,
  })
}
