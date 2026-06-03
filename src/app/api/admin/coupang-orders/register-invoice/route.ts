/**
 * 쿠팡 송장 자동등록 — 단일 진실 소스(single source of truth).
 *
 * 설계 캐논: docs/plan-ggsan-coupang-invoice-sync.md ⑤(쿠팡 송장등록) / ②(상태머신) / ⑨(안전장치).
 * Phase 1 범위: register-invoice 라우트(수동/버튼 호출). 크론(.mjs)은 Phase 2에서 auto_upload=true 일 때 이 라우트를 호출한다.
 *
 * 흐름(crash-safe, 검토 C-3):
 *   ① DB를 SHIPPED + coupang_invoice_status='pending' 로 먼저 커밋(아직 아니면)
 *   ② 쿠팡 acknowledgement PUT (상품준비중) — '이미 처리됨'은 멱등 통과
 *   ③ 쿠팡 invoices POST — 200 성공 시 RECEIVED + uploaded
 *   실패 시 SHIPPED + status='failed' 로 남아 다음 cron 이 재시도.
 *
 * 업로드 직전 HARD GATE 3개(돈 안전, 통과 못 하면 abort + needs_attention, 절대 등록 호출 안 함):
 *   ① 쿠팡 현재 shipping_status 가 취소/반품이면 abort('주문취소/반품')  — invoices 직전 ordersheet 단건 재조회
 *   ② 수령인 검증: receiver_name 존재 + ggsan_invoice_number 존재 필수(불충분하면 abort)
 *   ③ carrierToCode(ggsan_carrier_name)==null 이면 abort('택배사 미매핑')
 *
 * 인증: 어드민 세션(requireAdmin) **또는** Authorization: Bearer CRON_SECRET (coupang-stock-sync 패턴).
 */
import { NextResponse, type NextRequest } from 'next/server'
import crypto from 'node:crypto'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COUPANG_HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'

// ─── 택배사 매핑 (scripts/lib/coupang-carrier-map.mjs 의 캐논 미러) ───
// 라우트가 송장등록 단일 진실 소스이므로 매핑도 여기 인라인한다(scripts/*.mjs 는 src/ 에서 import 불가).
// ggsan 실관측 단일값 CJ대한통운=CJGLS 만 확정. 그 외는 null → 호출측 needs_attention='택배사 미매핑'.
const CARRIER_MAP: Record<string, string> = {
  CJ대한통운: 'CJGLS',
  CJGLS: 'CJGLS',
  CJ택배: 'CJGLS',
}
function carrierToCode(name: string | null | undefined): string | null {
  if (!name) return null
  const norm = String(name).replace(/\s+/g, '').replace(/[()（）[\]]/g, '')
  if (!norm) return null
  return CARRIER_MAP[norm] ?? null
}

// 쿠팡 현재 상태가 취소/반품이면 등록 abort (검토 D-1)
const CANCELLED_STATUSES = new Set(['CANCEL', 'CANCELLED', 'RETURNS', 'RETURN', 'EXCHANGE'])

// ─── HMAC 서명 (쿠팡, query 없음: dt+method+urlPath) ───
function signCoupang(method: string, urlPath: string) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const secret = process.env.COUPANG_SECRET_KEY!
  const signature = crypto.createHmac('sha256', secret).update(dt + method + urlPath).digest('hex')
  return { datetime: dt, signature }
}

async function coupangApi(method: string, urlPath: string, body: unknown = null) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const access = process.env.COUPANG_ACCESS_KEY!
  const res = await fetch(`${COUPANG_HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) as unknown } } catch { return { status: res.status, body: text as unknown } }
}

// ─── 인증: 어드민 세션 OR Bearer CRON_SECRET ───
async function authorize(request: NextRequest): Promise<{ ok: true; actor: string } | { ok: false }> {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return { ok: true, actor: 'cron' }
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (user && isAdminEmail(user.email)) return { ok: true, actor: user.email ?? 'admin' }
  return { ok: false }
}

interface OrderRow {
  id: string
  order_id: number
  order_item_id: number | null
  shipment_box_id: number | null
  vendor_item_id: number | null
  product_name: string | null
  shipping_status: string | null
  receiver_name: string | null
  purchase_status: string | null
  ggsan_invoice_number: string | null
  ggsan_carrier_name: string | null
  ggsan_shipped_at: string | null
  coupang_invoice_status: string | null
  coupang_invoice_attempts: number | null
}

const MAX_ATTEMPTS = 5

// 쿠팡 invoices 응답 파싱 — 확정 스펙(developers.coupangcorp.com 360033793014):
//   { responseCode, responseMessage, responseList:[{ shipmentBoxId, succeed, resultCode, retryRequired, resultMessage }] }
//   HTTP 200이어도 responseList[].succeed=false 면 부분실패(예 resultCode NOT_FOUND_SHIPMENT_BOX). 첫 라인 기준 판정.
interface InvoicesResult { succeed: boolean | null; resultCode: string; message: string; retryRequired: boolean }
function parseInvoicesResult(body: unknown): InvoicesResult {
  const b = body && typeof body === 'object'
    ? (body as { responseCode?: number; responseList?: Array<{ succeed?: boolean; resultCode?: string; resultMessage?: string; retryRequired?: boolean }> })
    : null
  const item = b && Array.isArray(b.responseList) ? b.responseList[0] : null
  if (item && typeof item.succeed === 'boolean') {
    return { succeed: item.succeed, resultCode: String(item.resultCode ?? ''), message: String(item.resultMessage ?? ''), retryRequired: !!item.retryRequired }
  }
  // 비표준/responseList 없음 → succeed 불명. 명백한 실패신호 텍스트 폴백.
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  if (/"succeed"\s*:\s*false|failResultMap|"resultCode"\s*:\s*"?FAIL|등록\s*실패/i.test(text)) {
    return { succeed: false, resultCode: 'FAIL', message: text.slice(0, 200), retryRequired: false }
  }
  return { succeed: null, resultCode: String(b?.responseCode ?? ''), message: text.slice(0, 200), retryRequired: false }
}
// "이미 등록/6개월 중복" 식별 (resultCode 우선, 메시지 폴백)
function isDuplicateInvoice(r: { resultCode: string; message: string }): boolean {
  return /ALREADY|DUP|EXIST/i.test(r.resultCode) || /이미.{0,4}등록|중복.{0,4}(송장|운송장|등록)|6개월|already.{0,12}(register|exist)|duplicate/i.test(r.message)
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request)
  if (!auth.ok) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { id?: string; order_id?: number | string }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const { id, order_id } = body
  if (!id && order_id === undefined) return NextResponse.json({ error: 'id 또는 order_id 누락' }, { status: 400 })

  const vendorId = process.env.COUPANG_VENDOR_ID
  if (!vendorId) return NextResponse.json({ error: 'COUPANG_VENDOR_ID 미설정' }, { status: 500 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const SELECT = 'id, order_id, order_item_id, shipment_box_id, vendor_item_id, product_name, shipping_status, receiver_name, purchase_status, ggsan_invoice_number, ggsan_carrier_name, ggsan_shipped_at, coupang_invoice_status, coupang_invoice_attempts'

  let query = admin.from('jimscanner_coupang_orders').select(SELECT)
  query = id ? query.eq('id', id) : query.eq('order_id', Number(order_id))
  const { data: rows, error: e1 } = await query.limit(1)
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })
  if (!rows || rows.length === 0) return NextResponse.json({ error: '주문을 찾을 수 없음' }, { status: 404 })
  const order = rows[0] as OrderRow
  const now = () => new Date().toISOString()

  // ── 멱등 가드: 이미 완료 상태면 재호출 금지 ──
  const invStatus = order.coupang_invoice_status ?? 'none'
  if (invStatus === 'uploaded' || invStatus === 'duplicate' || invStatus === 'manual_done') {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'already_done',
      coupang_invoice_status: invStatus,
      message: `이미 처리됨(${invStatus})`,
    })
  }

  // ── 재시도 상한 가드 ──
  if ((order.coupang_invoice_attempts ?? 0) >= MAX_ATTEMPTS) {
    await admin.from('jimscanner_coupang_orders').update({
      needs_attention: true,
      attention_reason: '등록실패(재시도 상한)',
    }).eq('id', order.id)
    return NextResponse.json({
      ok: false,
      aborted: true,
      reason: 'max_attempts',
      message: `자동등록 재시도 상한(${MAX_ATTEMPTS}) 도달 — 사람 확인 필요`,
    }, { status: 200 })
  }

  // ── abort 헬퍼: needs_attention 세팅 + 200 JSON 으로 사유 반환(등록 호출 안 함) ──
  async function abort(reason: string, extra: Record<string, unknown> = {}) {
    await admin.from('jimscanner_coupang_orders').update({
      needs_attention: true,
      attention_reason: reason,
    }).eq('id', order.id)
    return NextResponse.json({ ok: false, aborted: true, reason, ...extra }, { status: 200 })
  }

  // ════════ HARD GATE ② 수령인/송장 존재 (검토 B-3, Phase1: 별도 수령인 저장 전이라 존재성만 검증) ════════
  if (!order.receiver_name) return abort('수령인 정보 없음')
  if (!order.ggsan_invoice_number) return abort('매입처 송장번호 없음')

  // ════════ HARD GATE ③ 택배사 매핑 (검토 C-6) ════════
  const code = carrierToCode(order.ggsan_carrier_name)
  if (code == null) return abort('택배사 미매핑')

  // ════════ HARD GATE ① 쿠팡 현재 상태 취소/반품 재조회 (검토 D-1) ════════
  if (order.shipment_box_id == null) return abort('shipmentBoxId 없음')
  const reqVendorItemId = order.vendor_item_id
  if (reqVendorItemId == null) return abort('vendorItemId 없음')

  // 1차: 우리 DB 상태로 취소/반품 차단
  if (order.shipping_status && CANCELLED_STATUSES.has(String(order.shipping_status).toUpperCase())) {
    return abort('주문취소/반품', { coupang_status: order.shipping_status })
  }
  // 2차(fail-closed, 검토 🔴 D-1): 등록 직전 쿠팡 단건 재조회. 비-200이거나 상태 파싱 실패면 등록 보류 — 취소 오등록 방지.
  const sheetPath = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/${order.shipment_box_id}`
  const sheetResp = await coupangApi('GET', sheetPath)
  if (sheetResp.status !== 200) {
    // 일시 오류일 수 있어 needs_attention 은 띄우지 않고 보류 — 다음 cron 이 재조회 회복 후 재시도(attempts 증가 안 함)
    return NextResponse.json({ ok: false, deferred: true, reason: '쿠팡 주문상태 재조회 실패 — 등록 보류', coupang_status_check: sheetResp.status }, { status: 200 })
  }
  const sheet = (sheetResp.body as { data?: { status?: string } | Array<{ status?: string }> })?.data
  const sheetStatus = Array.isArray(sheet) ? sheet[0]?.status : sheet?.status
  if (!sheetStatus) return abort('쿠팡 주문상태 확인 불가(파싱 실패) — 안전상 보류')
  if (CANCELLED_STATUSES.has(String(sheetStatus).toUpperCase())) return abort('주문취소/반품', { coupang_status: sheetStatus })

  // ════════ STEP ① DB 를 SHIPPED + pending 으로 먼저 커밋(crash-safe) ════════
  const preUpdate: Record<string, unknown> = { last_synced_at: now() }
  if (order.purchase_status !== 'SHIPPED' && order.purchase_status !== 'RECEIVED') preUpdate.purchase_status = 'SHIPPED'
  if (invStatus !== 'pending' && invStatus !== 'acknowledged') preUpdate.coupang_invoice_status = 'pending'
  await admin.from('jimscanner_coupang_orders').update(preUpdate).eq('id', order.id)

  // ════════ STEP ② acknowledgement (상품준비중) ════════
  // 이미 처리된(=상품준비중 이후) 박스는 에러를 반환할 수 있으므로 멱등 통과시킨다(검토 C-1: 응답으로 구분).
  const ackPath = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/acknowledgement`
  const ackResp = await coupangApi('PUT', ackPath, { vendorId, shipmentBoxIds: [order.shipment_box_id] })
  const ackText = typeof ackResp.body === 'string' ? ackResp.body : JSON.stringify(ackResp.body ?? '')
  const ackOk = ackResp.status === 200
  const ackAlreadyDone = !ackOk && /이미.{0,8}(처리|확인|준비)|상품준비중|출고지시|already.{0,12}(process|acknowledg|done)/i.test(ackText)
  if (!ackOk && !ackAlreadyDone) {
    // ack 실패(미처리 사유) → SHIPPED + failed 로 남김, 재시도 대상
    await admin.from('jimscanner_coupang_orders').update({
      coupang_invoice_status: 'failed',
      coupang_invoice_error: `ack HTTP ${ackResp.status}: ${ackText.slice(0, 300)}`,
      coupang_invoice_attempts: (order.coupang_invoice_attempts ?? 0) + 1,
      last_synced_at: now(),
    }).eq('id', order.id)
    return NextResponse.json({
      ok: false,
      reason: 'acknowledgement_failed',
      status: ackResp.status,
      detail: ackText.slice(0, 300),
    }, { status: 200 })
  }
  await admin.from('jimscanner_coupang_orders').update({
    coupang_invoice_status: 'acknowledged',
    coupang_acknowledged_at: now(),
    last_synced_at: now(),
  }).eq('id', order.id)

  // ════════ STEP ③ invoices (송장등록) ════════
  const invPath = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/orders/invoices`
  const invBody = {
    vendorId,
    orderSheetInvoiceApplyDtos: [{
      shipmentBoxId: order.shipment_box_id,
      orderId: order.order_id,
      vendorItemId: reqVendorItemId,
      deliveryCompanyCode: code,
      invoiceNumber: order.ggsan_invoice_number,
      splitShipping: false,
      preSplitShipped: false,
      estimatedShippingDate: '',
    }],
  }
  const invResp = await coupangApi('POST', invPath, invBody)
  const invText = typeof invResp.body === 'string' ? invResp.body : JSON.stringify(invResp.body ?? '')
  const invResult = parseInvoicesResult(invResp.body)

  if (invResp.status === 200 && invResult.succeed === true) {
    // 성공 → RECEIVED + uploaded + 미러 컬럼 복사
    const uploadedAt = now()
    await admin.from('jimscanner_coupang_orders').update({
      coupang_invoice_status: 'uploaded',
      purchase_status: 'RECEIVED',
      coupang_invoice_uploaded_at: uploadedAt,
      coupang_invoice_company_code: code,
      coupang_invoice_error: null,
      purchase_received_at: uploadedAt,
      // 기존 InvoiceCell 경로와 호환되는 미러 컬럼
      invoice_number: order.ggsan_invoice_number,
      delivery_company: order.ggsan_carrier_name,
      shipped_at: order.ggsan_shipped_at ?? uploadedAt,
      last_synced_at: uploadedAt,
    }).eq('id', order.id)
    await logAdminAction({
      actor: auth.actor,
      action: 'coupang_invoice_register',
      target_type: 'coupang_order',
      target_id: order.id,
      summary: `주문#${order.order_id} 송장등록 성공 ${code} ${order.ggsan_invoice_number} (${(order.product_name ?? '').slice(0, 24)})`,
      metadata: { code, invoice: order.ggsan_invoice_number },
    })
    return NextResponse.json({
      ok: true,
      coupang_invoice_status: 'uploaded',
      purchase_status: 'RECEIVED',
      delivery_company_code: code,
      invoice_number: order.ggsan_invoice_number,
    })
  }

  if (isDuplicateInvoice(invResult)) {
    // 6개월내 중복/이미 등록 → 성공 간주하되 약한 needs_attention(오매칭 은폐 방지, 검토 C-4)
    const uploadedAt = now()
    await admin.from('jimscanner_coupang_orders').update({
      coupang_invoice_status: 'duplicate',
      purchase_status: 'RECEIVED',
      coupang_invoice_uploaded_at: uploadedAt,
      coupang_invoice_company_code: code,
      needs_attention: true,
      attention_reason: '송장중복(6개월/이미등록) — 매칭 확인',
      invoice_number: order.ggsan_invoice_number,
      delivery_company: order.ggsan_carrier_name,
      shipped_at: order.ggsan_shipped_at ?? uploadedAt,
      last_synced_at: uploadedAt,
    }).eq('id', order.id)
    await logAdminAction({
      actor: auth.actor,
      action: 'coupang_invoice_register',
      target_type: 'coupang_order',
      target_id: order.id,
      summary: `주문#${order.order_id} 송장 중복(기등록) ${order.ggsan_invoice_number}`,
      metadata: { code, invoice: order.ggsan_invoice_number, duplicate: true },
    })
    return NextResponse.json({
      ok: true,
      coupang_invoice_status: 'duplicate',
      needs_attention: true,
      message: '중복 송장 — 기등록으로 간주(확인 필요)',
    })
  }

  // 응답형식 미확인(succeed 불명) + HTTP 200 + 실패/중복 신호 없음 → 등록됐을 가능성. uploaded 로 두되 Wing 확인 플래그.
  if (invResp.status === 200 && invResult.succeed === null) {
    const uploadedAt = now()
    await admin.from('jimscanner_coupang_orders').update({
      coupang_invoice_status: 'uploaded',
      purchase_status: 'RECEIVED',
      coupang_invoice_uploaded_at: uploadedAt,
      coupang_invoice_company_code: code,
      needs_attention: true,
      attention_reason: '쿠팡 등록응답 형식 미확인 — Wing에서 등록 확인 요망',
      invoice_number: order.ggsan_invoice_number,
      delivery_company: order.ggsan_carrier_name,
      shipped_at: order.ggsan_shipped_at ?? uploadedAt,
      last_synced_at: uploadedAt,
    }).eq('id', order.id)
    return NextResponse.json({ ok: true, coupang_invoice_status: 'uploaded', needs_attention: true, message: '등록 응답형식 미확인 — Wing 확인 요망' })
  }

  // 그 외 실패 → failed + error + attempts++ (SHIPPED 유지, 다음 cron 재시도)
  const attempts = (order.coupang_invoice_attempts ?? 0) + 1
  const failUpdate: Record<string, unknown> = {
    coupang_invoice_status: 'failed',
    coupang_invoice_error: `invoices HTTP ${invResp.status}: ${invText.slice(0, 300)}`,
    coupang_invoice_attempts: attempts,
    last_synced_at: now(),
  }
  if (attempts >= MAX_ATTEMPTS) {
    failUpdate.needs_attention = true
    failUpdate.attention_reason = '등록실패(재시도 상한)'
  }
  await admin.from('jimscanner_coupang_orders').update(failUpdate).eq('id', order.id)
  return NextResponse.json({
    ok: false,
    reason: 'invoices_failed',
    status: invResp.status,
    detail: invText.slice(0, 300),
    coupang_invoice_status: 'failed',
    attempts,
  }, { status: 200 })
}
