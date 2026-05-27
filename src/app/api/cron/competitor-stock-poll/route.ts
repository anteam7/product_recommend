/**
 * 경쟁사 Top-N 동시 품절 Cascade 감지 (cron: 2시간 1회)
 *
 * 흐름:
 *   1) jimscanner_cascade_categories (active=true) 가져옴
 *   2) 카테고리별 쿠팡 SERP HTML fetch → Top-N 상품 파싱
 *   3) 각 상품 vp/products/{id} fetch → 재고 상태 추출 (in_stock/sold_out/preorder/delayed)
 *   4) snapshot 적재
 *   5) Top-3 중 2개 이상 OOS → cascade_event open
 *      이전 active event 가 있는데 Top-3 중 2개 이상 in_stock → close
 *   6) open 시 자사 발행 SKU 매칭 (jimscanner_coupang_listings.display_category_name LIKE)
 *      + jimscanner_trends_products (category_top match) 매칭 결과 캐시
 *
 * 비고: SERP 파싱은 best-effort. SERP 차단 시 unknown 처리 후 skip.
 *       전체 Top-N 상세 페이지를 받는 비용이 크므로 카테고리당 최대 N=10 으로 제한.
 *
 * 인증: CRON_SECRET (Authorization: Bearer ...)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

type StockStatus = 'in_stock' | 'sold_out' | 'preorder' | 'delayed' | 'unknown'

interface CategoryRow {
  category_key: string
  category_label: string
  category_top: string | null
  serp_keyword: string
  top_n: number
}

interface SerpItem {
  product_id: string
  product_url: string
  product_title: string
  serp_rank: number
  price_krw: number | null
}

interface ProductStock {
  status: StockStatus
  delivery_eta_days: number | null
  vendor_id: string | null
  seller_name: string | null
}

async function fetchSerp(keyword: string, topN: number): Promise<SerpItem[]> {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}&listSize=${topN}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) return []
  const html = await res.text()
  return parseSerpHtml(html, topN)
}

function parseSerpHtml(html: string, topN: number): SerpItem[] {
  const items: SerpItem[] = []
  const seen = new Set<string>()
  // 쿠팡 SERP 는 li 안에 a[href^="/vp/products/{id}"] 가 있고 같은 li 안에
  // .name 또는 strong.name + .price-value 가 들어가는 패턴.
  // best-effort 정규식: 상품 링크 1차 추출 → 같은 블록에서 제목/가격 보강.
  const linkRe = /<a[^>]+href="(\/vp\/products\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  let rank = 0
  while ((m = linkRe.exec(html))) {
    const [, hrefRaw, id, inner] = m
    if (seen.has(id)) continue
    seen.add(id)
    rank++
    const titleM = /(?:class="name"[^>]*>|<dd[^>]*class="[^"]*name[^"]*"[^>]*>)([\s\S]*?)<\/(?:div|dd)>/i.exec(inner)
    const titleAlt = /alt="([^"]+)"/i.exec(inner)
    const priceM = /class="price-value"[^>]*>([\d,]+)/i.exec(inner)
    const title =
      (titleM?.[1] ?? titleAlt?.[1] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim() || `product ${id}`
    items.push({
      product_id: id,
      product_url: `https://www.coupang.com${hrefRaw.split('?')[0]}`,
      product_title: title,
      serp_rank: rank,
      price_krw: priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : null,
    })
    if (items.length >= topN) break
  }
  return items
}

async function fetchProductStock(productId: string): Promise<ProductStock> {
  try {
    const res = await fetch(`https://www.coupang.com/vp/products/${productId}`, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!res.ok) return { status: 'unknown', delivery_eta_days: null, vendor_id: null, seller_name: null }
    const html = await res.text().then((s) => s.slice(0, 80_000))
    return parseProductHtml(html)
  } catch {
    return { status: 'unknown', delivery_eta_days: null, vendor_id: null, seller_name: null }
  }
}

function parseProductHtml(html: string): ProductStock {
  const lower = html
  const soldOut = /품절\s*상품|일시\s*품절|판매\s*중지|이\s*상품은\s*품절/.test(lower)
  const preorder = /예약\s*판매|예약\s*발송|예약상품/.test(lower)
  // 도착 예정: "X일 이내 도착" / "내일(...) 도착" / "X월 X일 도착"
  const etaM = /(\d+)\s*일\s*(?:이내|후)\s*(?:도착|배송)/.exec(lower)
  let delayed = false
  let eta: number | null = null
  if (etaM) {
    eta = parseInt(etaM[1], 10)
    if (eta >= 3) delayed = true
  }
  const vendorM = /vendorId["']?\s*[:=]\s*["']?([A-Z0-9]+)/.exec(lower)
  const sellerM = /vendorName["']?\s*[:=]\s*["']?([^"',}]+)/.exec(lower)

  let status: StockStatus = 'in_stock'
  if (soldOut) status = 'sold_out'
  else if (preorder) status = 'preorder'
  else if (delayed) status = 'delayed'

  // in_stock 확신을 위해 가격/카트 마커가 없으면 unknown 으로 downgrade
  if (status === 'in_stock' && !/장바구니|바로구매|prod-buy-header|prod-price/.test(lower)) {
    status = 'unknown'
  }
  return {
    status,
    delivery_eta_days: eta,
    vendor_id: vendorM?.[1] ?? null,
    seller_name: sellerM?.[1]?.trim() ?? null,
  }
}

function isOosLike(s: StockStatus) {
  return s === 'sold_out' || s === 'preorder' || s === 'delayed'
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 신규 테이블 — generated types 갱신 전까지 any 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  const startedAt = Date.now()
  const { data: runRow } = await sb
    .from('jimscanner_cascade_poll_runs')
    .insert({ status: 'running', triggered_by: 'cron' })
    .select('id')
    .single() as { data: { id: string } | null }
  const runId = runRow?.id

  let snapshotsInserted = 0
  let eventsOpened = 0
  let eventsClosed = 0

  try {
    const { data: catsData } = await sb
      .from('jimscanner_cascade_categories')
      .select('category_key, category_label, category_top, serp_keyword, top_n')
      .eq('active', true)
    const cats = (catsData ?? []) as CategoryRow[]

    for (const cat of cats) {
      const items = await fetchSerp(cat.serp_keyword, cat.top_n)
      if (items.length === 0) {
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
      // 상세 페이지로 재고 확인 (rate-limit: 600ms)
      const enriched: Array<SerpItem & ProductStock> = []
      for (const it of items) {
        const stock = await fetchProductStock(it.product_id)
        enriched.push({ ...it, ...stock })
        await new Promise((r) => setTimeout(r, 600))
      }
      // 스냅샷 적재
      const observedAt = new Date().toISOString()
      const snapshotRows = enriched.map((e) => ({
        category_key: cat.category_key,
        serp_rank: e.serp_rank,
        product_id: e.product_id,
        product_url: e.product_url,
        product_title: e.product_title,
        vendor_id: e.vendor_id,
        seller_name: e.seller_name,
        price_krw: e.price_krw,
        stock_status: e.status,
        delivery_eta_days: e.delivery_eta_days,
        observed_at: observedAt,
        raw: { eta_days: e.delivery_eta_days },
      }))
      await sb.from('jimscanner_competitor_stock_snapshot').insert(snapshotRows)
      snapshotsInserted += snapshotRows.length

      // Cascade 판정: Top-3 중 OOS-like 가 2개 이상
      const top3 = enriched.slice(0, 3)
      const oosTop3 = top3.filter((e) => isOosLike(e.status))
      const inStockTop3 = top3.filter((e) => e.status === 'in_stock')
      const knownTop3 = top3.filter((e) => e.status !== 'unknown')

      // 활성 이벤트 조회
      const { data: activeEvents } = await sb
        .from('jimscanner_cascade_events')
        .select('id, started_at, affected_product_ids')
        .eq('category_key', cat.category_key)
        .eq('is_active', true)
        .order('started_at', { ascending: false })
        .limit(1) as { data: Array<{ id: string; started_at: string; affected_product_ids: string[] }> | null }
      const active = activeEvents?.[0] ?? null

      if (oosTop3.length >= 2 && !active && knownTop3.length >= 2) {
        // 신규 이벤트 open
        const etas = enriched
          .filter((e) => e.delivery_eta_days != null)
          .map((e) => e.delivery_eta_days as number)
        const avgEtaDays = etas.length > 0 ? Math.round(etas.reduce((a, b) => a + b, 0) / etas.length) : 2
        const recommendedBoostMinutes = Math.max(60, Math.min(avgEtaDays * 24 * 60, 60 * 48))
        const recommendedAdUplift = Math.min(50 + oosTop3.length * 25, 200)

        // 매칭: 자사 발행 SKU (display_category_name ILIKE %label%)
        const { data: matchedListings } = await sb
          .from('jimscanner_coupang_listings')
          .select('id')
          .ilike('display_category_name', `%${cat.category_label}%`)
          .in('status', ['SELLING', 'APPROVED', 'PENDING_APPROVAL', 'TEMPORARY_SAVE']) as {
            data: Array<{ id: string }> | null
          }
        // 매칭: 트렌드 핀 후보 (category_top match)
        let matchedTrends: Array<{ id: string }> = []
        if (cat.category_top) {
          const { data } = await sb
            .from('jimscanner_trends_products')
            .select('id')
            .eq('category_top', cat.category_top)
            .order('last_seen_at', { ascending: false })
            .limit(20) as { data: Array<{ id: string }> | null }
          matchedTrends = data ?? []
        }

        await sb.from('jimscanner_cascade_events').insert({
          category_key: cat.category_key,
          top_n: cat.top_n,
          out_of_stock_count: oosTop3.length,
          affected_product_ids: oosTop3.map((e) => e.product_id),
          affected_titles: oosTop3.map((e) => e.product_title),
          recommended_boost_minutes: recommendedBoostMinutes,
          recommended_ad_uplift_pct: recommendedAdUplift,
          matched_listing_ids: (matchedListings ?? []).map((r) => r.id),
          matched_trend_product_ids: matchedTrends.map((r) => r.id),
          is_active: true,
        })
        eventsOpened++
      } else if (active && inStockTop3.length >= 2) {
        // 회복 → close
        await sb
          .from('jimscanner_cascade_events')
          .update({
            is_active: false,
            ended_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', active.id)
        eventsClosed++
      }

      await new Promise((r) => setTimeout(r, 1000))
    }

    await sb
      .from('jimscanner_cascade_poll_runs')
      .update({
        finished_at: new Date().toISOString(),
        categories_checked: cats.length,
        snapshots_inserted: snapshotsInserted,
        events_opened: eventsOpened,
        events_closed: eventsClosed,
        duration_ms: Date.now() - startedAt,
        status: 'success',
      })
      .eq('id', runId)

    return NextResponse.json({
      ok: true,
      categories: cats.length,
      snapshots: snapshotsInserted,
      events_opened: eventsOpened,
      events_closed: eventsClosed,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    await sb
      .from('jimscanner_cascade_poll_runs')
      .update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        status: 'error',
        error_message: msg,
      })
      .eq('id', runId)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
