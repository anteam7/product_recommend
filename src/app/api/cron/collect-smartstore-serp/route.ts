/**
 * Smartstore SERP SKU 수집기 — 주 1~2회 cron.
 *
 * 각 canonical product 의 대표 검색어 (canonical_name) 로
 * search.shopping.naver.com SERP top 10 SKU 의 review_count / rating / price 를 수집해
 * jimscanner_serp_skus 에 적재. WoW review 델타 합산이 "실판매 속도 proxy".
 *
 * 운영 의도: Vercel Hobby cron 한도(2개) 때문에 scripts/run-crons.mjs 로 호출.
 *
 * 적재 테이블:
 *  - jimscanner_serp_skus
 *  - jimscanner_trends_runs (감사 로그)
 */
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SOURCE = 'smartstore_serp'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
const PER_PRODUCT_TOP_N = 10
const MAX_PRODUCTS_PER_RUN = 80
const SLEEP_MS = 600

type SkuRow = {
  product_id: string
  query: string
  rank: number
  sku_url: string
  sku_id: string | null
  seller: string | null
  title: string | null
  price: number | null
  review_count: number | null
  rating: number | null
}

interface RawSkuItem {
  productId?: string | number
  productTitle?: string
  reviewCount?: number
  reviewScoreAvg?: number
  rating?: number
  mallName?: string
  mallProductUrl?: string
  crUrl?: string
  productUrl?: string
  price?: number | string
  lowPrice?: number | string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function asInt(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : Number(v)
  return Number.isFinite(n) ? Math.round(n) : null
}

function asFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? Number(v) : Number(v)
  return Number.isFinite(n) ? n : null
}

function cleanText(s: string | undefined | null): string | null {
  if (!s) return null
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 250)
}

/**
 * 네이버 쇼핑 SERP HTML 에는 `__NEXT_DATA__` JSON 이 포함된다.
 * 그 안 productList → products 배열에서 필요한 필드만 추출.
 * 페이지 구조가 바뀌면 fallback regex 로 reviewCount/price 만 뽑는다.
 */
function extractFromNextData(html: string): RawSkuItem[] {
  const idx = html.indexOf('__NEXT_DATA__')
  if (idx < 0) return []
  const startTag = html.indexOf('>', idx)
  if (startTag < 0) return []
  const end = html.indexOf('</script>', startTag)
  if (end < 0) return []
  const jsonStr = html.slice(startTag + 1, end).trim()
  let data: unknown
  try {
    data = JSON.parse(jsonStr)
  } catch {
    return []
  }
  const out: RawSkuItem[] = []
  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 10) return
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (typeof obj.productTitle === 'string' && (obj.reviewCount !== undefined || obj.lowPrice !== undefined || obj.price !== undefined)) {
      out.push(obj as RawSkuItem)
    }
    for (const k of Object.keys(obj)) walk(obj[k], depth + 1)
  }
  walk(data, 0)
  // dedupe by productId/url
  const seen = new Set<string>()
  const unique: RawSkuItem[] = []
  for (const it of out) {
    const key = String(it.productId ?? it.mallProductUrl ?? it.crUrl ?? it.productTitle)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(it)
  }
  return unique
}

async function fetchSerp(query: string): Promise<RawSkuItem[]> {
  const url =
    'https://search.shopping.naver.com/search/all?' +
    new URLSearchParams({ query, frm: 'NVSCPRO', sort: 'rel' }).toString()
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://search.shopping.naver.com/',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  return extractFromNextData(html)
}

function toRow(
  productId: string,
  query: string,
  rank: number,
  raw: RawSkuItem,
): SkuRow | null {
  const url =
    typeof raw.crUrl === 'string'
      ? raw.crUrl
      : typeof raw.mallProductUrl === 'string'
        ? raw.mallProductUrl
        : typeof raw.productUrl === 'string'
          ? raw.productUrl
          : null
  if (!url) return null
  return {
    product_id: productId,
    query,
    rank,
    sku_url: url,
    sku_id: raw.productId !== undefined ? String(raw.productId) : null,
    seller: cleanText(raw.mallName),
    title: cleanText(raw.productTitle),
    price: asInt(raw.lowPrice ?? raw.price),
    review_count: asInt(raw.reviewCount),
    rating: asFloat(raw.reviewScoreAvg ?? raw.rating),
  }
}

async function recordRun(opts: {
  status: 'ok' | 'partial' | 'error'
  fetched: number
  inserted: number
  durationMs: number
  startedAt: number
  errorMessage?: string
  triggeredBy: string
}) {
  const sb = createAdminClient()
  await sb.from('jimscanner_trends_runs').insert({
    source: SOURCE,
    status: opts.status,
    fetched_count: opts.fetched,
    inserted_count: opts.inserted,
    duration_ms: opts.durationMs,
    error_message: opts.errorMessage ?? null,
    triggered_by: opts.triggeredBy,
    started_at: new Date(opts.startedAt).toISOString(),
    finished_at: new Date().toISOString(),
  })
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const t0 = Date.now()
  const triggeredBy =
    request.headers.get('user-agent')?.toLowerCase().includes('vercel') ? 'vercel_cron' : 'cli'

  const sb = createAdminClient()
  // canonical product 우선순위: 최근 봤거나 LLM 분류된 것 위주.
  const { data: products, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select('id, canonical_name, last_seen_at, llm_classified_at' as any)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_PRODUCTS_PER_RUN)
  if (prodErr) {
    await recordRun({
      status: 'error',
      fetched: 0,
      inserted: 0,
      durationMs: Date.now() - t0,
      startedAt: t0,
      errorMessage: `product fetch: ${prodErr.message}`,
      triggeredBy,
    }).catch(() => {})
    return NextResponse.json({ ok: false, error: prodErr.message }, { status: 500 })
  }

  const productList = ((products ?? []) as unknown) as Array<{ id: string; canonical_name: string }>
  let fetched = 0
  let inserted = 0
  const errors: { product_id: string; query: string; reason: string }[] = []

  for (const p of productList) {
    const query = (p.canonical_name ?? '').trim()
    if (!query || query.length < 2) continue
    try {
      const items = await fetchSerp(query)
      const rows: SkuRow[] = []
      let rank = 0
      for (const raw of items) {
        if (rank >= PER_PRODUCT_TOP_N) break
        const row = toRow(p.id, query, rank + 1, raw)
        if (!row) continue
        // review_count 가 한 번도 안 잡힌 SKU 는 적재 가치 낮음
        if (row.review_count === null && row.rating === null) continue
        rows.push(row)
        rank++
      }
      fetched += rows.length
      if (rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: insErr } = await (sb.from('jimscanner_serp_skus' as any) as any).insert(rows)
        if (insErr) {
          errors.push({ product_id: p.id, query, reason: `insert: ${insErr.message}` })
        } else {
          inserted += rows.length
        }
      }
    } catch (e) {
      errors.push({
        product_id: p.id,
        query,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
    await sleep(SLEEP_MS)
  }

  const status: 'ok' | 'partial' | 'error' =
    errors.length === 0 ? 'ok' : inserted > 0 ? 'partial' : 'error'
  const errMsg = errors.length > 0 ? errors.slice(0, 5).map((e) => `${e.query}: ${e.reason}`).join(' | ') : undefined
  await recordRun({
    status,
    fetched,
    inserted,
    durationMs: Date.now() - t0,
    startedAt: t0,
    errorMessage: errMsg,
    triggeredBy,
  }).catch(() => {})

  return NextResponse.json({
    ok: status !== 'error',
    products: productList.length,
    fetched,
    inserted,
    errors: errors.slice(0, 20),
    duration_ms: Date.now() - t0,
  })
}
