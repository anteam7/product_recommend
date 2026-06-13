/**
 * 로컬 cron — 네이버 스마트스토어 주문 수집
 * Windows 작업 스케줄러로 시간당 실행 (쿠팡 orders-sync 미러)
 *
 * 조회 범위: 최근 2시간 슬라이딩 창 (hourly cron 2h 마진)
 * 초기 백필: --backfill 플래그로 최근 31일 24h 창 31회 루프
 *
 * 엔드포인트: GET /v1/pay-order/seller/product-orders?from=...&to=...
 *   - from/to: UTC ISO 8601 (toISOString())
 *   - 최대 24h 창
 *   - 응답: data.contents[], data.pagination.hasNext
 *
 * 결과: jimscanner_naver_orders upsert (onConflict: product_order_id)
 *       jimscanner_naver_orders_sync_runs 로그
 */
import { naverApi } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BACKFILL = process.argv.includes('--backfill')

// 한 시간 창 주문 수집 (최대 24h)
async function fetchWindow(fromDate, toDate) {
  const orders = []
  let page = 1
  while (true) {
    const qs = new URLSearchParams({
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      page: String(page),
      size: '300',
    })
    const r = await naverApi('GET', `/v1/pay-order/seller/product-orders?${qs}`)

    if (r.status === 403 || r.status === 401) {
      throw new Error(`API 인증 오류 ${r.status}: ${JSON.stringify(r.body).slice(0, 100)}`)
    }
    if (r.status !== 200) {
      console.error(`  HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 100)}`)
      break
    }

    const contents = r.body?.data?.contents ?? []
    orders.push(...contents)

    if (!r.body?.data?.pagination?.hasNext) break
    page++
    await sleep(300)
  }
  return orders
}

// Supabase upsert
async function upsertOrder(o) {
  const addr = o.shippingAddress
  const row = {
    product_order_id:     String(o.productOrderId ?? o.productOrderNo ?? ''),
    order_id:             String(o.orderId ?? o.orderNo ?? ''),
    channel_product_no:   o.channelProductNo ? String(o.channelProductNo) : null,
    origin_product_no:    o.originProductNo ? Number(o.originProductNo) : null,
    product_name:         o.productName ?? '',
    option_name:          o.optionName ?? null,
    quantity:             o.quantity ?? 1,
    total_payment_amount: o.totalPaymentAmount ?? null,
    commission_amount:    o.commissionAmount ?? null,
    product_order_status: o.productOrderStatus ?? '',
    payment_date:         o.paymentDate ?? null,
    order_date:           o.orderDate ?? o.paymentDate ?? new Date().toISOString(),
    receiver_name:        addr?.name ?? null,
    receiver_phone:       addr?.tel1 ?? null,
    receiver_address:     addr ? [addr.baseAddress, addr.detailAddress].filter(Boolean).join(' ') : null,
    delivery_company:     o.deliveryCompany ?? null,
    tracking_number:      o.trackingNumber ?? null,
    shipped_at:           o.shippedAt ?? null,
    delivered_at:         o.deliveredAt ?? null,
    raw_payload:          o,
    last_synced_at:       new Date().toISOString(),
    updated_at:           new Date().toISOString(),
  }
  if (!row.product_order_id) return false
  const { error } = await sb.from('jimscanner_naver_orders')
    .upsert(row, { onConflict: 'product_order_id' })
  if (error) { console.error('upsert 오류:', error.message); return false }
  return true
}

// ── main ──
const t0 = Date.now()
const now = new Date()

// 실행 로그 시작
let runId = null
try {
  const { data: rr } = await sb.from('jimscanner_naver_orders_sync_runs')
    .insert({ status: 'running', triggered_by: BACKFILL ? 'backfill' : 'local-cron' }).select('id').single()
  runId = rr?.id
} catch { /* 테이블 없으면 스킵 */ }

// 창 목록 구성
let windows = []
if (BACKFILL) {
  // 31일 × 24h 창
  console.log('백필 모드: 최근 31일 수집')
  for (let d = 31; d >= 0; d--) {
    const wFrom = new Date(now.getTime() - (d + 1) * 24 * 3600 * 1000)
    const wTo   = new Date(now.getTime() - d * 24 * 3600 * 1000)
    windows.push([wFrom, wTo])
  }
} else {
  // 최근 2h (hourly cron 마진)
  windows = [[new Date(now.getTime() - 2 * 3600 * 1000), now]]
}

let totalFetched = 0, totalUpserted = 0, errors = 0

for (const [wFrom, wTo] of windows) {
  try {
    const orders = await fetchWindow(wFrom, wTo)
    if (orders.length > 0 || BACKFILL) {
      const label = wFrom.toISOString().slice(0, 10)
      console.log(`[${label}] ${orders.length}건`)
    }
    for (const o of orders) {
      const ok = await upsertOrder(o)
      if (ok) totalUpserted++
      else errors++
    }
    totalFetched += orders.length
    if (windows.length > 1) await sleep(BACKFILL ? 600 : 200)
  } catch (e) {
    console.error('창 오류:', e.message)
    errors++
  }
}

const duration = Date.now() - t0
if (!BACKFILL) {
  // 일반 크론은 주문 있을 때만 출력
  if (totalFetched > 0) console.log(`주문 ${totalFetched}건 수집, upsert ${totalUpserted}건`)
  else console.log(`주문 없음 (${duration}ms)`)
} else {
  console.log(`\n백필 완료: 수집 ${totalFetched}건 / upsert ${totalUpserted}건 / 오류 ${errors}건 / ${duration}ms`)
}

if (runId) {
  await sb.from('jimscanner_naver_orders_sync_runs').update({
    status: errors > 0 && totalFetched === 0 ? 'error' : errors > 0 ? 'partial' : 'ok',
    finished_at: new Date().toISOString(),
    total_fetched: totalFetched,
    upserted_count: totalUpserted,
    error_count: errors,
    duration_ms: duration,
  }).eq('id', runId)
}
