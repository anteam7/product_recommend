#!/usr/bin/env node
/**
 * 로컬 cron — 토스쇼핑 주문 수집 + 발주확인 + ggsan 송장 추적 + 토스 송장 등록 (P2)
 * canon: docs/plan-toss-shopping.md §3
 *
 * Windows 작업 "Toss-Orders-Sync" 매시간 실행 (:17 — 쿠팡 :03/:33, ggsan-sync 오프셋과 분리).
 * 토스 API는 IP 허용제라 Vercel 불가 → 쿠팡과 달리 송장 등록까지 이 크론이 직접 수행.
 *
 * 흐름:
 *   ① runs insert(running)
 *   ② GET /orders/v2 (31일 창, 커서 페이징) → jimscanner_toss_orders upsert (수집 실패 시 전체 중단)
 *      멱등: 이미 있는 행의 매입 추적 컬럼(purchase_*, ggsan_*, supplier_*)은 건드리지 않음
 *   ③ 발주확인: order_status=PAID → PUT /orders/products/status PREPARING_PRODUCT (≤100 배치)
 *      (발송기한 페널티 방지 1단계 — 발주 자체는 어드민 결제진행/원격 큐)
 *   ④ ggsan 추적: purchase ORDERED/SHIPPED & ggsan_order_no 有 & toss_invoice_status in (none,pending,failed)
 *      → order_view 파싱(local-cron-ggsan-sync 와 동일) → 취소/반품 needs_attention, 실결제액 기록,
 *        송장 발견 시 SHIPPED + toss_invoice_status='pending'
 *   ⑤ 토스 송장 등록: toss_invoice_status='pending' & 송장·택배사 有
 *      → PUT /orders/products/delivery {orderProductId, deliveryCompany(한글명), trackingNumber}
 *      → 성공 registered(주문상태 자동 DELIVERING), 실패 failed + toss_invoice_error
 *   ⑥ runs update
 *
 * 실행: node scripts/local-cron-toss-orders-sync.mjs [--dry(수집만, 전이·등록 안 함)]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { tossOrders, tossSetOrderStatus, tossSetDelivery } from './lib/toss-api.mjs'

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
const DRY = process.argv.includes('--dry')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()

// ─── runs ───
let runId = null
try {
  const { data } = await sb.from('jimscanner_toss_orders_sync_runs').insert({ status: 'running', triggered_by: DRY ? 'manual-dry' : 'local-cron' }).select('id').single()
  runId = data?.id
} catch { /* 테이블 없으면 스킵 */ }
let totalFetched = 0, inserted = 0, acked = 0, tracked = 0, invoiceOk = 0, invoiceErr = 0, errors = 0
async function finish(status, errorMessage = null) {
  if (runId) {
    await sb.from('jimscanner_toss_orders_sync_runs').update({
      finished_at: new Date().toISOString(), status,
      total_fetched: totalFetched, inserted_count: inserted, acked_count: acked,
      tracked_count: tracked, invoice_ok: invoiceOk, invoice_err: invoiceErr,
      error_count: errors, duration_ms: Date.now() - t0, error_message: errorMessage,
    }).eq('id', runId).then(() => {}, () => {})
  }
  console.log(`[toss-orders-sync] ${status} fetched=${totalFetched} upserted=${inserted} acked=${acked} tracked=${tracked} invoice_ok=${invoiceOk} invoice_err=${invoiceErr} errors=${errors} (${((Date.now() - t0) / 1000).toFixed(1)}s)${errorMessage ? ' | ' + errorMessage.slice(0, 160) : ''}`)
  process.exit(0) // 작업 스케줄러 Result=0 유지 — 상태는 runs 테이블이 진실
}

// ─── ② 주문 수집 (31일 창 — 쿠팡과 동일: PC 꺼진 구간 자가복구) ───
const fmt = (d) => d.toISOString().slice(0, 10)
const now = new Date()
const startDate = fmt(new Date(now.getTime() - 31 * 24 * 3600 * 1000))
const endDate = fmt(now)
const rows = []
let cursor = null
try {
  for (let page = 0; page < 200; page++) {
    const r = await tossOrders({ startDate, endDate, limit: 50, nextCursor: cursor ?? undefined })
    if (!r.ok) throw new Error(`주문 조회 실패 ${r.error?.errorCode}: ${r.error?.reason}`)
    const items = r.data?.results ?? r.data?.items ?? []
    rows.push(...items)
    cursor = r.data?.nextCursor ?? null
    if (!cursor || !items.length) break
    await sleep(150)
  }
} catch (e) {
  await finish('error', String(e.message || e))
}
totalFetched = rows.length

for (const o of rows) {
  const row = {
    order_product_id: o.orderProductId,
    order_id: o.orderId ?? null,
    toss_product_id: o.productId ?? null,
    stock_id: o.stockId ?? null,
    product_name: o.productName ?? null,
    option_name: o.optionName ?? null,
    quantity: o.quantity ?? 1,
    price: o.price ?? null,
    total_discount_price: o.totalDiscountPrice ?? null,
    product_management_code: o.productManagementCode ?? null,
    item_management_code: o.productItemManagementCode ?? null,
    order_status: o.orderProductStatus ?? null,
    shipping_deadline_at: o.shippingDeadlineAt ?? null,
    receiver_name: o.receiverName ?? null,
    receiver_phone: o.receiverPhone ?? null,
    receiver_address: o.address ?? null,
    receiver_address_detail: o.detailAddress ?? null,
    receiver_zip_code: o.zipCode ?? null,
    shipping_note: o.shippingNote ?? null,
    ordered_at: o.orderedAt ?? null,
    raw_payload: o,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { error } = await sb.from('jimscanner_toss_orders').upsert(row, { onConflict: 'order_product_id' })
  if (error) { errors++; console.error(`  upsert 실패 ${o.orderProductId}: ${error.message}`) } else inserted++
}

// ─── ③ 발주확인: PAID → PREPARING_PRODUCT ───
if (!DRY) {
  const paid = rows.filter((o) => o.orderProductStatus === 'PAID').map((o) => o.orderProductId)
  for (let i = 0; i < paid.length; i += 100) {
    const batch = paid.slice(i, i + 100)
    const r = await tossSetOrderStatus({ orderProductIds: batch, status: 'PREPARING_PRODUCT' })
    if (!r.ok) { errors++; console.error(`  발주확인 실패: ${JSON.stringify(r.error).slice(0, 200)}`); continue }
    const failedIds = new Set((r.data?.failedReasons ?? []).map((f) => f.orderProductId))
    const okIds = batch.filter((id) => !failedIds.has(id))
    acked += okIds.length
    if (failedIds.size) console.error(`  발주확인 부분실패 ${failedIds.size}건: ${JSON.stringify(r.data?.failedReasons).slice(0, 200)}`)
    if (okIds.length) {
      await sb.from('jimscanner_toss_orders')
        .update({ order_status: 'PREPARING_PRODUCT', acknowledged_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .in('order_product_id', okIds)
    }
  }
}

// ─── ④ ggsan 송장 추적 (local-cron-ggsan-sync 와 동일 파서) ───
const GGSAN_BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const CARRIER_SNO_TO_NAME = { 8: 'CJ대한통운' } // 토스 deliveryCompany 는 한글명 그대로 사용
const ORDER_STATUS_KEYWORDS = ['입금대기', '결제완료', '상품준비중', '배송중', '배송완료', '구매확정', '취소', '반품', '교환', '환불']
const FALLBACK_SAFE_STATUSES = ['입금대기', '결제완료', '상품준비중', '배송중', '배송완료']
const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const eq = kv.indexOf('='); if (eq < 0) continue; cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()) } }
async function ggsanFetch(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers || {}) } })
  setCookies(res.headers.get('set-cookie'))
  return res
}
async function ggsanLogin() {
  await ggsanFetch(`${GGSAN_BASE}/member/login.php`)
  const r = await ggsanFetch(`${GGSAN_BASE}/member/login_ps.php`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${GGSAN_BASE}/member/login.php` }, body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${GGSAN_BASE}/main/index.php` }).toString() })
  if (!/main\/index\.php/.test(await r.text())) throw new Error('ggsan login failed')
}
function parseOrderView(html) {
  const invoiceNo = /data-invoice-no=["']([^"']+)/.exec(html)?.[1]?.trim() ?? null
  const carrierSno = /data-invoice-company-sno=["']([^"']+)/.exec(html)?.[1]?.trim() ?? null
  let orderStatus = null
  const afterName = html.includes('order-name') ? html.slice(html.indexOf('order-name')) : html
  const emMatch = afterName.match(/<em>\s*([^<]+?)\s*<\/em>/)
  if (emMatch) { const t = emMatch[1].replace(/\s+/g, ''); if (ORDER_STATUS_KEYWORDS.includes(t)) orderStatus = t }
  if (!orderStatus) for (const kw of FALLBACK_SAFE_STATUSES) { if (afterName.includes(kw)) { orderStatus = kw; break } }
  const actualPaid = (() => { const m = /class=["']total_pay_money["']\s*>\s*([\d,]+)\s*원/.exec(html); return m ? parseInt(m[1].replace(/,/g, ''), 10) : null })()
  return { invoiceNo, carrierSno, orderStatus, actualPaid }
}

const { data: targets } = await sb.from('jimscanner_toss_orders')
  .select('id, order_product_id, ggsan_order_no, purchase_status, toss_invoice_status, ggsan_invoice_number, ggsan_carrier_name, purchase_total_cost')
  .in('toss_invoice_status', ['none', 'pending', 'failed'])
  .in('purchase_status', ['ORDERED', 'SHIPPED'])
  .not('ggsan_order_no', 'is', null)
  .limit(100)

if ((targets ?? []).length && !DRY) {
  let loggedIn = false
  try { await ggsanLogin(); loggedIn = true } catch (e) { errors++; console.error('  ggsan 로그인 실패 — 추적 스킵:', e.message) }
  if (loggedIn) {
    for (const row of targets) {
      try {
        const res = await ggsanFetch(`${GGSAN_BASE}/mypage/order_view.php?orderNo=${encodeURIComponent(row.ggsan_order_no)}`)
        const html = await res.text()
        const parsed = parseOrderView(html)
        tracked++
        const update = { ggsan_order_status: parsed.orderStatus, ggsan_last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        if (parsed.orderStatus && /취소|반품|교환|환불/.test(parsed.orderStatus)) { update.needs_attention = true; update.attention_reason = `ggsan ${parsed.orderStatus}` }
        if (parsed.actualPaid && !row.purchase_total_cost) { update.ggsan_actual_paid = parsed.actualPaid; update.purchase_total_cost = parsed.actualPaid }
        if (parsed.invoiceNo) {
          const carrierName = parsed.carrierSno != null ? (CARRIER_SNO_TO_NAME[parsed.carrierSno] ?? null) : null
          update.ggsan_invoice_number = parsed.invoiceNo
          update.ggsan_carrier_name = carrierName
          if (!row.ggsan_invoice_number) update.ggsan_shipped_at = new Date().toISOString()
          update.purchase_status = 'SHIPPED'
          if (carrierName) { if (row.toss_invoice_status !== 'registered') update.toss_invoice_status = 'pending' }
          else { update.needs_attention = true; update.attention_reason = `택배사 미매핑(sno ${parsed.carrierSno ?? 'X'})` }
        }
        await sb.from('jimscanner_toss_orders').update(update).eq('id', row.id)
        await sleep(300)
      } catch (e) { errors++; console.error(`  추적 실패 ${row.ggsan_order_no}: ${e.message}`) }
    }
  }
}

// ─── ⑤ 토스 송장 등록 (pending → registered/failed) ───
if (!DRY) {
  const { data: pend } = await sb.from('jimscanner_toss_orders')
    .select('id, order_product_id, ggsan_invoice_number, ggsan_carrier_name')
    .eq('toss_invoice_status', 'pending')
    .not('ggsan_invoice_number', 'is', null)
    .not('ggsan_carrier_name', 'is', null)
    .limit(50)
  for (const row of pend ?? []) {
    const r = await tossSetDelivery(row.order_product_id, row.ggsan_carrier_name, String(row.ggsan_invoice_number).replace(/-/g, ''))
    if (r.ok) {
      invoiceOk++
      await sb.from('jimscanner_toss_orders').update({ toss_invoice_status: 'registered', toss_invoice_registered_at: new Date().toISOString(), order_status: 'DELIVERING', toss_invoice_error: null, updated_at: new Date().toISOString() }).eq('id', row.id)
    } else {
      invoiceErr++
      // 진행 중 클레임이면 실패함(스펙) — needs_attention 으로 표면화
      await sb.from('jimscanner_toss_orders').update({ toss_invoice_status: 'failed', toss_invoice_error: JSON.stringify(r.error).slice(0, 500), needs_attention: true, attention_reason: '토스 송장등록 실패', updated_at: new Date().toISOString() }).eq('id', row.id)
      console.error(`  송장등록 실패 ${row.order_product_id}: ${JSON.stringify(r.error).slice(0, 200)}`)
    }
    await sleep(200)
  }
}

await finish('success', errors > 0 ? `${errors}건 부분 오류` : null)
