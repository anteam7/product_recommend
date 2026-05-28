import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────
// Co-Search Bundle Network — 동시검색 키워드 쌍 lift/PMI 계산
//
// 입력:
//   1) jimscanner_market_raw  (source ∈ {naver_news, naver_blog, quasarzone_sale})
//      → 각 row 의 title + metadata.description 이 한 "문서" — 토큰 bag.
//   2) jimscanner_trends_keywords  (source = 'naver_search_trend')
//      → 같은 collected_at 분 단위 버킷에 있는 키워드들이 한 "세션".
//
// 출력:
//   jimscanner_trends_cooccurrence (a_keyword, b_keyword, source, window_days,
//                                   joint_count, marginal_a, marginal_b, total_docs,
//                                   lift, pmi, extras, computed_at)
//   lift ≥ 1.2 인 쌍만 적재 (노이즈 컷). 더 자세한 필터링은 UI 에서.
// ─────────────────────────────────────────────────────────────

const WINDOW_DAYS = 28
const MIN_TOKEN_LEN = 2
const MAX_TOKENS_PER_DOC = 16
const MIN_JOINT_COUNT = 3
const MIN_LIFT = 1.2
const MAX_PAIRS_PER_SOURCE = 4000

// 한국어 매우 흔한 불용어 — 의미가 거의 없는 토큰.
const STOPWORDS = new Set([
  '오늘', '어제', '내일', '이번', '지금', '최신', '최근', '관련', '소식', '발표',
  '진행', '시작', '종료', '예정', '확인', '안내', '공지', '리뷰', '구매', '판매',
  '제품', '상품', '가격', '할인', '특가', '세일', 'sale', '쇼핑', '추천',
  '뉴스', 'news', 'blog', '블로그', '카페', '게시판', '커뮤니티',
  '한국', '중국', '미국', '일본', '해외', '국내', '서울', '부산',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'http', 'https', 'www', 'com',
  '직구', '배송', '구매대행', '배송대행', '관세', '환율',  // 도메인 자체 키워드
])

const RE_KOR_OR_ENG = /[가-힣]{2,}|[a-zA-Z]{3,}/g

function tokenize(text: string | null | undefined): string[] {
  if (!text) return []
  const cleaned = text.replace(/<[^>]+>/g, ' ').toLowerCase()
  const matches = cleaned.match(RE_KOR_OR_ENG) ?? []
  const uniq = new Set<string>()
  for (const m of matches) {
    if (m.length < MIN_TOKEN_LEN) continue
    if (STOPWORDS.has(m)) continue
    if (/^\d+$/.test(m)) continue
    uniq.add(m)
    if (uniq.size >= MAX_TOKENS_PER_DOC) break
  }
  return Array.from(uniq)
}

interface PairAccumulator {
  joint: Map<string, number>        // "a||b" → count (a < b)
  marginal: Map<string, number>     // token → count
  totalDocs: number
  sampleTitles: Map<string, string[]>  // "a||b" → up to 3 sample titles
}

function newAcc(): PairAccumulator {
  return {
    joint: new Map(),
    marginal: new Map(),
    totalDocs: 0,
    sampleTitles: new Map(),
  }
}

function ingestDoc(acc: PairAccumulator, tokens: string[], title?: string) {
  const sorted = Array.from(new Set(tokens)).sort()
  if (sorted.length < 2) return
  acc.totalDocs += 1
  for (const t of sorted) {
    acc.marginal.set(t, (acc.marginal.get(t) ?? 0) + 1)
  }
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      const key = `${a}||${b}`
      acc.joint.set(key, (acc.joint.get(key) ?? 0) + 1)
      if (title) {
        const arr = acc.sampleTitles.get(key) ?? []
        if (arr.length < 3 && !arr.includes(title)) {
          arr.push(title)
          acc.sampleTitles.set(key, arr)
        }
      }
    }
  }
}

interface CooccRow {
  a_keyword: string
  b_keyword: string
  source: string
  window_days: number
  joint_count: number
  marginal_a: number
  marginal_b: number
  total_docs: number
  lift: number
  pmi: number | null
  extras: Record<string, unknown>
}

function buildRowsForSource(acc: PairAccumulator, source: string): CooccRow[] {
  const rows: CooccRow[] = []
  if (acc.totalDocs < 5) return rows
  const N = acc.totalDocs
  for (const [key, joint] of acc.joint.entries()) {
    if (joint < MIN_JOINT_COUNT) continue
    const [a, b] = key.split('||')
    const ma = acc.marginal.get(a) ?? 0
    const mb = acc.marginal.get(b) ?? 0
    if (ma === 0 || mb === 0) continue
    const pa = ma / N
    const pb = mb / N
    const pab = joint / N
    const lift = pab / (pa * pb)
    if (lift < MIN_LIFT) continue
    const pmi = lift > 0 ? Math.log2(lift) : null
    const sample = acc.sampleTitles.get(key) ?? []
    rows.push({
      a_keyword: a,
      b_keyword: b,
      source,
      window_days: WINDOW_DAYS,
      joint_count: joint,
      marginal_a: ma,
      marginal_b: mb,
      total_docs: N,
      lift: Math.round(lift * 1000) / 1000,
      pmi: pmi == null ? null : Math.round(pmi * 1000) / 1000,
      extras: sample.length ? { sample_titles: sample } : {},
    })
  }
  rows.sort((x, y) => y.lift - x.lift || y.joint_count - x.joint_count)
  return rows.slice(0, MAX_PAIRS_PER_SOURCE)
}

interface MarketRawRow {
  source: string
  title: string | null
  metadata: { description?: string } | null
}

interface TrendKeywordRow {
  keyword: string
  source: string
  collected_at: string
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const t0 = Date.now()
  const admin = createAdminClient()
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

  const stats = {
    fetched: { market_raw: 0, trends_keywords: 0 },
    rowsPerSource: {} as Record<string, number>,
    inserted: 0,
    errors: [] as string[],
    ms: 0,
  }

  // ── 1) market_raw 문서 기반 (naver_news / naver_blog / quasarzone_sale)
  const docSources = ['naver_news', 'naver_blog', 'quasarzone_sale']
  const accBySource = new Map<string, PairAccumulator>()
  for (const s of docSources) accBySource.set(s, newAcc())
  const accAll = newAcc()

  try {
    // raw 양이 많을 수 있으므로 페이지네이션
    const PAGE = 1000
    let from = 0
    while (true) {
      const { data, error } = await admin
        .from('jimscanner_market_raw')
        .select('source, title, metadata')
        .in('source', docSources)
        .gte('captured_at', since)
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`market_raw fetch: ${error.message}`)
      const rows = (data ?? []) as MarketRawRow[]
      if (rows.length === 0) break
      stats.fetched.market_raw += rows.length
      for (const r of rows) {
        const desc =
          r.metadata && typeof r.metadata === 'object' && 'description' in r.metadata
            ? String((r.metadata as { description?: unknown }).description ?? '')
            : ''
        const text = `${r.title ?? ''} ${desc}`
        const tokens = tokenize(text)
        if (tokens.length < 2) continue
        const acc = accBySource.get(r.source)
        if (acc) ingestDoc(acc, tokens, r.title ?? undefined)
        ingestDoc(accAll, tokens, r.title ?? undefined)
      }
      if (rows.length < PAGE) break
      from += PAGE
      if (from > 50_000) break // safety
    }
  } catch (e) {
    stats.errors.push(e instanceof Error ? e.message : String(e))
  }

  // ── 2) naver_search_trend 키워드 — 같은 collected_at 분 버킷이 한 세션.
  try {
    const { data, error } = await admin
      .from('jimscanner_trends_keywords')
      .select('keyword, source, collected_at')
      .eq('source', 'naver_search_trend')
      .gte('collected_at', since)
      .limit(20000)
    if (error) throw new Error(`trends_keywords fetch: ${error.message}`)
    const rows = (data ?? []) as TrendKeywordRow[]
    stats.fetched.trends_keywords = rows.length
    const buckets = new Map<string, Set<string>>()
    for (const r of rows) {
      const bucket = r.collected_at.slice(0, 16) // 분 단위
      const s = buckets.get(bucket) ?? new Set()
      s.add(r.keyword.toLowerCase().trim())
      buckets.set(bucket, s)
    }
    const accNST = newAcc()
    for (const [, set] of buckets) {
      const tokens = Array.from(set).filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t))
      if (tokens.length < 2) continue
      ingestDoc(accNST, tokens)
      ingestDoc(accAll, tokens)
    }
    accBySource.set('naver_search_trend', accNST)
  } catch (e) {
    stats.errors.push(e instanceof Error ? e.message : String(e))
  }
  accBySource.set('all', accAll)

  // ── 3) upsert 결과
  const allRows: CooccRow[] = []
  for (const [src, acc] of accBySource.entries()) {
    const rows = buildRowsForSource(acc, src)
    stats.rowsPerSource[src] = rows.length
    allRows.push(...rows)
  }

  if (allRows.length > 0) {
    // 배치 upsert (1000 건씩)
    const BATCH = 1000
    for (let i = 0; i < allRows.length; i += BATCH) {
      const batch = allRows.slice(i, i + BATCH)
      const { error } = await admin
        .from('jimscanner_trends_cooccurrence' as never)
        .upsert(batch as never, {
          onConflict: 'a_keyword,b_keyword,source,window_days',
        })
      if (error) {
        stats.errors.push(`upsert batch ${i}: ${error.message}`)
      } else {
        stats.inserted += batch.length
      }
    }
  }

  stats.ms = Date.now() - t0
  return NextResponse.json({
    ok: stats.errors.length === 0,
    window_days: WINDOW_DAYS,
    ...stats,
  })
}
