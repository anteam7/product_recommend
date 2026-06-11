/**
 * 로컬 cron — ggsan ↔ 쿠팡 송장 동기화 (Phase 2)
 *
 * canon: docs/plan-ggsan-coupang-invoice-sync.md ④(발송 동기화 크론) / ②(상태머신) / ⑤(반자동 토글) / ⑨(안전장치).
 *
 * Windows 작업 "Coupang-Ggsan-Sync" 로 매시간 실행 (orders-sync +30분 오프셋, 실패 격리를 위해 별도 작업).
 *
 * 흐름:
 *   ① runs insert(running) + invoice_settings.auto_upload 읽기
 *   ② ggsan 로그인 (실패 시 그 회차 전체 중단 + runs=error, 쿠팡 호출 안 함 → 데이터 무손상)
 *   ③ 대상 = orders where coupang_invoice_status in (none,pending,acknowledged,failed)
 *            and purchase_status in (ORDERED,SHIPPED) and ggsan_order_no is not null
 *   ④ 각 대상(최대 100, 5분 deadline, 300ms 간격): order_view 파싱
 *        → 항상 ggsan_order_status + ggsan_last_checked_at 갱신
 *        → 취소/반품/교환 → needs_attention (자동취소 금지)
 *        → 입금대기 & ordered_at+24h 경과 → needs_attention='미결제 지연'
 *        → 실결제액 있고 purchase_total_cost 비었으면 → ggsan_actual_paid + purchase_total_cost 자동기록
 *        → data-invoice-no 있으면(발송): SHIPPED + 송장 + 택배사 + shipped_at + coupang_invoice_status='pending'
 *           그 후 auto_upload=true 면 프로덕션 register-invoice 라우트 호출(Bearer CRON_SECRET)
 *           auto_upload=false 면 호출 안 함(pending 유지 — 사람이 UI에서 [확인·등록])
 *   ⑤ ggsan_order_no 없는 ORDERED + 24h 경과도 needs_attention 카운트(사각지대 가시화)
 *   ⑥ runs update(success, 집계)
 *
 * 멱등: 이미 SHIPPED + 동일 송장이면 재처리 skip.
 * 송장등록 단일 진실 소스 = POST /api/admin/coupang-orders/register-invoice (이 크론은 트리거만).
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

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

const APP_BASE_URL = env.APP_BASE_URL || 'https://product-recommend-nine.vercel.app'
const CRON_SECRET = env.CRON_SECRET
const GGSAN_BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const GGSAN_USER = env.GGSAN_USER
const GGSAN_PASS = env.GGSAN_PASS
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const MAX_TARGETS = 100
const DEADLINE_MS = 5 * 60 * 1000 // 5분 가드
const STEP_DELAY_MS = 300
const PAID_WAIT_HOURS = 24 // 입금대기 / 미캡처 ORDERED 지연 임계
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── 택배사 sno → name 매핑 (canon: CJ대한통운만 확정. 그 외 null → needs_attention) ───
const CARRIER_SNO_TO_NAME = { '8': 'CJ대한통운' }

// ─── ggsan 로그인 + 쿠키 (coupang-stock-sync/route.ts 패턴 포팅) ───
const cookies = new Map()
function setCookies(setCookieHeader) {
  if (!setCookieHeader) return
  for (const part of setCookieHeader.split(/,(?=[^;]+=)/)) {
    const [kv] = part.split(';')
    const [k, v] = kv.trim().split('=')
    if (k && v !== undefined) cookies.set(k, v)
  }
}
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

async function ggsanFetch(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) },
  })
  setCookies(res.headers.get('set-cookie'))
  return res
}

async function ggsanLogin() {
  cookies.clear()
  await ggsanFetch(`${GGSAN_BASE}/member/login.php`)
  const r = await ggsanFetch(`${GGSAN_BASE}/member/login_ps.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${GGSAN_BASE}/member/login.php` },
    body: new URLSearchParams({ loginId: GGSAN_USER, loginPwd: GGSAN_PASS, saveId: 'y', returnUrl: `${GGSAN_BASE}/main/index.php` }).toString(),
  })
  const html = await r.text()
  // 성공판정: 로그인 성공 시 parent.location 리다이렉트 마커. (coupang-stock-sync 패턴과 동일)
  if (!/parent\.location\.href='https:\/\/www\.ggsan\.com\/main\/index\.php'/.test(html)) {
    throw new Error('ggsan login failed')
  }
}

// ─── order_view 파싱 (canon: 확정된 셀렉터) ───
// 샘플: _tmp_ggsan_order_view_shipped.html(배송중+송장), _tmp_ggsan_order_view.html(입금대기)
// order-name 뒤 첫 <em> = 상태 셀(권위 소스). '결제완료'가 빠져 있어 본문 폴백이 액션버튼
// (구매확정/취소/반품/교환)을 상태로 오인하던 버그 수정(2026-06-04): 실제 상태어 보강 + 폴백 제한.
const ORDER_STATUS_KEYWORDS = ['입금대기', '결제완료', '상품준비중', '배송준비중', '배송지시', '배송중', '배송완료', '구매확정', '취소', '반품', '교환']
// em 부재 시 폴백 — 버튼으로 항상 존재하는 구매확정/취소/반품/교환은 제외(오인 차단), 진행상태어만 본문 스캔.
const FALLBACK_SAFE_STATUSES = ['입금대기', '결제완료', '상품준비중', '배송준비중', '배송지시', '배송중', '배송완료']
const CANCEL_LIKE = new Set(['취소', '반품', '교환'])

function parseOrderView(html) {
  // 송장번호 / 택배사 sno: .js_btn_delivery_trace 요소의 data 속성
  const invMatch = /data-invoice-no=["']([^"']+)/.exec(html)
  const snoMatch = /data-invoice-company-sno=["']([^"']+)/.exec(html)
  const invoiceNo = invMatch ? invMatch[1].trim() : null
  const carrierSno = snoMatch ? snoMatch[1].trim() : null

  // 주문상태: order-name td 뒤 td 의 <em> 텍스트. 알려진 상태 키워드만 채택(오탐 방지).
  let orderStatus = null
  // order-name td 이후 영역으로 범위를 좁혀 메뉴/안내문구 오탐을 줄인다.
  const afterName = html.includes('order-name') ? html.slice(html.indexOf('order-name')) : html
  const emMatch = afterName.match(/<em>\s*([^<]+?)\s*<\/em>/)
  if (emMatch) {
    const t = emMatch[1].replace(/\s+/g, '')
    if (ORDER_STATUS_KEYWORDS.includes(t)) orderStatus = t
  }
  if (!orderStatus) {
    // 폴백(em 부재 시): 액션버튼 오인 방지 위해 '안전 상태어'로만 본문 스캔. 구매확정/취소/반품/교환 제외.
    for (const kw of FALLBACK_SAFE_STATUSES) {
      if (afterName.includes(kw)) { orderStatus = kw; break }
    }
  }

  // 수령인: <td class="order-name"> 이름 </td>
  const nameMatch = /class=["']order-name["']\s*>\s*([^<]+?)\s*<\/td>/.exec(html)
  const receiverName = nameMatch ? nameMatch[1].trim() : null

  // 실결제액(best-effort): <strong class="total_pay_money">25,500원</strong>
  const payMatch = /class=["']total_pay_money["']\s*>\s*([\d,]+)\s*원/.exec(html)
  const actualPaid = payMatch ? parseInt(payMatch[1].replace(/,/g, ''), 10) : null

  return { invoiceNo, carrierSno, orderStatus, receiverName, actualPaid }
}

async function fetchOrderView(orderNo) {
  const r = await ggsanFetch(`${GGSAN_BASE}/mypage/order_view.php?orderNo=${encodeURIComponent(orderNo)}`)
  if (!r.ok && r.status !== 200) return { html: null, status: r.status }
  const html = await r.text()
  return { html, status: r.status }
}

// ─── register-invoice 라우트 호출 (auto_upload=true 일 때만) ───
async function callRegisterInvoice(id) {
  const res = await fetch(`${APP_BASE_URL}/api/admin/coupang-orders/register-invoice`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRON_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const t = await res.text()
  let body
  try { body = JSON.parse(t) } catch { body = t }
  return { status: res.status, body }
}

// ════════ 메인 ════════
const t0 = Date.now()
const deadlineAt = t0 + DEADLINE_MS
const nowIso = () => new Date().toISOString()

// ① runs insert(running) + auto_upload 읽기
let runId = null
try {
  const { data: rr } = await sb
    .from('jimscanner_coupang_ggsan_sync_runs')
    .insert({ status: 'running', triggered_by: 'local-cron' })
    .select('id')
    .single()
  runId = rr?.id
} catch { /* 테이블 미생성 시 스킵 */ }

let autoUpload = false
try {
  const { data: settings } = await sb
    .from('jimscanner_coupang_invoice_settings')
    .select('auto_upload')
    .eq('id', 1)
    .single()
  autoUpload = !!settings?.auto_upload
} catch { autoUpload = false }

// 집계
let tracked = 0, shipped = 0, invoiceOk = 0, duplicate = 0, invoiceErr = 0, attention = 0, errors = 0

async function finish(status, errorMessage = null) {
  if (runId) {
    try {
      await sb.from('jimscanner_coupang_ggsan_sync_runs').update({
        finished_at: nowIso(),
        status,
        tracked_count: tracked,
        shipped_count: shipped,
        invoice_ok_count: invoiceOk,
        duplicate_count: duplicate,
        invoice_err_count: invoiceErr,
        attention_count: attention,
        error_count: errors,
        duration_ms: Date.now() - t0,
        error_message: errorMessage,
      }).eq('id', runId)
    } catch { /* noop */ }
  }
  console.log(`[local-cron-ggsan-sync] ${status} auto_upload=${autoUpload} tracked=${tracked} shipped=${shipped} invoice_ok=${invoiceOk} dup=${duplicate} invoice_err=${invoiceErr} attention=${attention} errors=${errors} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
}

// ② ggsan 로그인 (실패 시 회차 전체 중단 — 쿠팡 호출 안 함, 데이터 무손상)
try {
  await ggsanLogin()
} catch (e) {
  await finish('error', `ggsan login: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

try {
  // ③ 대상 조회
  const { data: rows, error: selErr } = await sb
    .from('jimscanner_coupang_orders')
    .select('id, order_id, ggsan_order_no, purchase_status, coupang_invoice_status, ggsan_invoice_number, ggsan_carrier_name, purchase_total_cost, receiver_name, purchase_ordered_at, needs_attention')
    .in('coupang_invoice_status', ['none', 'pending', 'acknowledged', 'failed'])
    .in('purchase_status', ['ORDERED', 'SHIPPED'])
    .not('ggsan_order_no', 'is', null)
    .limit(MAX_TARGETS)
  if (selErr) throw new Error(`select: ${selErr.message}`)

  // 유픽B2B(Cafe24) 주문번호(YYYYMMDD-NNNNNNN, 하이픈 포함)는 ggsan 추적 대상 아님 — 형식으로 식별해 제외.
  // (유픽 송장은 수동 입력 → register-invoice. ggsan_order_no 컬럼을 매입처 공용 주문번호로 겸용)
  const targets = (rows ?? []).filter((r) => /^\d{10,18}$/.test(String(r.ggsan_order_no)))
  const skippedNonGgsan = (rows ?? []).length - targets.length
  if (skippedNonGgsan > 0) console.log(`  비-ggsan 주문번호 ${skippedNonGgsan}건 제외 (유픽 등 — 송장 수동 입력 대상)`)

  for (const row of targets) {
    if (Date.now() > deadlineAt) { console.log('  deadline reached — 남은 대상은 다음 회차'); break }
    tracked++
    try {
      const { html, status } = await fetchOrderView(row.ggsan_order_no)
      if (!html) {
        errors++
        console.log(`  order#${row.order_id} order_view HTTP ${status} — skip`)
        await sleep(STEP_DELAY_MS)
        continue
      }
      const parsed = parseOrderView(html)

      // 항상 갱신: ggsan_order_status + ggsan_last_checked_at
      const update = {
        ggsan_order_status: parsed.orderStatus,
        ggsan_last_checked_at: nowIso(),
      }
      let markAttention = false

      // ── 분기: 취소/반품/교환 (자동취소 금지, 사람 확인) ──
      if (parsed.orderStatus && CANCEL_LIKE.has(parsed.orderStatus)) {
        update.needs_attention = true
        update.attention_reason = `ggsan ${parsed.orderStatus} 감지 — 확인 필요`
        markAttention = !row.needs_attention
        await sb.from('jimscanner_coupang_orders').update(update).eq('id', row.id)
        if (markAttention) attention++
        await sleep(STEP_DELAY_MS)
        continue
      }

      // ── 입금대기 & 발주완료(purchase_ordered_at) + 24h 경과 → 미결제 지연 ──
      if (parsed.orderStatus === '입금대기') {
        const orderedTs = row.purchase_ordered_at ? new Date(row.purchase_ordered_at).getTime() : null
        if (orderedTs != null && Date.now() - orderedTs > PAID_WAIT_HOURS * 3600 * 1000) {
          update.needs_attention = true
          update.attention_reason = '미결제 지연'
          markAttention = !row.needs_attention
        }
      }

      // ── 실결제액 자동기록: purchase_total_cost 비었을 때만(수동값 우선) ──
      if (parsed.actualPaid != null && (row.purchase_total_cost == null || row.purchase_total_cost === 0)) {
        update.ggsan_actual_paid = parsed.actualPaid
        update.purchase_total_cost = parsed.actualPaid
      } else if (parsed.actualPaid != null) {
        update.ggsan_actual_paid = parsed.actualPaid
      }

      // ── 송장 감지(발송 신호) ──
      const hasInvoice = !!parsed.invoiceNo
      if (hasInvoice) {
        // 멱등: 이미 SHIPPED + 동일 송장이면 송장 관련 재처리 skip(상태/실결제액 갱신은 위에서 이미 반영)
        const sameInvoice = row.purchase_status === 'SHIPPED' && row.ggsan_invoice_number === parsed.invoiceNo
        if (!sameInvoice) {
          // 택배사 sno → name 매핑. CJ대한통운(8)만 확정, 그 외 null → needs_attention
          const carrierName = parsed.carrierSno != null ? (CARRIER_SNO_TO_NAME[parsed.carrierSno] ?? null) : null
          update.purchase_status = 'SHIPPED'
          update.ggsan_invoice_number = parsed.invoiceNo
          update.ggsan_carrier_name = carrierName
          update.ggsan_shipped_at = nowIso()
          update.coupang_invoice_status = 'pending'
          if (carrierName == null) {
            update.needs_attention = true
            update.attention_reason = `택배사 미매핑(sno ${parsed.carrierSno ?? 'X'})`
            markAttention = !row.needs_attention
          }
          shipped++
        }
      }

      await sb.from('jimscanner_coupang_orders').update(update).eq('id', row.id)
      if (markAttention) attention++

      // ── auto_upload=true 면 register-invoice 라우트 호출(반자동 OFF). false면 pending 유지 ──
      // 송장 매핑이 된(택배사 확정) 신규 발송 건만 자동등록 트리거. 미매핑은 라우트가 hard gate 로 abort 하므로 무의미.
      if (hasInvoice && autoUpload && update.coupang_invoice_status === 'pending' && update.ggsan_carrier_name) {
        try {
          const resp = await callRegisterInvoice(row.id)
          const b = resp.body
          const status = (b && typeof b === 'object' && b.coupang_invoice_status) || null
          if (status === 'uploaded') invoiceOk++
          else if (status === 'duplicate') { duplicate++; attention++ }
          else if (b && typeof b === 'object' && b.aborted) { invoiceErr++; attention++ }
          else if (b && typeof b === 'object' && b.ok === false) invoiceErr++
          else if (resp.status === 200 && b && typeof b === 'object' && b.ok) invoiceOk++
          else invoiceErr++
        } catch (e) {
          invoiceErr++
          console.log(`  order#${row.order_id} register-invoice error: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      await sleep(STEP_DELAY_MS)
    } catch (e) {
      errors++
      console.log(`  order#${row.order_id} error: ${e instanceof Error ? e.message : String(e)}`)
      await sleep(STEP_DELAY_MS)
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
      if (!o.needs_attention) {
        await sb.from('jimscanner_coupang_orders').update({
          needs_attention: true,
          attention_reason: 'ggsan 주문번호 미입력(추적 불가) — 입력 필요',
        }).eq('id', o.id)
        attention++
      }
    }
  } catch (e) {
    console.log(`  orphan scan error: ${e instanceof Error ? e.message : String(e)}`)
  }

  await finish('success')
  process.exit(0)
} catch (e) {
  await finish('error', e instanceof Error ? e.message : String(e))
  process.exit(1)
}
