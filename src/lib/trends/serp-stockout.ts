import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * 네이버 쇼핑 SERP 를 키워드 단위로 스냅샷 → 카드 중 품절/예약판매/재입고알림 비율을 계량화.
 * 가벼운 HTML 파싱 (정규식 기반) — DOM lib 무의존.
 *
 * cron 단일 실행으로 끝나야 하므로 키워드 수는 시드 테이블에서 가져오며,
 * 시드가 없을 땐 jimscanner_trends_products 의 최근 canonical_name 일부를 사용.
 */

type Seed = {
  product_id: string | null
  keyword: string
}

type CardCounts = {
  total_cards: number
  oos_count: number
  presale_count: number
  restock_alert_count: number
  sample_titles: string[]
}

const OOS_PATTERNS = [/품절/, /일시품절/, /sold\s*out/i]
const PRESALE_PATTERNS = [/예약\s*판매/, /예약구매/, /pre[-\s]?order/i]
const RESTOCK_PATTERNS = [/재입고\s*알림/, /입고\s*알림/, /restock/i]

const NAVER_SHOPPING_BASE =
  'https://search.shopping.naver.com/search/all?query='

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 네이버 쇼핑 SERP HTML 에서 카드 라벨 카운트 산출.
 * SSR/CSR 양쪽 모두 대응하기 위해 raw text 에서 정규식만 사용.
 * 카드 총 개수 추정: <li ... class="...basicList_item..."> 또는 product_item / productItem 패턴.
 */
export function parseStockoutCounts(html: string): CardCounts {
  // 카드 토큰화: 보편적 셀러 카드 컨테이너 패턴들. 어떤 패턴이라도 잡히면 OK.
  const cardRegexes = [
    /<li[^>]+class="[^"]*basicList_item[^"]*"[\s\S]*?<\/li>/g,
    /<li[^>]+class="[^"]*product_item[^"]*"[\s\S]*?<\/li>/g,
    /<div[^>]+class="[^"]*productItem[^"]*"[\s\S]*?<\/div>/g,
  ]

  let cards: string[] = []
  for (const r of cardRegexes) {
    const m = html.match(r)
    if (m && m.length > cards.length) cards = m
  }

  // fallback: SERP 가 모두 JSON 으로 인라인되어 있는 경우 — title 추출만 시도.
  if (cards.length === 0) {
    const titleMatches = html.match(/"productTitle"\s*:\s*"([^"]{2,160})"/g) || []
    cards = titleMatches.slice(0, 80) // 임시 카드 토큰
  }

  let oos = 0
  let presale = 0
  let restock = 0
  const sampleTitles: string[] = []

  for (const card of cards) {
    const matchOos = OOS_PATTERNS.some((p) => p.test(card))
    const matchPresale = PRESALE_PATTERNS.some((p) => p.test(card))
    const matchRestock = RESTOCK_PATTERNS.some((p) => p.test(card))

    if (matchOos) oos++
    if (matchPresale) presale++
    if (matchRestock) restock++

    if (sampleTitles.length < 5) {
      const t =
        card.match(/title="([^"]{2,120})"/)?.[1] ??
        card.match(/>([^<]{4,80})<\/a>/)?.[1]
      if (t) sampleTitles.push(t.trim())
    }
  }

  return {
    total_cards: cards.length,
    oos_count: oos,
    presale_count: presale,
    restock_alert_count: restock,
    sample_titles: sampleTitles,
  }
}

async function fetchSerpHtml(keyword: string): Promise<string> {
  const url = NAVER_SHOPPING_BASE + encodeURIComponent(keyword)
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.5,en;q=0.3',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`naver SERP HTTP ${res.status} for "${keyword}"`)
  }
  return await res.text()
}

/**
 * 시드 키워드 산출:
 *  1) jimscanner_trends_seeds (source='serp_stockout', kind='keyword') 가 우선
 *  2) 없으면 최근 7일간 jimscanner_trends_keywords 의 unique keyword 중 상위 N개를 자동 picks
 *  3) 그래도 비면 빈 배열
 */
async function pickSeeds(admin: SupabaseClient, limit: number): Promise<Seed[]> {
  const { data: seeds } = await admin
    .from('jimscanner_trends_seeds')
    .select('label, config')
    .eq('source', 'serp_stockout')
    .eq('is_active', true)
    .order('display_order')
    .limit(limit)

  type S = { label: string; config: { keyword?: string; product_id?: string } }
  const seedRows = (seeds ?? []) as S[]
  if (seedRows.length > 0) {
    return seedRows
      .map((s) => ({
        keyword: s.config?.keyword ?? s.label,
        product_id: s.config?.product_id ?? null,
      }))
      .filter((s) => s.keyword)
      .slice(0, limit)
  }

  // fallback: 최근 keyword pool 에서 unique top N
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { data: recent } = await admin
    .from('jimscanner_trends_keywords')
    .select('keyword')
    .gte('collected_at', since)
    .limit(500)
  type K = { keyword: string }
  const recentRows = (recent ?? []) as K[]
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const r of recentRows) {
    const kw = (r.keyword ?? '').trim()
    if (!kw || seen.has(kw)) continue
    if (kw.length < 2 || kw.length > 30) continue
    seen.add(kw)
    uniq.push(kw)
    if (uniq.length >= limit) break
  }
  return uniq.map((keyword) => ({ keyword, product_id: null }))
}

export type StockoutRunSummary = {
  source: 'serp_stockout'
  fetched: number
  inserted: number
  durationMs: number
  status: 'ok' | 'partial' | 'error'
  error?: string
  keywords?: string[]
}

const MAX_KEYWORDS = 20

export async function collectSerpStockoutSnapshots(
  admin: SupabaseClient,
  triggeredBy: string,
): Promise<StockoutRunSummary> {
  const startedAt = Date.now()
  const source = 'serp_stockout' as const

  let seeds: Seed[] = []
  try {
    seeds = await pickSeeds(admin, MAX_KEYWORDS)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await logRun(admin, source, triggeredBy, startedAt, {
      fetched: 0,
      inserted: 0,
      status: 'error',
      error,
    })
    return {
      source,
      fetched: 0,
      inserted: 0,
      status: 'error',
      durationMs: Date.now() - startedAt,
      error,
    }
  }

  if (seeds.length === 0) {
    const summary = {
      fetched: 0,
      inserted: 0,
      status: 'partial' as const,
      error: 'no seeds available',
    }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt, keywords: [] }
  }

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined
  const usedKeywords: string[] = []

  for (const seed of seeds) {
    try {
      const html = await fetchSerpHtml(seed.keyword)
      fetched++
      const counts = parseStockoutCounts(html)

      const row = {
        product_id: seed.product_id,
        keyword: seed.keyword,
        total_cards: counts.total_cards,
        oos_count: counts.oos_count,
        presale_count: counts.presale_count,
        restock_alert_count: counts.restock_alert_count,
        metadata: {
          sample_titles: counts.sample_titles,
          fetch_url: NAVER_SHOPPING_BASE + encodeURIComponent(seed.keyword),
        },
      }
      const { error } = await admin
        .from('jimscanner_serp_stockout_snapshots')
        .insert(row)
      if (error) {
        lastErr = error.message
      } else {
        inserted++
        usedKeywords.push(seed.keyword)
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    // 폭주 방지를 위해 짧은 backoff (네이버 차단 회피)
    await new Promise((r) => setTimeout(r, 800))
  }

  const status: StockoutRunSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'

  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  return {
    ...summary,
    source,
    durationMs: Date.now() - startedAt,
    keywords: usedKeywords,
  }
}

async function logRun(
  admin: SupabaseClient,
  source: string,
  triggeredBy: string,
  startedAt: number,
  s: { fetched: number; inserted: number; status: 'ok' | 'partial' | 'error'; error?: string },
) {
  const finishedAt = Date.now()
  await admin.from('jimscanner_trends_runs').insert({
    source,
    status: s.status,
    fetched_count: s.fetched,
    inserted_count: s.inserted,
    duration_ms: finishedAt - startedAt,
    error_message: s.error ?? null,
    triggered_by: triggeredBy,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
  })
}
