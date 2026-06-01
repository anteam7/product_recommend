/**
 * 발굴 의사결정 캡처 엔드포인트.
 *  recommend / pins 카드의 채택·보류·반려 버튼이 호출.
 *  jimscanner_trends_decisions 에 기록 + jimscanner_admin_actions 에 audit.
 *
 * 신규 테이블은 generated 타입 미반영 — `npm run gen:types` 후 `as any` 캐스팅 제거 가능.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DECISIONS = ['reviewed', 'adopted', 'sourced', 'deferred', 'rejected'] as const
type Decision = (typeof DECISIONS)[number]

/** body { goodsNo?, productId?, decision, reasonCode?, note?, scoreSnapshot? } */
export async function POST(request: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    goodsNo?: string
    productId?: string
    decision?: string
    reasonCode?: string | null
    note?: string | null
    scoreSnapshot?: Record<string, unknown> | null
  }

  if (!body.decision || !DECISIONS.includes(body.decision as Decision)) {
    return NextResponse.json(
      { error: `decision must be one of ${DECISIONS.join(', ')}` },
      { status: 400 },
    )
  }
  if (!body.goodsNo && !body.productId) {
    return NextResponse.json({ error: 'goodsNo or productId required' }, { status: 400 })
  }

  const admin = createAdminClient()

  const row = {
    goods_no: body.goodsNo ?? null,
    product_id: body.productId ?? null,
    decision: body.decision,
    reason_code: body.reasonCode || null,
    note: body.note?.trim() || null,
    score_at_decision: body.scoreSnapshot ?? {},
    decided_by: user.email ?? 'admin',
    decided_at: new Date().toISOString(),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await (admin as any)
    .from('jimscanner_trends_decisions')
    .insert(row)
    .select('id, decided_at')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // audit (미사용 중이던 admin_actions 활용) — 실패해도 본 결정은 성공 처리.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from('jimscanner_admin_actions').insert({
    actor: user.email ?? 'admin',
    action: 'trend_decision',
    target_type: 'ggsan_goods',
    target_id: body.goodsNo ?? body.productId ?? null,
    summary: `발굴 결정: ${body.decision}${body.reasonCode ? ` (${body.reasonCode})` : ''}`,
    metadata: row,
  })

  return NextResponse.json({ ok: true, id: inserted?.id, decision: body.decision })
}
