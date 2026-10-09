/**
 * 로컬 cron — 매입처 주문 추적(입금확인 · 송장) ↔ 쿠팡 발주확인 · 송장등록 동기화
 *   node scripts/local-cron-ggsan-sync.mjs [--dry]      --dry: 갱신 내용만 출력(DB·쿠팡 호출 없음)
 *
 * 구조(2026-10-09 리팩터): 매입처마다 루프를 복사하던 구조(건강산·유픽·77bio·Cafe24·고도몰 5벌)를
 *   **TRACKERS 등록표 + 공통 루프 하나**로 통합. 매입처별로 다른 건 "어떻게 로그인하고 주문상세를 어떻게 읽나"뿐이고
 *   (scripts/lib/*-tracking.mjs 어댑터가 {found, status, cancelLike, invoiceRaw, carrier, actualPaid} 로 정규화해 돌려준다),
 *   읽은 뒤의 처리(취소 감지 → 입금확인 → 미결제 지연 → 실결제액 → 송장 감지 → 발송처리 → 쿠팡 등록)는 trackRow() 한 곳.
 *   매입처 추가 = 같은 플랫폼이면 TRACKERS 한 줄(화장품스토리), 새 플랫폼이면 어댑터 파일 하나 + 한 줄.
 *
 * 이력: 2026-08-20 유픽(Cafe24) 추적 + 쿠팡 등록 로컬 직접 실행(Vercel IP 차단) + 재시도 스윕 + 송장 정규화
 *       2026-09-02 77bio(고도몰) + 매입처 판별을 listings.source(+supplier_source 오버라이드)로(주문번호 자릿수 추측 폐기)
 *       2026-09-27 웰루트·K홀세일(AuthSSL Cafe24) 공통 어댑터
 *       2026-10-09 화장품스토리(고도몰, 건강산 계정 공유) + **입금확인 싱크**(무통장 완주 AWAITING_DEPOSIT → 매입처가 입금대기를 벗어나면
 *                  ORDERED + 쿠팡 발주확인; depositSync 매입처만) + --dry
 *
 * canon: docs/plan-ggsan-coupang-invoice-sync.md ④(발송 동기화 크론) / ②(상태머신) / ⑤(반자동 토글) / ⑨(안전장치).
 * Windows 작업 "Coupang-Ggsan-Sync" 로 매시간 실행 (orders-sync +30분 오프셋, 실패 격리를 위해 별도 작업).
 *
 * 흐름:
 *   ① runs insert(running) + invoice_settings.auto_upload 읽기
 *   ② 대상 = orders where coupang_invoice_status in (none,pending,acknowledged,failed)
 *            and purchase_status in (AWAITING_DEPOSIT,ORDERED,SHIPPED) and ggsan_order_no is not null
 *            → listings.source(+supplier_source 오버라이드)로 매입처 분기(AWAITING_DEPOSIT 은 depositSync 매입처만)
 *   ③ 매입처별 세션 1회 → 각 대상(최대 100, 5분 deadline, 300ms 간격) trackRow():
 *        → 항상 ggsan_order_status + ggsan_last_checked_at 갱신(ggsan_* 컬럼은 매입처 공용 저장소)
 *        → 취소/반품/교환 → needs_attention (자동취소 금지)
 *        → AWAITING_DEPOSIT 이고 매입처 상태가 결제완료/상품준비중… → ORDERED + 쿠팡 발주확인(ACCEPT→INSTRUCT)
 *        → 입금대기 & ordered_at+24h 경과 → needs_attention='미결제 지연'
 *        → 실결제액 있고 purchase_total_cost 비었으면 → ggsan_actual_paid + purchase_total_cost 자동기록
 *        → 송장 있으면(발송): SHIPPED + 송장 + 택배사 + shipped_at + coupang_invoice_status='pending'
 *           그 후 auto_upload=true 면 쿠팡 송장등록 로컬 실행(scripts/lib/coupang-invoice.mjs), false 면 pending 유지(사람이 UI에서 [확인·등록])
 *   ④ 재시도 스윕(송장은 있는데 쿠팡 등록이 pending/failed 로 고착된 건)
 *   ⑤ ggsan_order_no 없는 ORDERED + 24h 경과도 needs_attention(사각지대 가시화)
 *   ⑥ runs update(success/error, 집계)
 *
 * 멱등: 이미 SHIPPED + 동일 송장이면 재처리 skip. 송장등록 단일 진실 소스 = scripts/lib/coupang-invoice.mjs registerInvoice.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createCoupangInvoiceOps, normalizeInvoiceNo } from './lib/coupang-invoice.mjs'
import { withUpickSession, fetchUpickOrder } from './lib/upick-tracking.mjs'
import { withBio77Session, fetchBio77Order } from './lib/bio77-tracking.mjs'
import { withCafe24Session, fetchCafe24Order } from './lib/cafe24-tracking.mjs'
import { createGgsanSession } from './lib/ggsan-tracking.mjs'

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

const MAX_TARGETS = 100
const DEADLINE_MS = 5 * 60 * 1000 // 5분 가드
const STEP_DELAY_MS = 300
const PAID_WAIT_HOURS = 24 // 입금대기 / 미캡처 ORDERED 지연 임계
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

// 입금확인 신호 — 무통장 완주(AWAITING_DEPOSIT) 뒤 매입처가 입금을 확인하면 상태가 입금대기를 벗어난다(고도몰 상태어 기준)
const PAID_LIKE = new Set(['결제완료', '상품준비중', '배송준비중', '배송지시', '배송중', '배송완료', '구매확정'])

// ─── 매입처 등록표 — with(env, fn): 세션 1회 열고 fn(fetchOrder) 실행. fetchOrder(orderNo) → {found, status, cancelLike, invoiceRaw, carrier, carrierSno?, actualPaid?}
//     depositSync: 무통장 완주(AWAITING_DEPOSIT) 주문도 추적해 입금확인 → ORDERED + 쿠팡 발주확인(상태어가 PAID_LIKE 어휘인 고도몰만 켠다)
//     ⚠ 새 매입처: 같은 플랫폼이면 한 줄 추가, 새 플랫폼이면 lib/<x>-tracking.mjs 어댑터 + 한 줄. order-server.mjs RUN_FLOWS · local-cron-stock-sync.mjs SUPPLIERS 와 같은 방식.
async function withGodomall(envLike, fn) {
  const s = createGgsanSession(envLike)
  await s.login()
  await fn((no) => s.fetchOrder(no))
}
const cafe24 = (source, label, defaultBase, prefix) => ({
  source, label,
  with: (e, fn) => withCafe24Session({ base: e[`${prefix}_BASE_URL`] || defaultBase, user: e[`${prefix}_USER`], pass: e[`${prefix}_PASS`], label: source }, (page, base) => fn((no) => fetchCafe24Order(page, base, no, source))),
})
const TRACKERS = [
  { source: 'ggsan', label: '건강산', depositSync: true, with: (e, fn) => withGodomall(e, fn) },
  // 화장품스토리 = 건강산 화장품 서브몰(같은 고도몰·같은 회원 계정) — 호스트·계정만 바꿔 건강산 세션 재사용, CMTSTORY_* 없으면 GGSAN_* 폴백
  { source: 'cmtstory', label: '화장품스토리', depositSync: true, with: (e, fn) => withGodomall({ ...e, GGSAN_BASE_URL: e.CMTSTORY_BASE_URL || 'https://www.cmtstory.com', GGSAN_USER: e.CMTSTORY_USER || e.GGSAN_USER, GGSAN_PASS: e.CMTSTORY_PASS || e.GGSAN_PASS }, fn) },
  { source: 'upickb2b', label: '유픽', with: (e, fn) => withUpickSession(e, (page, base) => fn((no) => fetchUpickOrder(page, base, no))) },
  { source: 'bio77', label: '77bio', with: (e, fn) => withBio77Session(e, (page, base) => fn((no) => fetchBio77Order(page, base, no))) },
  cafe24('wellroot', '웰루트', 'https://wellrootb2b.com', 'WELLROOT'),       // 예치금 결제(입금대기 없음)
  cafe24('kwholesale', 'K홀세일', 'https://kwholesale.co.kr', 'KWHOLESALE'), // 무통장(입금 확인 후 출고) — 상태어가 고도몰과 달라 depositSync 미적용
]

// ─── 쿠팡 발주확인·송장등록(로컬 직접 실행, scripts/lib/coupang-invoice.mjs 공용) ───
const coupangOps = createCoupangInvoiceOps({ sb, env, log: (m) => console.log('  ' + m) })
const coupangAck = (orderId) => coupangOps.ackByOrderId(orderId).catch((e) => ({ ok: false, detail: e?.message || String(e) }))

// 집계
let tracked = 0, paidConfirmed = 0, shipped = 0, invoiceOk = 0, duplicate = 0, invoiceErr = 0, attention = 0, errors = 0
const sessionErrors = []

/** registerInvoice 결과를 집계 카운터에 반영. 반환: 결과 객체 */
async function registerLocal(id, label) {
  const r = await coupangOps.registerInvoice({ id })
  if (r.invoice_status === 'uploaded' || r.invoice_status === 'manual_done') invoiceOk++
  else if (r.invoice_status === 'duplicate') { duplicate++; attention++ }
  else if (r.aborted) { invoiceErr++; attention++ }
  else if (!r.ok) invoiceErr++
  else invoiceOk++
  console.log(`  ${label} register → ${r.invoice_status ?? (r.ok ? 'ok' : 'fail')}: ${r.detail}`)
  return r
}

async function writeOrder(row, update, tag) {
  if (DRY) { console.log(`  [dry] ${tag} ← ${JSON.stringify(update)}`); return }
  const { error } = await sb.from('jimscanner_coupang_orders').update(update).eq('id', row.id)
  if (error) throw new Error(`update: ${error.message}`)
}

// ─── 공통 처리 — 매입처 무관. 매입처가 다른 건 p(정규화된 주문상세)를 어떻게 얻었느냐뿐 ───
async function trackRow(t, row, p) {
  const tag = `${t.source}#${row.ggsan_order_no}`
  const update = { ggsan_order_status: p.status, ggsan_last_checked_at: nowIso() }
  let markAttention = false
  const flag = (reason) => { update.needs_attention = true; update.attention_reason = reason; if (!row.needs_attention) markAttention = true }

  if (!p.found) {
    errors++
    console.log(`  ${tag} 주문 상세 없음 — skip`)
    await writeOrder(row, update, tag)
    return
  }
  // 취소/반품/교환 → 사람 확인(자동취소 금지)
  if (p.cancelLike) {
    flag(`${t.label} ${p.status} 감지 — 확인 필요`)
    await writeOrder(row, update, tag)
    if (markAttention) attention++
    return
  }
  // 입금확인 싱크 — 무통장 완주 뒤 매입처가 입금을 확인하면 ORDERED(+ 아래에서 쿠팡 발주확인)
  let paid = false
  if (t.depositSync && row.purchase_status === 'AWAITING_DEPOSIT' && p.status && PAID_LIKE.has(p.status)) {
    update.purchase_status = 'ORDERED'
    paid = true
    paidConfirmed++
    console.log(`  ${tag} ${p.status} — 입금확인 → ORDERED`)
  }
  // 입금대기 & 발주 후 24h 경과 → 미결제 지연
  if (p.status === '입금대기') {
    const orderedTs = row.purchase_ordered_at ? new Date(row.purchase_ordered_at).getTime() : null
    if (orderedTs != null && Date.now() - orderedTs > PAID_WAIT_HOURS * 3600 * 1000) flag('미결제 지연')
  }
  // 실결제액: 수동값(purchase_total_cost) 우선, 비었을 때만 채움
  if (p.actualPaid != null) {
    update.ggsan_actual_paid = p.actualPaid
    if (row.purchase_total_cost == null || row.purchase_total_cost === 0) update.purchase_total_cost = p.actualPaid
  }
  // 송장 감지(발송 신호)
  const invoiceNo = normalizeInvoiceNo(p.invoiceRaw)
  let fresh = false
  if (invoiceNo) {
    const sameInvoice = row.purchase_status === 'SHIPPED' && row.ggsan_invoice_number === invoiceNo   // 멱등
    if (sameInvoice && !row.ggsan_carrier_name && p.carrier) {
      // 과거 택배사 미매핑으로 멈춘 건 — 매핑이 생기면 백필 + attention 해제
      update.ggsan_carrier_name = p.carrier
      if (/택배사 미(매핑|확인)/.test(row.attention_reason ?? '')) { update.needs_attention = false; update.attention_reason = null }
    }
    if (!sameInvoice) {
      update.purchase_status = 'SHIPPED'
      update.ggsan_invoice_number = invoiceNo
      update.ggsan_carrier_name = p.carrier   // 어댑터가 준 택배사명 그대로(CJ대한통운/한진택배…) → 쿠팡 등록 때 CARRIER_MAP 이 코드로 변환
      update.ggsan_shipped_at = nowIso()
      update.coupang_invoice_status = 'pending'
      if (!p.carrier) flag(`택배사 미확인(${t.label}${p.carrierSno != null ? `, sno ${p.carrierSno}` : ''})`)
      shipped++
      fresh = true
      console.log(`  ${tag} 발송 감지: ${p.carrier ?? '?'} ${invoiceNo}${p.invoiceRaw && p.invoiceRaw !== invoiceNo ? ` (원문 ${p.invoiceRaw})` : ''}`)
    }
  }
  await writeOrder(row, update, tag)
  if (markAttention) attention++
  if (paid && !DRY) {
    const ack = await coupangAck(row.order_id)
    console.log(`  order#${row.order_id} 쿠팡 발주확인 → ${ack.ok ? 'OK' : '실패'}: ${ack.detail}`)
  }
  // auto_upload=true 면 쿠팡 송장등록 로컬 실행(택배사 확정된 신규 발송 건만 — 미확인은 hard gate 로 abort 라 무의미)
  if (fresh && autoUpload && p.carrier && !DRY) await registerLocal(row.id, `order#${row.order_id}`)
}

// ════════ 메인 ════════
const t0 = Date.now()
const deadlineAt = t0 + DEADLINE_MS

// ① runs insert(running) + auto_upload 읽기
let runId = null
if (!DRY) {
  try {
    const { data: rr } = await sb.from('jimscanner_coupang_ggsan_sync_runs').insert({ status: 'running', triggered_by: 'local-cron' }).select('id').single()
    runId = rr?.id
  } catch { /* 테이블 미생성 시 스킵 */ }
}
let autoUpload = false
try {
  const { data: settings } = await sb.from('jimscanner_coupang_invoice_settings').select('auto_upload').eq('id', 1).single()
  autoUpload = !!settings?.auto_upload
} catch { autoUpload = false }

async function finish(status, errorMessage = null) {
  if (runId) {
    try {
      await sb.from('jimscanner_coupang_ggsan_sync_runs').update({
        finished_at: nowIso(), status,
        tracked_count: tracked, shipped_count: shipped, invoice_ok_count: invoiceOk, duplicate_count: duplicate,
        invoice_err_count: invoiceErr, attention_count: attention, error_count: errors,
        duration_ms: Date.now() - t0, error_message: errorMessage,
      }).eq('id', runId)
    } catch { /* noop */ }
  }
  console.log(`[local-cron-ggsan-sync] ${status}${DRY ? ' [DRY]' : ''} auto_upload=${autoUpload} tracked=${tracked} paid=${paidConfirmed} shipped=${shipped} invoice_ok=${invoiceOk} dup=${duplicate} invoice_err=${invoiceErr} attention=${attention} errors=${errors} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

try {
  // ② 대상 조회
  const { data: rows, error: selErr } = await sb
    .from('jimscanner_coupang_orders')
    .select('id, order_id, seller_product_id, supplier_source, supplier_goods_no, ggsan_order_no, purchase_status, coupang_invoice_status, ggsan_invoice_number, ggsan_carrier_name, purchase_total_cost, receiver_name, purchase_ordered_at, needs_attention, attention_reason')
    .in('coupang_invoice_status', ['none', 'pending', 'acknowledged', 'failed'])
    .in('purchase_status', ['AWAITING_DEPOSIT', 'ORDERED', 'SHIPPED'])
    .not('ggsan_order_no', 'is', null)
    .limit(MAX_TARGETS)
  if (selErr) throw new Error(`select: ${selErr.message}`)

  // 매입처 판별 = order-server.mjs resolveOrder()와 동일 규칙(오버라이드 우선 → listings.source 조인 → 미상이면 ggsan 간주).
  // ggsan_order_no 는 매입처 공용 주문번호 저장소라 자릿수로는 매입처를 구분할 수 없다(2026-09-02) — 반드시 실제 source 로 분기.
  const sellerProductIds = [...new Set((rows ?? []).filter((r) => !(r.supplier_source && r.supplier_goods_no) && r.seller_product_id != null).map((r) => r.seller_product_id))]
  const sourceBySellerProductId = new Map()
  if (sellerProductIds.length) {
    const { data: listings } = await sb.from('jimscanner_coupang_listings').select('seller_product_id, source').in('seller_product_id', sellerProductIds)
    for (const l of listings ?? []) if (l.source && !sourceBySellerProductId.has(l.seller_product_id)) sourceBySellerProductId.set(l.seller_product_id, l.source)
  }
  const resolveSource = (r) => (r.supplier_source && r.supplier_goods_no) ? r.supplier_source : (sourceBySellerProductId.get(r.seller_product_id) || 'ggsan')

  // 매입처별 대상 — AWAITING_DEPOSIT 은 depositSync 매입처만(나머지는 종전대로 ORDERED/SHIPPED)
  const targets = new Map(TRACKERS.map((t) => [t.source, (rows ?? []).filter((r) => resolveSource(r) === t.source && (t.depositSync || r.purchase_status !== 'AWAITING_DEPOSIT'))]))
  const covered = [...targets.values()].reduce((n, l) => n + l.length, 0)
  const awaitingSkipped = (rows ?? []).filter((r) => r.purchase_status === 'AWAITING_DEPOSIT' && !TRACKERS.find((t) => t.source === resolveSource(r))?.depositSync).length
  // 등록표 밖 매입처(도매꾹·비셀러 등)는 자동추적 미지원 — 조용히 빠지지 않게 건수만이라도 남긴다
  const untracked = (rows ?? []).length - covered - awaitingSkipped
  console.log(`  대상: ${TRACKERS.map((t) => `${t.label} ${targets.get(t.source).length}건`).join(', ')}${untracked > 0 ? `, 자동추적 미지원 ${untracked}건` : ''}`)

  // ③ 매입처별 세션 1회 → 공통 처리
  for (const t of TRACKERS) {
    const list = targets.get(t.source)
    if (!list.length) continue
    if (Date.now() > deadlineAt) { console.log(`  deadline reached — ${t.label} 은 다음 회차`); continue }
    try {
      await t.with(env, async (fetchOrder) => {
        for (const row of list) {
          if (Date.now() > deadlineAt) { console.log(`  deadline reached — 남은 ${t.label} 대상은 다음 회차`); break }
          tracked++
          try {
            await trackRow(t, row, await fetchOrder(row.ggsan_order_no))
          } catch (e) {
            if (/session expired|login failed/.test(String(e?.message))) throw e   // 세션 문제는 매입처째 중단
            errors++
            console.log(`  ${t.source}#${row.ggsan_order_no} error: ${e instanceof Error ? e.message : String(e)}`)
          }
          await sleep(STEP_DELAY_MS)
        }
      })
    } catch (e) {
      // 로그인/세션 실패 → 그 매입처만 건너뛰고 회차는 error 로 기록(다른 매입처·스윕은 계속, 쿠팡 호출 없음 → 데이터 무손상)
      errors++
      const msg = `${t.label} session: ${e instanceof Error ? e.message : String(e)}`
      sessionErrors.push(msg)
      console.log(`  ${msg} — ${t.label} 추적 건너뜀`)
    }
  }

  // ④ 재시도 스윕 — 송장은 있는데 쿠팡 등록이 pending/failed 로 고착된 건(과거 Vercel 호출 실패분 포함).
  //    쿠팡이 이미 배송지시 이후(Wing 수동등록)면 registerInvoice 가 API 호출 없이 manual_done 으로 동기화한다.
  if (autoUpload && !DRY && Date.now() < deadlineAt) {
    try {
      const { data: stuck } = await sb
        .from('jimscanner_coupang_orders')
        .select('id, order_id, ggsan_invoice_number, invoice_number, coupang_invoice_attempts')
        .eq('purchase_status', 'SHIPPED')
        .in('coupang_invoice_status', ['pending', 'acknowledged', 'failed'])
        .lt('coupang_invoice_attempts', 5)
        .limit(30)
      const retry = (stuck ?? []).filter((r) => r.ggsan_invoice_number || r.invoice_number)
      if (retry.length) console.log(`  재시도 스윕 ${retry.length}건`)
      for (const r of retry) {
        if (Date.now() > deadlineAt) break
        await registerLocal(r.id, `order#${r.order_id}(retry)`)
        await sleep(STEP_DELAY_MS)
      }
    } catch (e) {
      console.log(`  retry sweep error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ⑤ ggsan_order_no 없는 ORDERED + 24h 경과 → 사각지대 가시화(needs_attention)
  try {
    const cutoffIso = new Date(Date.now() - PAID_WAIT_HOURS * 3600 * 1000).toISOString()
    const { data: orphans } = await sb
      .from('jimscanner_coupang_orders')
      .select('id, needs_attention')
      .eq('purchase_status', 'ORDERED')
      .is('ggsan_order_no', null)
      .lt('purchase_ordered_at', cutoffIso)
    for (const o of (orphans ?? [])) {
      if (o.needs_attention) continue
      if (DRY) { console.log(`  [dry] orphan ${o.id} ← 매입처 주문번호 미입력`); continue }
      await sb.from('jimscanner_coupang_orders').update({ needs_attention: true, attention_reason: '매입처 주문번호 미입력(추적 불가) — 입력 필요' }).eq('id', o.id)
      attention++
    }
  } catch (e) {
    console.log(`  orphan scan error: ${e instanceof Error ? e.message : String(e)}`)
  }

  await finish(sessionErrors.length ? 'error' : 'success', sessionErrors.length ? sessionErrors.join(' | ') : null)
  process.exit(0)
} catch (e) {
  await finish('error', e instanceof Error ? e.message : String(e))
  process.exit(1)
}
