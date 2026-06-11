import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'
import crypto from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── 쿠팡 acknowledgement(상품준비중 처리): 발주완료 시 결제완료(ACCEPT)→상품준비중(INSTRUCT) 자동전환 ───
// register-invoice STEP② 의 ack 패턴 미러. best-effort — 실패해도 발주완료 저장은 막지 않는다.
const COUPANG_HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'
const ACK_OR_LATER = new Set(['INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY'])

function signCoupang(method: string, urlPath: string) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const signature = crypto.createHmac('sha256', process.env.COUPANG_SECRET_KEY!).update(dt + method + urlPath).digest('hex')
  return { datetime: dt, signature }
}
async function coupangAcknowledge(vendorId: string, shipmentBoxId: number): Promise<{ ok: boolean; status: number; detail: string }> {
  const urlPath = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/acknowledgement`
  const { datetime, signature } = signCoupang('PUT', urlPath)
  const res = await fetch(`${COUPANG_HOST}${urlPath}`, {
    method: 'PUT',
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${process.env.COUPANG_ACCESS_KEY!}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({ vendorId, shipmentBoxIds: [shipmentBoxId] }),
  })
  const text = await res.text()
  // HTTP 200 또는 '이미 처리됨'(상품준비중 이후 재호출) 멱등 통과
  const alreadyDone = /이미.{0,8}(처리|확인|준비)|상품준비중|출고지시|already.{0,12}(process|acknowledg|done)/i.test(text)
  return { ok: res.status === 200 || alreadyDone, status: res.status, detail: text.slice(0, 200) }
}

const PURCHASE_STATUSES = ['PENDING', 'ORDERED', 'SHIPPED', 'RECEIVED', 'CANCELLED'] as const
type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

interface OrderRow {
  id: string
  order_id: number
  product_name: string | null
  shipping_count: number | null
  purchase_status: string
  purchase_unit_cost: number | null
  purchase_ordered_at: string | null
  purchase_received_at: string | null
  shipped_at: string | null
  shipment_box_id: number | null
  shipping_status: string | null
}

/**
 * 주문↔매입 행의 발주 정보 수정.
 * body: { id, purchase_status?, purchase_unit_cost?, purchase_note? }
 *   - purchase_status: 상태 전이 시 발주/입고 시각 자동 스탬프
 *   - purchase_unit_cost: 매입 단가 → purchase_total_cost(= 단가 × 수량) 자동 계산
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { id?: string; purchase_status?: string; purchase_unit_cost?: unknown; purchase_total_cost?: unknown; purchase_note?: string; delivery_company?: string; invoice_number?: string; ggsan_order_no?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const { id } = body
  if (!id) return NextResponse.json({ error: 'id 누락' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  // 주의: purchase_shipping_cost 컬럼이 아직 없을 수 있어 SELECT에 넣지 않음(있어도 없어도 동작).
  // 운송비 저장은 아래 update 시도에서만 컬럼을 건드리며, 미적용이면 그 저장만 실패한다.
  const { data: row, error: e1 } = await admin
    .from('jimscanner_coupang_orders')
    .select('id, order_id, product_name, shipping_count, purchase_status, purchase_unit_cost, purchase_ordered_at, purchase_received_at, shipped_at, shipment_box_id, shipping_status')
    .eq('id', id)
    .single()
  if (e1 || !row) return NextResponse.json({ error: '주문을 찾을 수 없음' }, { status: 404 })
  const order = row as OrderRow

  const update: Record<string, unknown> = { last_synced_at: new Date().toISOString() }
  const now = new Date().toISOString()
  const changes: string[] = []

  // 1) 발주 상태
  if (body.purchase_status !== undefined) {
    const ps = body.purchase_status as PurchaseStatus
    if (!PURCHASE_STATUSES.includes(ps)) return NextResponse.json({ error: '잘못된 발주 상태' }, { status: 400 })
    update.purchase_status = ps
    // 상태 전이 시각 자동 스탬프 (이미 찍힌 건 유지)
    if (ps === 'ORDERED' && !order.purchase_ordered_at) update.purchase_ordered_at = now
    // SHIPPED(매입처발송): 발주 시각이 비었으면 채움. 송장/쿠팡등록은 ggsan cron / register-invoice 소관.
    if (ps === 'SHIPPED' && !order.purchase_ordered_at) update.purchase_ordered_at = now
    if (ps === 'RECEIVED') {
      if (!order.purchase_ordered_at) update.purchase_ordered_at = now
      if (!order.purchase_received_at) update.purchase_received_at = now
    }
    changes.push(`상태 ${order.purchase_status}→${ps}`)
  }

  // 2) 매입 원가: 상품가(purchase_unit_cost) + 합계(purchase_total_cost = 상품가×수량 + 운송비).
  //    운송비는 별도 컬럼 없이 합계에 녹여 저장(운송비 = 합계 − 상품가×수량). 클라이언트가 둘 다 전송.
  if (body.purchase_unit_cost !== undefined) {
    const unit = Math.round(Number(body.purchase_unit_cost))
    if (!Number.isFinite(unit) || unit < 0) return NextResponse.json({ error: '매입 상품가가 올바르지 않음' }, { status: 400 })
    update.purchase_unit_cost = unit
    changes.push(`상품가 ${unit.toLocaleString()}`)
  }
  if (body.purchase_total_cost !== undefined) {
    const total = Math.round(Number(body.purchase_total_cost))
    if (!Number.isFinite(total) || total < 0) return NextResponse.json({ error: '매입 합계가 올바르지 않음' }, { status: 400 })
    update.purchase_total_cost = total
    changes.push(`매입합계 ${total.toLocaleString()}`)
  }

  // 3) 메모
  if (body.purchase_note !== undefined) {
    update.purchase_note = String(body.purchase_note).slice(0, 500)
    changes.push('메모')
  }

  // 3.5) 매입처 발주(주문)번호 — 수동입력만(자동캡처/휴리스틱 없음). 매칭 린치핀.
  //      ggsan: 숫자 10~18자리 / 유픽B2B(Cafe24): YYYYMMDD-NNNNNNN. 저장 시 ggsan_match_method='manual'.
  //      유픽 번호(하이픈 포함)는 ggsan 송장추적 크론이 형식으로 식별해 건너뜀(추적은 ggsan만).
  if (body.ggsan_order_no !== undefined) {
    const raw = String(body.ggsan_order_no).replace(/\s/g, '')
    if (raw === '') {
      update.ggsan_order_no = null
      update.ggsan_match_method = null
      changes.push('매입처 주문번호 해제')
    } else {
      if (!/^\d{10,18}$/.test(raw) && !/^\d{8}-\d{6,9}$/.test(raw)) {
        return NextResponse.json({ error: '주문번호 형식 오류 — ggsan: 숫자 10~18자리 / 유픽: 20260612-0000123 형식' }, { status: 400 })
      }
      update.ggsan_order_no = raw
      update.ggsan_match_method = 'manual'
      changes.push(`매입처 주문번호 ${raw}`)
    }
  }

  // 4) 송장 / 발송 추적 — 쿠팡 API 등록이 아니라 내부 기록만 (운송장은 Wing에서 직접 등록)
  const hasCompany = body.delivery_company !== undefined
  const hasInvoice = body.invoice_number !== undefined
  if (hasCompany || hasInvoice) {
    if (hasCompany) update.delivery_company = String(body.delivery_company).trim().slice(0, 40) || null
    let invoiceVal: string | null = null
    if (hasInvoice) {
      invoiceVal = String(body.invoice_number).replace(/\s/g, '').slice(0, 40) || null
      update.invoice_number = invoiceVal
    }
    // 송장번호가 채워지면 = 발송 처리: 발송시각 + 발주상태 '발송완료'(RECEIVED) 자동 (취소건 제외)
    if (invoiceVal) {
      if (!order.shipped_at) update.shipped_at = now
      // SHIPPED 제외: ggsan cron 이 매입처발송으로 만든 건은 수동 송장입력으로 RECEIVED 직행 금지(검토 C-2).
      // 쿠팡 송장등록(register-invoice)이 성공해야만 RECEIVED 로 전이된다.
      if (order.purchase_status !== 'CANCELLED' && order.purchase_status !== 'RECEIVED' && order.purchase_status !== 'SHIPPED') {
        update.purchase_status = 'RECEIVED'
        if (!order.purchase_ordered_at) update.purchase_ordered_at = now
        if (!order.purchase_received_at) update.purchase_received_at = now
      }
    }
    changes.push(`송장 ${invoiceVal ?? '(삭제)'}${hasCompany && update.delivery_company ? ` ${update.delivery_company}` : ''}`)
  }

  if (changes.length === 0) return NextResponse.json({ error: '변경 내용 없음' }, { status: 400 })

  const { error } = await admin.from('jimscanner_coupang_orders').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── 발주완료(ORDERED) 전환 시: 쿠팡 결제완료→상품준비중 자동 처리(acknowledgement) ──
  // best-effort. 이미 상품준비중 이후면 skip. 실패해도 위 발주완료 저장은 유지(롤백 안 함).
  let ack: { done: boolean; skipped?: boolean; reason?: string } | undefined
  if (body.purchase_status === 'ORDERED') {
    const vendorId = process.env.COUPANG_VENDOR_ID
    const shippingUpper = String(order.shipping_status ?? '').toUpperCase()
    if (!vendorId || order.shipment_box_id == null) {
      ack = { done: false, reason: !vendorId ? 'VENDOR_ID 미설정' : 'shipmentBoxId 없음' }
    } else if (ACK_OR_LATER.has(shippingUpper)) {
      ack = { done: false, skipped: true, reason: `이미 상품준비중 이후(${order.shipping_status})` }
    } else {
      try {
        const r = await coupangAcknowledge(vendorId, order.shipment_box_id)
        if (r.ok) {
          // 낙관적 반영(다음 orders-sync 가 쿠팡 실값으로 재확인). UI 즉시 갱신용.
          await admin.from('jimscanner_coupang_orders').update({ shipping_status: 'INSTRUCT', last_synced_at: new Date().toISOString() }).eq('id', id)
          ack = { done: true }
          changes.push('쿠팡 상품준비중 처리')
        } else {
          ack = { done: false, reason: `ack HTTP ${r.status}: ${r.detail}` }
        }
      } catch (e) {
        ack = { done: false, reason: e instanceof Error ? e.message : String(e) }
      }
    }
  }

  await logAdminAction({
    actor: user.email,
    action: 'coupang_order_purchase_update',
    target_type: 'coupang_order',
    target_id: id,
    summary: `주문#${order.order_id} ${changes.join(', ')} (${(order.product_name ?? '').slice(0, 24)})`,
    metadata: { ...update },
  })
  revalidatePath('/admin/coupang-orders')
  return NextResponse.json({
    ok: true,
    purchase_status: update.purchase_status ?? order.purchase_status,
    purchase_unit_cost: update.purchase_unit_cost ?? order.purchase_unit_cost,
    purchase_total_cost: update.purchase_total_cost,
    purchase_ordered_at: update.purchase_ordered_at,
    purchase_received_at: update.purchase_received_at,
    delivery_company: update.delivery_company,
    invoice_number: update.invoice_number,
    shipped_at: update.shipped_at,
    ggsan_order_no: update.ggsan_order_no,
    ack,
  })
}
