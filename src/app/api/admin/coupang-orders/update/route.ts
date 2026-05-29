import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PURCHASE_STATUSES = ['PENDING', 'ORDERED', 'RECEIVED', 'CANCELLED'] as const
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
  purchase_shipping_cost: number | null
  purchase_ordered_at: string | null
  purchase_received_at: string | null
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

  let body: { id?: string; purchase_status?: string; purchase_unit_cost?: unknown; purchase_shipping_cost?: unknown; purchase_note?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const { id } = body
  if (!id) return NextResponse.json({ error: 'id 누락' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  // 주의: purchase_shipping_cost 컬럼이 아직 없을 수 있어 SELECT에 넣지 않음(있어도 없어도 동작).
  // 운송비 저장은 아래 update 시도에서만 컬럼을 건드리며, 미적용이면 그 저장만 실패한다.
  const { data: row, error: e1 } = await admin
    .from('jimscanner_coupang_orders')
    .select('id, order_id, product_name, shipping_count, purchase_status, purchase_unit_cost, purchase_ordered_at, purchase_received_at')
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
    if (ps === 'RECEIVED') {
      if (!order.purchase_ordered_at) update.purchase_ordered_at = now
      if (!order.purchase_received_at) update.purchase_received_at = now
    }
    changes.push(`상태 ${order.purchase_status}→${ps}`)
  }

  // 2) 매입 상품가 / 운송비 → 합계 자동 (= 상품가 × 수량 + 운송비)
  const hasUnit = body.purchase_unit_cost !== undefined
  const hasShip = body.purchase_shipping_cost !== undefined
  if (hasUnit || hasShip) {
    const qty = order.shipping_count ?? 1
    let unit = order.purchase_unit_cost ?? 0
    let ship = order.purchase_shipping_cost ?? 0
    if (hasUnit) {
      unit = Math.round(Number(body.purchase_unit_cost))
      if (!Number.isFinite(unit) || unit < 0) return NextResponse.json({ error: '매입 상품가가 올바르지 않음' }, { status: 400 })
      update.purchase_unit_cost = unit
    }
    if (hasShip) {
      ship = Math.round(Number(body.purchase_shipping_cost))
      if (!Number.isFinite(ship) || ship < 0) return NextResponse.json({ error: '매입 운송비가 올바르지 않음' }, { status: 400 })
      update.purchase_shipping_cost = ship
    }
    update.purchase_total_cost = unit * qty + ship
    changes.push(`매입 상품가 ${unit.toLocaleString()}×${qty} + 운송 ${ship.toLocaleString()} = ${(unit * qty + ship).toLocaleString()}`)
  }

  // 3) 메모
  if (body.purchase_note !== undefined) {
    update.purchase_note = String(body.purchase_note).slice(0, 500)
    changes.push('메모')
  }

  if (changes.length === 0) return NextResponse.json({ error: '변경 내용 없음' }, { status: 400 })

  const { error } = await admin.from('jimscanner_coupang_orders').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

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
    purchase_shipping_cost: update.purchase_shipping_cost ?? order.purchase_shipping_cost,
    purchase_total_cost: update.purchase_total_cost,
    purchase_ordered_at: update.purchase_ordered_at,
    purchase_received_at: update.purchase_received_at,
  })
}
