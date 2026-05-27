#!/usr/bin/env node
/**
 * 쿠팡 자동등록 SKU 일별 traction 적재 (cron: 매일 03:00 KST)
 *
 * 흐름:
 *   1) jimscanner_coupang_listings 에서 활성 SKU (status in SELLING/APPROVED/TEMPORARY_SAVE,
 *      registered_at <= now-30d) 가져오기
 *   2) 각 SKU 의 Coupang Wing 통계 API 호출 → 어제자 노출/클릭/장바구니/주문/매출
 *   3) jimscanner_coupang_sku_traction_daily 에 upsert (listing_id, snapshot_date unique)
 *   4) D+7/D+14/D+21 체크포인트에서 카테고리×가격버킷 P25 벤치마크 미달 SKU 를
 *      jimscanner_coupang_deprecate_queue 에 enqueue
 *   5) 실행 결과를 jimscanner_coupang_traction_runs 에 기록
 *
 * Coupang Wing 통계 API:
 *   GET /v2/providers/marketplace_openapi/apis/api/v1/product/statistics/seller-product
 *   - 우리 환경에 통계 API 권한이 없을 경우 KEEPA-style 대체(상품 페이지 노출/판매 수 추정) 사용.
 *   - 현재는 골격만 — 실제 권한 발급 후 fetchTractionForSku() 채워넣기.
 *
 * 실행:
 *   node scripts/coupang-traction-daily.mjs
 *   node scripts/coupang-traction-daily.mjs --dry         # 적재 없이 시뮬레이트
 *   node scripts/coupang-traction-daily.mjs --listing=<id> # 단일 SKU 디버그
 */

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
const COUPANG_ACCESS = process.env.COUPANG_ACCESS_KEY
const COUPANG_SECRET = process.env.COUPANG_SECRET_KEY
const COUPANG_VENDOR_ID = process.env.COUPANG_VENDOR_ID
const COUPANG_HOST = 'https://api-gateway.coupang.com'

const DRY = process.argv.includes('--dry')
const LISTING_FILTER = (() => {
  const a = process.argv.find((x) => x.startsWith('--listing='))
  return a ? a.split('=')[1] : null
})()

// ─── helpers ───
function signCoupang(method, urlPath) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const signature = crypto.createHmac('sha256', COUPANG_SECRET).update(dt + method + urlPath).digest('hex')
  return { datetime: dt, signature }
}

async function coupangApi(method, urlPath) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const res = await fetch(`${COUPANG_HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}

function ymd(d) { return d.toISOString().slice(0, 10) }
function daysBetween(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0)
  return Math.round(ms / 86_400_000)
}
function priceBucket(p) {
  if (p < 10000) return '<10k'
  if (p < 30000) return '10-30k'
  if (p < 50000) return '30-50k'
  if (p < 100000) return '50-100k'
  return '100k+'
}

// 실제 Wing 통계 API. 권한 미발급 시 빈 응답 반환.
async function fetchTractionForSku({ sellerProductId, productId, snapshotDate }) {
  if (!sellerProductId) return null
  // TODO: 실제 통계 엔드포인트로 교체. 현재 권한 발급 전이라 빈 응답 폴백.
  // const path = `/v2/providers/marketplace_openapi/apis/api/v1/product/statistics/seller-product?sellerProductId=${sellerProductId}&searchDate=${snapshotDate}`
  // const r = await coupangApi('GET', path)
  // if (r.status === 200 && r.body?.data) {
  //   return {
  //     impressions: Number(r.body.data.exposureCount ?? 0),
  //     clicks: Number(r.body.data.clickCount ?? 0),
  //     carts: Number(r.body.data.cartCount ?? 0),
  //     orders: Number(r.body.data.orderCount ?? 0),
  //     revenue_krw: Number(r.body.data.salesAmount ?? 0),
  //   }
  // }
  return { impressions: 0, clicks: 0, carts: 0, orders: 0, revenue_krw: 0 }
}

// ─── main ───
async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 가 없습니다.')
    process.exit(1)
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })

  // 실행 로그 시작
  let runId = null
  if (!DRY) {
    const { data } = await sb
      .from('jimscanner_coupang_traction_runs')
      .insert({ status: 'running', triggered_by: 'manual' })
      .select('id')
      .single()
    runId = data?.id ?? null
  }

  const startedAt = Date.now()
  const yesterday = new Date(Date.now() - 86_400_000)
  const snapshotDate = ymd(yesterday)

  // 활성 SKU 가져오기 — 발행 후 30일 이내만
  let q = sb
    .from('jimscanner_coupang_listings')
    .select('id, seller_product_id, product_id, display_category_code, list_price_krw, registered_at, status')
    .in('status', ['SELLING', 'APPROVED', 'TEMPORARY_SAVE', 'PENDING_APPROVAL'])
    .not('registered_at', 'is', null)
    .gte('registered_at', new Date(Date.now() - 31 * 86_400_000).toISOString())
  if (LISTING_FILTER) q = q.eq('id', LISTING_FILTER)
  const { data: listings, error } = await q
  if (error) {
    console.error('listings fetch failed:', error)
    process.exit(1)
  }

  console.log(`📊 활성 SKU ${listings?.length ?? 0}건 — snapshot_date=${snapshotDate}`)

  let upserted = 0
  let errors = 0
  let queued = 0

  for (const l of listings ?? []) {
    try {
      const dsp = daysBetween(l.registered_at, yesterday)
      if (dsp < 1 || dsp > 30) continue

      const t = await fetchTractionForSku({
        sellerProductId: l.seller_product_id,
        productId: l.product_id,
        snapshotDate,
      })
      if (!t) continue

      const ctr = t.impressions > 0 ? t.clicks / t.impressions : null
      const cart_rate = t.clicks > 0 ? t.carts / t.clicks : null
      const conversion_rate = t.clicks > 0 ? t.orders / t.clicks : null

      if (DRY) {
        console.log(`  [DRY] ${l.id} D+${dsp} impr=${t.impressions} clicks=${t.clicks} orders=${t.orders}`)
        continue
      }

      const { error: upErr } = await sb
        .from('jimscanner_coupang_sku_traction_daily')
        .upsert({
          listing_id: l.id,
          seller_product_id: l.seller_product_id,
          product_id: l.product_id,
          display_category_code: l.display_category_code,
          list_price_krw: l.list_price_krw,
          snapshot_date: snapshotDate,
          days_since_publish: dsp,
          impressions: t.impressions,
          clicks: t.clicks,
          carts: t.carts,
          orders: t.orders,
          revenue_krw: t.revenue_krw,
          ctr,
          cart_rate,
          conversion_rate,
          source: 'coupang_wing',
        }, { onConflict: 'listing_id,snapshot_date' })
      if (upErr) {
        errors += 1
        console.warn(`  ✗ upsert failed ${l.id}: ${upErr.message}`)
        continue
      }
      upserted += 1

      // D+7/D+14/D+21 체크포인트에서 P25 미달 검사
      if ([7, 14, 21].includes(dsp)) {
        const pBucket = priceBucket(l.list_price_krw)
        const { data: bench } = await sb
          .from('jimscanner_coupang_traction_benchmarks')
          .select('p25_impr, sample_n')
          .eq('display_category_code', l.display_category_code)
          .eq('price_bucket', pBucket)
          .eq('days_since_publish', dsp)
          .maybeSingle()
        const p25 = bench?.p25_impr ?? null
        if (p25 != null && (bench.sample_n ?? 0) >= 5 && t.impressions < p25) {
          await sb
            .from('jimscanner_coupang_deprecate_queue')
            .upsert({
              listing_id: l.id,
              reason: `D+${dsp} 노출 ${t.impressions} < 카테고리·가격대 P25 (${p25}) — n=${bench.sample_n}`,
              checkpoint_day: dsp,
              metric: 'impressions',
              benchmark_p25: p25,
              actual_value: t.impressions,
              status: 'pending',
            }, { onConflict: 'listing_id,checkpoint_day,metric' })
          queued += 1
        }
      }
    } catch (e) {
      errors += 1
      console.error(`  ✗ error ${l.id}:`, e?.message ?? e)
    }
  }

  const took = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`✅ done — upserted=${upserted} queued=${queued} errors=${errors} took=${took}s`)

  if (runId) {
    await sb
      .from('jimscanner_coupang_traction_runs')
      .update({
        status: errors > 0 ? 'done' : 'done',
        finished_at: new Date().toISOString(),
        total_skus: listings?.length ?? 0,
        upserted,
        errors,
        queued_count: queued,
      })
      .eq('id', runId)
  }
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
