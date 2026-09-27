import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 쿠팡 update 라우트 미러 — 발주완료(ORDERED) 전환 시 네이버 발주확인, 송장 입력 시 네이버 발송처리.
// 네이버 커머스 API는 IP 허용목록제라 Vercel(여기)에서 직접 부르면 GW.IP_NOT_ALLOWED 로 막힌다
// (2026-09-26 발주확인 5건 전부 실패). 그래서 쿠팡과 똑같이 jimscanner_purchase_jobs 에 잡만 넣고
// 집 PC order-server 폴러(3초)가 scripts/lib/naver-order-ops.mjs 로 실행한다(2026-09-27).

const PURCHASE_STATUSES = ['PENDING', 'AWAITING_DEPOSIT', 'ORDERED', 'SHIPPED', 'RECEIVED', 'CANCELLED'] as const
type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

interface OrderRow {
  id: string
  product_order_id: string
  order_id: string | null
  product_name: string | null
  quantity: number | null
  purchase_status: string
  purchase_unit_cost: number | null
  purchase_ordered_at: string | null
  purchase_received_at: string | null
  shipped_at: string | null
  place_order_status: string | null
  product_order_status: string | null
  naver_dispatch_status: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any
/** 집 PC 큐 잡 등록 — 같은 주문·같은 종류가 대기/실행 중이면 그 잡을 재사용 */
async function enqueueJob(admin: Admin, orderKey: string, mode: 'naver_confirm' | 'naver_dispatch', email: string | undefined) {
  const { data: dup } = await admin.from('jimscanner_purchase_jobs')
    .select('id').eq('order_key', orderKey).eq('mode', mode).in('status', ['queued', 'running']).limit(1)
  if (dup?.length) return { queued: true, job_id: dup[0].id as number }
  const { data: job, error } = await admin.from('jimscanner_purchase_jobs')
    .insert({ order_key: orderKey, mode, requested_by: email ?? null }).select('id').single()
  return error ? { queued: false, reason: `잡 등록 실패: ${error.message}` } : { queued: true, job_id: job.id as number }
}

/**
 * 네이버 주문↔매입 행의 발주 정보 수정.
 * body: { id, purchase_status?, purchase_unit_cost?, purchase_total_cost?, purchase_note?, supplier_order_no?, delivery_company?, tracking_number? }
 *   - purchase_status: 상태 전이 시 발주/발송 시각 자동 스탬프. ORDERED 전환 시 네이버 발주확인 잡 등록
 *   - tracking_number: 매입처발송(SHIPPED) + naver_dispatch_status='pending' + 네이버 발송처리 잡 등록.
 *     발송완료(RECEIVED)는 네이버 발송처리가 성공했을 때만(쿠팡과 동일). 매입처 송장은 매시 크론이 자동 수집한다.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: {
    id?: string
    purchase_status?: string
    purchase_unit_cost?: unknown
    purchase_total_cost?: unknown
    purchase_note?: string
    supplier_order_no?: string
    delivery_company?: string
    tracking_number?: string
  }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const { id } = body
  if (!id) return NextResponse.json({ error: 'id 누락' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const { data: row, error: e1 } = await admin
    .from('jimscanner_naver_orders')
    .select('id, product_order_id, order_id, product_name, quantity, purchase_status, purchase_unit_cost, purchase_ordered_at, purchase_received_at, shipped_at, place_order_status, product_order_status, naver_dispatch_status')
    .eq('id', id)
    .single()
  if (e1 || !row) return NextResponse.json({ error: '주문을 찾을 수 없음' }, { status: 404 })
  const order = row as OrderRow

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const now = new Date().toISOString()
  const changes: string[] = []

  // 1) 발주 상태 (시각 자동 스탬프 — 쿠팡과 동일 전이 규칙)
  if (body.purchase_status !== undefined) {
    const ps = body.purchase_status as PurchaseStatus
    if (!PURCHASE_STATUSES.includes(ps)) return NextResponse.json({ error: '잘못된 발주 상태' }, { status: 400 })
    update.purchase_status = ps
    // AWAITING_DEPOSIT(입금대기) = 매입처 주문은 생성됨(무통장) → 발주 시각 스탬프
    if (ps === 'AWAITING_DEPOSIT' && !order.purchase_ordered_at) update.purchase_ordered_at = now
    if (ps === 'ORDERED' && !order.purchase_ordered_at) update.purchase_ordered_at = now
    if (ps === 'SHIPPED' && !order.purchase_ordered_at) update.purchase_ordered_at = now
    if (ps === 'RECEIVED') {
      if (!order.purchase_ordered_at) update.purchase_ordered_at = now
      if (!order.purchase_received_at) update.purchase_received_at = now
    }
    changes.push(`상태 ${order.purchase_status}→${ps}`)
  }

  // 2) 매입 원가 (합계 = 상품가×수량 + 운송비. 운송비는 합계에 녹여 저장 — 쿠팡과 동일)
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

  // 4) 매입처 주문번호 — ggsan: 숫자 10~18자리 / 유픽B2B(Cafe24): YYYYMMDD-NNNNNNN
  if (body.supplier_order_no !== undefined) {
    const raw = String(body.supplier_order_no).replace(/\s/g, '')
    if (raw === '') {
      update.supplier_order_no = null
      changes.push('매입처 주문번호 해제')
    } else {
      if (!/^\d{10,18}$/.test(raw) && !/^\d{8}-\d{6,9}$/.test(raw)) {
        return NextResponse.json({ error: '주문번호 형식 오류 — ggsan: 숫자 10~18자리 / 유픽: 20260612-0000123 형식' }, { status: 400 })
      }
      update.supplier_order_no = raw
      changes.push(`매입처 주문번호 ${raw}`)
    }
  }

  // 5) 송장 — 매입처발송(SHIPPED) + 네이버 발송처리 대기(pending). 발송완료(RECEIVED)는 네이버 발송처리 성공 시에만.
  const hasCompany = body.delivery_company !== undefined
  const hasTracking = body.tracking_number !== undefined
  let dispatchQueued = false
  if (hasCompany || hasTracking) {
    if (hasCompany) update.delivery_company = String(body.delivery_company).trim().slice(0, 40) || null
    let trackingVal: string | null = null
    if (hasTracking) {
      trackingVal = String(body.tracking_number).replace(/\s/g, '').slice(0, 40) || null
      update.tracking_number = trackingVal
    }
    const dispatchDone = ['registered', 'manual_done'].includes(order.naver_dispatch_status ?? 'none')
    if (trackingVal && order.purchase_status !== 'CANCELLED' && !dispatchDone) {
      update.purchase_status = 'SHIPPED'
      update.naver_dispatch_status = 'pending'
      update.naver_dispatch_error = null
      update.naver_dispatch_attempts = 0
      if (!order.purchase_ordered_at) update.purchase_ordered_at = now
      dispatchQueued = true
    }
    changes.push(`송장 ${trackingVal ?? '(삭제)'}${hasCompany && update.delivery_company ? ` ${update.delivery_company}` : ''}`)
  }

  if (changes.length === 0) return NextResponse.json({ error: '변경 내용 없음' }, { status: 400 })

  const { error } = await admin.from('jimscanner_naver_orders').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── 발주완료(ORDERED) 전환 시: 네이버 발주확인 잡 등록(집 PC 실행). 실패해도 발주완료 저장은 유지.
  //    잡이 실패하거나 헬퍼가 꺼져 있어도 매시 크론의 발주확인 스윕이 다시 시도한다.
  let confirm: { done: boolean; queued?: boolean; job_id?: number; skipped?: boolean; reason?: string } | undefined
  if (body.purchase_status === 'ORDERED') {
    if (order.place_order_status === 'OK') {
      confirm = { done: false, skipped: true, reason: '이미 발주확인됨' }
    } else if (order.product_order_status && order.product_order_status !== 'PAYED') {
      confirm = { done: false, skipped: true, reason: `발주확인 불가 상태(${order.product_order_status})` }
    } else {
      const q = await enqueueJob(admin, order.product_order_id, 'naver_confirm', user.email)
      confirm = { done: false, ...q }
      if (q.queued) changes.push(`네이버 발주확인 잡#${q.job_id}`)
    }
  }
  // ── 송장 입력 시: 네이버 발송처리 잡 등록(집 PC 실행 — 네이버 실상태 재조회 게이트 후 발송)
  let dispatch: { queued: boolean; job_id?: number; reason?: string } | undefined
  if (dispatchQueued) {
    dispatch = await enqueueJob(admin, order.product_order_id, 'naver_dispatch', user.email)
    if (dispatch.queued) changes.push(`네이버 발송처리 잡#${dispatch.job_id}`)
  }

  await logAdminAction({
    actor: user.email,
    action: 'naver_order_purchase_update',
    target_type: 'naver_order',
    target_id: id,
    summary: `주문#${order.product_order_id} ${changes.join(', ')} (${(order.product_name ?? '').slice(0, 24)})`,
    metadata: { ...update },
  })
  revalidatePath('/admin/naver-orders')
  return NextResponse.json({
    ok: true,
    purchase_status: update.purchase_status ?? order.purchase_status,
    purchase_unit_cost: update.purchase_unit_cost ?? order.purchase_unit_cost,
    purchase_total_cost: update.purchase_total_cost,
    supplier_order_no: update.supplier_order_no,
    delivery_company: update.delivery_company,
    tracking_number: update.tracking_number,
    shipped_at: update.shipped_at,
    naver_dispatch_status: update.naver_dispatch_status,
    confirm,
    dispatch,
  })
}
