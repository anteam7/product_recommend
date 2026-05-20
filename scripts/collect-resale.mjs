#!/usr/bin/env node
/**
 * 중고시장 잔존가치·회전율 수집기
 *   - 당근마켓 / 번개장터 / 중고나라 키워드 검색
 *   - 활성 매물 수, 평균가, 완료거래 수, days-to-sold 중간값 수집
 *   - jimscanner_trends_resale_signals 에 적재
 *
 * 사용법:
 *   node --env-file=.env.local scripts/collect-resale.mjs            # 전체 (alias 또는 canonical_name 기준)
 *   node --env-file=.env.local scripts/collect-resale.mjs --product <uuid>  # 특정 product 만
 *   node --env-file=.env.local scripts/collect-resale.mjs --dry      # 적재 안함
 *
 * 주의: 당근·번개·중나는 캡차/JS 렌더가 강해서 1차 구현은 가벼운 HTTP/HTML 파싱.
 *      실패 시 listings_active=0 으로 적재하고 meta.error 기록.
 *      향후 playwright 기반으로 교체 예정.
 */

import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.')
  process.exit(1)
}
const sb = createClient(URL, KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const PRODUCT_IDX = args.indexOf('--product')
const PRODUCT_FILTER = PRODUCT_IDX >= 0 ? args[PRODUCT_IDX + 1] : null
const LIMIT_IDX = args.indexOf('--limit')
const LIMIT = LIMIT_IDX >= 0 ? Number(args[LIMIT_IDX + 1]) || 20 : 20

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SOURCES = ['danggeun', 'bunjang', 'joongna']

/**
 * 각 소스별 fetch — 1차 구현은 검색 결과 HTML 페이지를 가볍게 파싱.
 * 실패해도 throw 하지 말고 빈 결과 반환.
 */
async function fetchDanggeun(query) {
  const url = `https://www.daangn.com/search/${encodeURIComponent(query)}/buy-sell`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' } })
    if (!res.ok) return { ok: false, status: res.status }
    const html = await res.text()
    // ldb-card / data-card / 가격 패턴 일단 정규식
    const prices = [...html.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원/g)]
      .map((m) => Number(m[1].replace(/,/g, '')))
      .filter((n) => n >= 1000 && n <= 5_000_000)
    const listings = prices.length
    const avg = listings > 0 ? prices.reduce((a, b) => a + b, 0) / listings : null
    return { ok: true, listings_active: listings, avg_used_price: avg }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fetchBunjang(query) {
  // bunjang api 는 public bunjang.co.kr/find/products?q=
  const url = `https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(query)}&order=date&page=0&n_p=100`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return { ok: false, status: res.status }
    const json = await res.json().catch(() => null)
    const items = json?.list ?? []
    const prices = items.map((it) => Number(it.price)).filter((n) => Number.isFinite(n) && n > 0)
    const sold = items.filter((it) => it.status === 'SOLD_OUT' || it.product_status === 'sold_out').length
    const total = items.length
    const active = total - sold
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null
    // days_to_sold: update_time vs current
    const now = Date.now()
    const soldDays = items
      .filter((it) => (it.status === 'SOLD_OUT' || it.product_status === 'sold_out') && it.update_time)
      .map((it) => (now - Number(it.update_time) * 1000) / 86400_000)
      .filter((d) => d >= 0 && d <= 365)
    soldDays.sort((a, b) => a - b)
    const median = soldDays.length ? soldDays[Math.floor(soldDays.length / 2)] : null
    return {
      ok: true,
      listings_active: active,
      avg_used_price: avg,
      sold_count_30d: soldDays.filter((d) => d <= 30).length,
      days_to_sold_median: median,
      sold_completed_ratio: total > 0 ? sold / total : null,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fetchJoongna(query) {
  const url = `https://web.joongna.com/search/${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' } })
    if (!res.ok) return { ok: false, status: res.status }
    const html = await res.text()
    // JSON next-data 시도
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (m) {
      try {
        const json = JSON.parse(m[1])
        const items =
          json?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.pages?.[0]?.data?.items ??
          json?.props?.pageProps?.initialData?.items ??
          []
        const prices = items.map((it) => Number(it?.price)).filter((n) => Number.isFinite(n) && n > 0)
        const sold = items.filter((it) => it?.saleStatus === 2 || it?.status === 'SOLD_OUT').length
        const total = items.length
        const active = total - sold
        const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null
        return {
          ok: true,
          listings_active: active,
          avg_used_price: avg,
          sold_completed_ratio: total > 0 ? sold / total : null,
        }
      } catch {
        // fall through to regex
      }
    }
    const prices = [...html.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원/g)]
      .map((mm) => Number(mm[1].replace(/,/g, '')))
      .filter((n) => n >= 1000 && n <= 5_000_000)
    return {
      ok: true,
      listings_active: prices.length,
      avg_used_price: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const FETCHERS = {
  danggeun: fetchDanggeun,
  bunjang: fetchBunjang,
  joongna: fetchJoongna,
}

/**
 * product 의 신품 참고가:
 *   1) jimscanner_ggsan_products 에서 같은 alias 또는 canonical_name 매칭한 평균
 *   2) 없으면 NULL
 */
async function lookupNewPriceRef(productId, canonical) {
  try {
    const { data } = await sb
      .from('jimscanner_ggsan_products')
      .select('price_krw, title')
      .ilike('title', `%${canonical}%`)
      .limit(20)
    const prices = (data ?? []).map((r) => Number(r.price_krw)).filter((n) => n > 0)
    if (prices.length === 0) return null
    prices.sort((a, b) => a - b)
    return prices[Math.floor(prices.length / 2)] // 중간값
  } catch {
    return null
  }
}

async function main() {
  // 대상 products 조회
  let q = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(LIMIT)
  if (PRODUCT_FILTER) {
    q = sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, alias_count, last_seen_at')
      .eq('id', PRODUCT_FILTER)
  }
  const { data: products, error } = await q
  if (error) {
    console.error('product 조회 실패:', error.message)
    process.exit(1)
  }
  if (!products || products.length === 0) {
    console.log('대상 product 없음.')
    return
  }
  console.log(`[${new Date().toISOString()}] resale 수집 시작 — ${products.length} products`)

  const rows = []
  for (const p of products) {
    const newRef = await lookupNewPriceRef(p.id, p.canonical_name)
    for (const source of SOURCES) {
      const fn = FETCHERS[source]
      const t0 = Date.now()
      const r = await fn(p.canonical_name)
      const ms = Date.now() - t0
      const priceRatio =
        r.ok && r.avg_used_price && newRef && newRef > 0 ? r.avg_used_price / newRef : null
      const row = {
        product_id: p.id,
        source,
        query: p.canonical_name,
        listings_active: r.ok ? r.listings_active ?? 0 : 0,
        avg_used_price: r.ok ? r.avg_used_price ?? null : null,
        new_price_ref: newRef,
        price_ratio: priceRatio,
        days_to_sold_median: r.ok ? r.days_to_sold_median ?? null : null,
        sold_completed_ratio: r.ok ? r.sold_completed_ratio ?? null : null,
        sold_count_30d: r.ok ? r.sold_count_30d ?? null : null,
        meta: r.ok ? { ms } : { ms, error: r.error ?? `status_${r.status}` },
      }
      rows.push(row)
      console.log(
        `  ${r.ok ? 'OK ' : 'ERR'} ${source.padEnd(8)} ${ms.toString().padStart(5)}ms  ${p.canonical_name.slice(0, 30).padEnd(30)} listings=${row.listings_active} avg=${row.avg_used_price?.toFixed(0) ?? '—'} ratio=${row.price_ratio?.toFixed(2) ?? '—'}`,
      )
    }
  }

  if (DRY) {
    console.log(`[dry] ${rows.length} rows 적재 안 함`)
    return
  }

  // upsert by (product_id, source, query, collected_at) — 같은 시점이면 덮어쓰기.
  // collected_at 은 default now() 라서 INSERT 만 사용.
  const { error: insErr } = await sb.from('jimscanner_trends_resale_signals').insert(rows)
  if (insErr) {
    console.error('insert 실패:', insErr.message)
    process.exit(1)
  }
  console.log(`[${new Date().toISOString()}] ${rows.length} rows 적재 완료`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
