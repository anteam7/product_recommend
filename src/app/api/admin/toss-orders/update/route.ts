import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 네이버 update 라우트 미러 — 토스는 IP 허용제라 Vercel에서 토스 API를 못 부른다.
// 발주확인(PREPARING_PRODUCT)·송장 등록은 로컬 크론(local-cron-toss-orders-sync.mjs)이 수행하고,
// 이 라우트는 매입 추적 컬럼의 DB 기록만 담당한다.

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
  order_product_id: number
  product_name: string | null
  purchase_status: string
  purchase_ordered_at: string | null
  ggsan_order_no: string | null
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 403 })

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const id = typeof body.id === 'string' ? body.id : null
  if (!id) return NextResponse.json({ error: 'id 필요' }, { status: 400 })

  const admin = createAdminClient() as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data: order, error: selErr } = (await admin.from('jimscanner_toss_orders')
    .select('id, order_product_id, product_name, purchase_status, purchase_ordered_at, ggsan_order_no')
    .eq('id', id).maybeSingle()) as { data: OrderRow | null; error: { message: string } | null }
  if (selErr) return NextResponse.json({ error: `조회 실패: ${selErr.message}` }, { status: 500 })
  if (!order) return NextResponse.json({ error: '주문 없음' }, { status: 404 })

  const now = new Date().toISOString()
  const update: Record<string, unknown> = { updated_at: now }
  const changes: string[] = []

  if (body.purchase_status !== undefined) {
    const ps = body.purchase_status as PurchaseStatus
    if (!PURCHASE_STATUSES.includes(ps)) return NextResponse.json({ error: '잘못된 발주 상태' }, { status: 400 })
    update.purchase_status = ps
    if (['AWAITING_DEPOSIT', 'ORDERED', 'SHIPPED', 'RECEIVED'].includes(ps) && !order.purchase_ordered_at) update.purchase_ordered_at = now
    changes.push(`상태 ${order.purchase_status}→${ps}`)
  }

  if (body.purchase_unit_cost !== undefined) {
    if (typeof body.purchase_unit_cost !== 'number' && typeof body.purchase_unit_cost !== 'string') return NextResponse.json({ error: '매입 상품가가 올바르지 않음' }, { status: 400 })
    const unit = Math.round(Number(body.purchase_unit_cost))
    if (!Number.isFinite(unit) || unit < 0) return NextResponse.json({ error: '매입 상품가가 올바르지 않음' }, { status: 400 })
    update.purchase_unit_cost = unit
    changes.push(`상품가 ${unit.toLocaleString()}`)
  }
  if (body.purchase_total_cost !== undefined) {
    if (typeof body.purchase_total_cost !== 'number' && typeof body.purchase_total_cost !== 'string') return NextResponse.json({ error: '매입 합계가 올바르지 않음' }, { status: 400 })
    const total = Math.round(Number(body.purchase_total_cost))
    if (!Number.isFinite(total) || total < 0) return NextResponse.json({ error: '매입 합계가 올바르지 않음' }, { status: 400 })
    update.purchase_total_cost = total
    changes.push(`매입합계 ${total.toLocaleString()}`)
  }

  if (body.purchase_note !== undefined) {
    update.purchase_note = String(body.purchase_note).slice(0, 500)
    changes.push('메모')
  }

  // 매입처 주문번호 — ggsan: 숫자 10~18자리 / 유픽B2B(Cafe24): YYYYMMDD-NNNNNNN
  if (body.ggsan_order_no !== undefined) {
    const raw = String(body.ggsan_order_no).replace(/\s/g, '')
    if (raw === '') {
      update.ggsan_order_no = null
      changes.push('매입처 주문번호 해제')
    } else {
      if (!/^\d{10,18}$/.test(raw) && !/^\d{8}-\d{6,9}$/.test(raw)) {
        return NextResponse.json({ error: '주문번호 형식 오류 — ggsan: 숫자 10~18자리 / 유픽: 20260612-0000123 형식' }, { status: 400 })
      }
      update.ggsan_order_no = raw
      changes.push(`매입처 주문번호 ${raw}`)
    }
  }

  // 확인 필요 해제
  if (body.clear_attention === true) {
    update.needs_attention = false
    update.attention_reason = null
    changes.push('확인필요 해제')
  }

  if (changes.length === 0) return NextResponse.json({ error: '변경 내용 없음' }, { status: 400 })

  const { error } = await admin.from('jimscanner_toss_orders').update(update).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  try { await logAdminAction({
    actor: user.email,
    action: 'toss_order_purchase_update',
    target_type: 'toss_order',
    target_id: id,
    summary: `토스주문#${order.order_product_id} ${changes.join(', ')} (${(order.product_name ?? '').slice(0, 24)})`,
    metadata: { ...update },
  }) } catch { /* 감사 로그 실패해도 저장은 유지 */ }
  revalidatePath('/admin/toss-orders')
  return NextResponse.json({ ok: true })
}
