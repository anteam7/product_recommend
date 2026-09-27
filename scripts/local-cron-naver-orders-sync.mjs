/**
 * 로컬 cron — 네이버 스마트스토어 주문 수집 · 상태 동기화 · 매입처 송장 자동수집 → 네이버 발송처리
 * Windows 작업 "Naver-Orders-Sync" 매시 :07 (쿠팡 orders-sync / ggsan-sync / toss 미러)
 *
 * 2026-09-27 개편 — 예전엔 "결제 시각 기준 최근 2시간 창"만 조회해서, 주문이 처음 들어온 뒤의 상태 변화
 * (발주확인·발송·배송완료·구매확정·취소)가 DB에 영영 반영되지 않았다(13건 중 12건 불일치 실측).
 *   ① 변경 조회: GET last-changed-statuses — 마지막 성공 회차 시각(-10분)부터 지금까지(24h 창 루프).
 *      PC가 꺼져 있던 구간도 재가동 시 자동 보충된다(기존 '2h 창 영구 누락' 문제 해소).
 *   ② 진행 중 주문 재조회: DB에서 최종상태(구매확정·취소·반품…)가 아닌 주문 전부 POST /query.
 *      발주확인(placeOrderStatus)은 '상태 변경'이 아니라 ①에 안 잡히므로(실측) 이걸로 맞춘다.
 *   → ①∪② 를 상세조회해 upsert (우리 컬럼 purchase_· supplier_· naver_dispatch_ 계열은 건드리지 않음,
 *      배송 컬럼은 네이버 값이 있을 때만 → 어드민에서 입력한 송장 보존)
 *   ③ 발주확인 스윕: 매입상태 발주완료/매입처발송인데 네이버 결제완료·미확인 → 발주확인(큐 잡 실패분 자동 복구)
 *   ④ 매입처 송장 추적: 발주완료/매입처발송 + 매입처 주문번호 有 + 발송처리 전(none)
 *      → 매입처(ggsan: order_view / 유픽: Cafe24 주문상세) 파싱 → 취소·반품이면 needs_attention,
 *        송장 발견 시 tracking_number/delivery_company 기록 + 매입처발송(SHIPPED) + naver_dispatch_status='pending'
 *   ⑤ 네이버 발송처리: pending/failed(시도 5회 미만) → scripts/lib/naver-order-ops.mjs dispatch
 *      (네이버 실상태 재조회 게이트: 이미 발송됨→동기화만, 클레임·발송불가→중단+확인필요)
 *   ⑥ runs update
 *
 * 실행: node scripts/local-cron-naver-orders-sync.mjs [--dry] [--backfill]
 *   --dry      네이버 쓰기(발주확인·발송처리)와 매입처 추적 DB 기록을 하지 않는다(수집·상태 갱신은 함 — 네이버 실값 반영이라 안전)
 *   --backfill 추가로 최근 31일 조건형 조회(GET product-orders, 24h 창)로 재수집
 */
import { naverApi } from './lib/naver-api.mjs'
import { createNaverOrderOps, NAVER_FINAL_STATUSES, normalizeTracking } from './lib/naver-order-ops.mjs'
import { createGgsanSession } from './lib/ggsan-tracking.mjs'
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
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('.env.local에 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ops = createNaverOrderOps({ sb, log: console.log })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BACKFILL = process.argv.includes('--backfill')
const DRY = process.argv.includes('--dry')
const TABLE = 'jimscanner_naver_orders'
const DEADLINE_MS = 8 * 60 * 1000 // 매시 실행이라 회차당 8분 가드(유픽은 브라우저 세션이라 느림)
const MAX_TRACK = 60
const t0 = Date.now()
const now = new Date()
let lastError = null
let totalFetched = 0, totalUpserted = 0, refreshed = 0, tracked = 0, dispatchOk = 0, dispatchErr = 0, errors = 0
const noteError = (msg) => { errors++; lastError = msg; console.error(`  ${msg}`) }

// ── runs ──
let runId = null
let cursor = null
try {
  // 커서 = 마지막으로 끝까지 돈 회차의 시작 시각(이번 회차 insert 전에 조회)
  const { data: last } = await sb.from('jimscanner_naver_orders_sync_runs')
    .select('started_at').in('status', ['ok', 'partial']).in('triggered_by', ['local-cron', 'manual', 'backfill'])
    .order('started_at', { ascending: false }).limit(1)
  cursor = last?.[0]?.started_at ? new Date(last[0].started_at) : null
  const { data: rr } = await sb.from('jimscanner_naver_orders_sync_runs')
    .insert({ status: 'running', triggered_by: BACKFILL ? 'backfill' : DRY ? 'manual-dry' : 'local-cron' }).select('id').single()
  runId = rr?.id
} catch { /* 테이블 없으면 스킵 */ }

// ── (--backfill) 조건형 조회 31일 — 기존 동작 유지 ──
async function fetchWindow(fromDate, toDate) {
  const orders = []
  for (let page = 1; page < 100; page++) {
    const qs = new URLSearchParams({ from: fromDate.toISOString(), to: toDate.toISOString(), page: String(page), size: '300' })
    const r = await naverApi('GET', `/v1/pay-order/seller/product-orders?${qs}`)
    if (r.status !== 200) throw new Error(`조건형 조회 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 150)}`)
    orders.push(...(r.body?.data?.contents ?? []))
    if (!r.body?.data?.pagination?.hasNext) break
    await sleep(300)
  }
  return orders
}
if (BACKFILL) {
  console.log('백필 모드: 최근 31일 조건형 조회')
  for (let d = 31; d >= 0; d--) {
    try {
      const items = await fetchWindow(new Date(now.getTime() - (d + 1) * 864e5), new Date(now.getTime() - d * 864e5))
      totalFetched += items.length
      totalUpserted += await ops.upsertItems(items)
      await sleep(600)
    } catch (e) { noteError(`백필 창 오류: ${e.message}`) }
  }
}

// ── ①② 변경 조회 + 진행 중 주문 재조회 → upsert ──
try {
  const from = new Date(Math.max((cursor ? cursor.getTime() - 10 * 60e3 : now.getTime() - 48 * 3600e3), now.getTime() - 30 * 864e5))
  const changed = await ops.changedIdsSince(from, now)
  const { data: openRows } = await sb.from(TABLE).select('product_order_id, product_order_status')
  const open = (openRows ?? []).filter((r) => !NAVER_FINAL_STATUSES.has(r.product_order_status)).map((r) => r.product_order_id)
  const ids = [...new Set([...changed, ...open])]
  const r = await ops.refreshByIds(ids)
  totalFetched += changed.length
  refreshed = r.fetched
  totalUpserted += r.upserted
  console.log(`[naver-orders-sync] 변경 ${changed.length}건(${from.toISOString().slice(0, 16)}~) + 진행중 ${open.length}건 → 조회 ${r.fetched} · 반영 ${r.upserted}`)
} catch (e) { noteError(`상태 동기화 실패: ${e.message}`) }

// ── ③ 발주확인 스윕 ──
{
  const { data: rows } = await sb.from(TABLE).select('product_order_id')
    .in('purchase_status', ['ORDERED', 'SHIPPED']).eq('product_order_status', 'PAYED')
    .or('place_order_status.is.null,place_order_status.neq.OK').limit(50)
  for (const r of rows ?? []) {
    if (DRY) { console.log(`  [dry] 발주확인 대상 ${r.product_order_id}`); continue }
    try {
      const c = await ops.confirm(r.product_order_id)
      console.log(`  발주확인 ${r.product_order_id}: ${c.ok ? '✓' : '✗'} ${c.detail}`)
      if (!c.ok && !c.skipped) errors++
    } catch (e) { noteError(`발주확인 오류 ${r.product_order_id}: ${e.message}`) }
    await sleep(200)
  }
}

// ── ④ 매입처 송장 추적 ──
{
  const { data: rows, error } = await sb.from(TABLE)
    .select('id, product_order_id, origin_product_no, supplier_source, supplier_goods_no, supplier_order_no, purchase_status, purchase_ordered_at, purchase_total_cost, tracking_number, delivery_company, supplier_shipped_at')
    .in('purchase_status', ['ORDERED', 'SHIPPED']).eq('naver_dispatch_status', 'none')
    .not('supplier_order_no', 'is', null).limit(MAX_TRACK)
  if (error) noteError(`추적 대상 조회 실패: ${error.message}`)
  const targets = rows ?? []
  // 매입처 판별 = order-server resolveNaverOrder 와 동일(주문별 오버라이드 → listings.source)
  const originNos = [...new Set(targets.filter((r) => !(r.supplier_source && r.supplier_goods_no) && r.origin_product_no).map((r) => r.origin_product_no))]
  const srcByOrigin = new Map()
  if (originNos.length) {
    const { data: L } = await sb.from('jimscanner_naver_listings').select('origin_product_no, source').in('origin_product_no', originNos)
    for (const l of L ?? []) if (l.source && !srcByOrigin.has(l.origin_product_no)) srcByOrigin.set(l.origin_product_no, l.source)
  }
  const sourceOf = (r) => (r.supplier_source && r.supplier_goods_no) ? r.supplier_source : srcByOrigin.get(r.origin_product_no) ?? null

  // 송장 반영(공통) — 발견 시 SHIPPED + pending. 이미 입력된 송장(어드민 수동)은 덮지 않는다.
  async function applyTracking(row, t) {
    const upd = { supplier_order_status: t.status, supplier_last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    if (t.cancelLike) { upd.needs_attention = true; upd.attention_reason = `매입처 ${t.status}` }
    if (t.actualPaid && !row.purchase_total_cost) upd.purchase_total_cost = t.actualPaid
    const inv = normalizeTracking(t.invoiceRaw)
    if (inv && !t.cancelLike) {
      upd.supplier_invoice_number = t.invoiceRaw
      upd.supplier_carrier_name = t.carrier
      if (!row.supplier_shipped_at) upd.supplier_shipped_at = new Date().toISOString()
      if (!row.tracking_number) { upd.tracking_number = inv; upd.delivery_company = t.carrier ?? row.delivery_company ?? null }
      upd.purchase_status = 'SHIPPED'
      upd.naver_dispatch_status = 'pending'
      upd.naver_dispatch_error = null
    }
    tracked++
    if (DRY) { console.log(`  [dry] ${row.product_order_id} 매입처 ${t.status ?? '?'} 송장 ${inv ?? '-'} ${t.carrier ?? ''}`); return }
    const { error: e } = await sb.from(TABLE).update(upd).eq('id', row.id)
    if (e) noteError(`추적 기록 실패 ${row.product_order_id}: ${e.message}`)
    else if (inv && !t.cancelLike) console.log(`  송장 감지 ${row.product_order_id}: ${t.carrier ?? '택배사?'} ${inv} → 발송처리 대기`)
  }

  // 어드민에서 송장을 이미 넣었는데 발송처리 대기로 안 넘어간 건(개편 전 입력분) → 바로 pending
  for (const row of targets.filter((r) => r.tracking_number)) {
    if (DRY) { console.log(`  [dry] ${row.product_order_id} 수동 송장 → pending`); continue }
    await sb.from(TABLE).update({ naver_dispatch_status: 'pending', purchase_status: 'SHIPPED', updated_at: new Date().toISOString() }).eq('id', row.id)
  }
  const pendingTrack = targets.filter((r) => !r.tracking_number)
  const ggsanRows = pendingTrack.filter((r) => sourceOf(r) === 'ggsan')
  const upickRows = pendingTrack.filter((r) => sourceOf(r) === 'upickb2b')
  const skipped = pendingTrack.length - ggsanRows.length - upickRows.length
  console.log(`  추적 대상: 건강산 ${ggsanRows.length} · 유픽 ${upickRows.length}${skipped ? ` · 자동추적 미지원 매입처 ${skipped}` : ''}`)

  if (ggsanRows.length) {
    try {
      const gg = createGgsanSession(env)
      await gg.login()
      for (const row of ggsanRows) {
        if (Date.now() - t0 > DEADLINE_MS) { console.log('  deadline — 남은 건 다음 회차'); break }
        try { await applyTracking(row, await gg.fetchOrder(row.supplier_order_no)) } catch (e) { noteError(`건강산 추적 실패 ${row.supplier_order_no}: ${e.message}`) }
        await sleep(300)
      }
    } catch (e) { noteError(`건강산 로그인 실패 — 추적 스킵: ${e.message}`) }
  }
  if (upickRows.length && Date.now() - t0 < DEADLINE_MS) {
    try {
      const { withUpickSession, fetchUpickOrder } = await import('./lib/upick-tracking.mjs')
      await withUpickSession(env, async (page, base) => {
        for (const row of upickRows) {
          if (Date.now() - t0 > DEADLINE_MS) { console.log('  deadline — 남은 건 다음 회차'); break }
          try {
            const u = await fetchUpickOrder(page, base, row.supplier_order_no)
            if (!u.found) { console.log(`  유픽 주문 없음 ${row.supplier_order_no}`); continue }
            await applyTracking(row, u)
          } catch (e) {
            if (/session expired/.test(e.message)) throw e
            noteError(`유픽 추적 실패 ${row.supplier_order_no}: ${e.message}`)
          }
          await sleep(300)
        }
      })
    } catch (e) { noteError(`유픽 세션 실패 — 추적 스킵: ${e.message}`) }
  }
}

// ── ⑤ 네이버 발송처리 ──
{
  const { data: rows } = await sb.from(TABLE).select('product_order_id, tracking_number, delivery_company, naver_dispatch_status')
    .in('naver_dispatch_status', ['pending', 'failed']).lt('naver_dispatch_attempts', 5).limit(50)
  for (const r of rows ?? []) {
    if (DRY) { console.log(`  [dry] 발송처리 대상 ${r.product_order_id} ${r.delivery_company ?? '?'} ${r.tracking_number ?? '?'} (${r.naver_dispatch_status})`); continue }
    try {
      const d = await ops.dispatch(r.product_order_id)
      if (d.ok) dispatchOk++; else dispatchErr++
      console.log(`  발송처리 ${r.product_order_id}: ${d.ok ? '✓' : '✗'} ${d.detail}`)
    } catch (e) { dispatchErr++; noteError(`발송처리 오류 ${r.product_order_id}: ${e.message}`) }
    await sleep(300)
  }
}

// ── ⑥ runs ──
const duration = Date.now() - t0
console.log(`[naver-orders-sync] ${errors ? 'partial' : 'ok'} 변경 ${totalFetched} · 반영 ${totalUpserted} · 재조회 ${refreshed} · 추적 ${tracked} · 발송 ✓${dispatchOk}/✗${dispatchErr} · 오류 ${errors} (${(duration / 1000).toFixed(1)}s)${DRY ? ' [DRY]' : ''}`)
if (runId) {
  await sb.from('jimscanner_naver_orders_sync_runs').update({
    status: errors > 0 && totalUpserted === 0 && refreshed === 0 ? 'error' : errors > 0 ? 'partial' : 'ok',
    finished_at: new Date().toISOString(),
    total_fetched: totalFetched,
    upserted_count: totalUpserted,
    refreshed_count: refreshed,
    tracked_count: tracked,
    dispatch_ok: dispatchOk,
    dispatch_err: dispatchErr,
    error_count: errors,
    duration_ms: duration,
    error_message: lastError ? lastError.slice(0, 500) : null,
  }).eq('id', runId)
}
process.exit(0) // Playwright 등 잔여 핸들로 작업 스케줄러가 안 끝나는 것 방지 — 상태는 runs 테이블이 진실
