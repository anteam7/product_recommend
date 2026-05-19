import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 모방 클리프 추적기 cron — 핀/listed 상품 SERP 카피캣 일일 관측.
 * - 대상: jimscanner_trends_pins 의 keyword (배치 ~50)
 * - SERP 소스: Naver Shopping Search API (openapi.naver.com/v1/search/shop.json)
 *   키 미설정 시: stub_count=0 으로 row 만 기록 (스키마 살아있게).
 * - 적재: jimscanner_trends_imitation_track (unique(product_id, observed_date, serp_source))
 *   같은 날 2회 호출되어도 ON CONFLICT 로 upsert.
 *
 * canonical_product 매핑은 alias(keyword) → product_id 로 단순 lookup. 매핑 없으면 skip.
 */

type ShopItem = {
  title?: string
  link?: string
  productId?: string
  mallName?: string
  lprice?: string
  hprice?: string
}

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()
}

async function searchNaverShop(query: string): Promise<{ items: ShopItem[]; total: number } | null> {
  const id = process.env.NAVER_OPENAPI_CLIENT_ID
  const secret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !secret) return null
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=40&sort=sim`
  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
  })
  if (!res.ok) throw new Error(`naver shop ${res.status}`)
  const json = (await res.json()) as { total?: number; items?: ShopItem[] }
  return { items: json.items ?? [], total: json.total ?? 0 }
}

function medianPrice(items: ShopItem[]): number | null {
  const prices = items
    .map((i) => Number(i.lprice ?? ''))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  if (prices.length === 0) return null
  const mid = Math.floor(prices.length / 2)
  if (prices.length % 2 === 0) return Math.round((prices[mid - 1] + prices[mid]) / 2)
  return prices[mid]
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  // 1) 핀 키워드 (limit 50)
  const { data: pinsData, error: pinsErr } = await admin
    .from('jimscanner_trends_pins')
    .select('keyword, source, pinned_at')
    .order('pinned_at', { ascending: false })
    .limit(50)
  if (pinsErr) {
    return NextResponse.json({ error: pinsErr.message }, { status: 500 })
  }
  const pins = pinsData ?? []

  // 2) alias → product_id 매핑 lookup
  const keywords = pins.map((p) => p.keyword).filter(Boolean)
  const aliasMap = new Map<string, string>() // keyword -> product_id
  if (keywords.length > 0) {
    const { data: aliasRows } = await admin
      .from('jimscanner_trends_aliases')
      .select('alias, product_id')
      .in('alias', keywords)
    for (const a of aliasRows ?? []) {
      if (a.alias && a.product_id) aliasMap.set(a.alias, a.product_id)
    }
  }

  const today = new Date()
  const observedDateKst = new Date(today.getTime() + 9 * 3600_000).toISOString().slice(0, 10)
  const observedAtIso = today.toISOString()
  const serpSource = 'naver_shopping_search'

  const errors: { keyword: string; reason: string }[] = []
  let tracked = 0
  let stubbed = 0

  for (const pin of pins) {
    const productId = aliasMap.get(pin.keyword)
    if (!productId) {
      // canonical product 매핑 없으면 skip — 추후 LLM 매핑 후 자동 포함
      continue
    }

    let serpCount = 0
    let titles: string[] = []
    let topSellers: string[] = []
    let median: number | null = null
    let raw: Record<string, unknown> | null = null

    try {
      const result = await searchNaverShop(pin.keyword)
      if (result === null) {
        stubbed++
      } else {
        serpCount = Math.min(result.total, 9999)
        titles = result.items.slice(0, 5).map((i) => stripTags(i.title))
        topSellers = Array.from(
          new Set(result.items.slice(0, 10).map((i) => i.mallName ?? '').filter(Boolean)),
        )
        median = medianPrice(result.items)
        raw = { total: result.total, sample_n: result.items.length }
      }
    } catch (e) {
      errors.push({ keyword: pin.keyword, reason: e instanceof Error ? e.message : String(e) })
      continue
    }

    // 직전(어제) row 가져와서 new_listings_24h 계산
    const { data: prevRows } = await admin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('jimscanner_trends_imitation_track' as any)
      .select('serp_listing_count, observed_at')
      .eq('product_id', productId)
      .eq('serp_source', serpSource)
      .lt('observed_date', observedDateKst)
      .order('observed_at', { ascending: false })
      .limit(1)
    const prevCount =
      prevRows && prevRows.length > 0
        ? (prevRows[0] as unknown as { serp_listing_count: number }).serp_listing_count
        : 0
    const newListings = Math.max(0, serpCount - prevCount)

    const row = {
      product_id: productId,
      observed_at: observedAtIso,
      observed_date: observedDateKst,
      serp_listing_count: serpCount,
      new_listings_24h: newListings,
      top_seller_ids: topSellers,
      median_price_krw: median,
      sample_titles: titles,
      serp_source: serpSource,
      query: pin.keyword,
      raw_payload: raw,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const { error: upErr } = await admin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('jimscanner_trends_imitation_track' as any)
      .upsert(row, { onConflict: 'product_id,observed_date,serp_source' })
    if (upErr) {
      errors.push({ keyword: pin.keyword, reason: upErr.message })
      continue
    }
    tracked++
  }

  return NextResponse.json({
    ok: true,
    pins: pins.length,
    mapped: aliasMap.size,
    tracked,
    stubbed,
    errors,
    executed_at: observedAtIso,
  })
}
