/**
 * 어드민이 trend-radar 에서 특정 product 를 reject/hide/approve 할 때 호출.
 * 누적된 라벨은 scripts/train-reject-model.mjs 가 야간에 학습 입력으로 사용.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = {
  product_id?: string
  decision?: 'reject' | 'hide' | 'approve'
  reason?: string
  surface?: string
}

export async function POST(req: Request) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: Body
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad_json' }, { status: 400 }) }

  const { product_id, decision } = body
  if (!product_id || !decision || !['reject', 'hide', 'approve'].includes(decision)) {
    return NextResponse.json({ error: 'product_id, decision(reject|hide|approve) 필요' }, { status: 400 })
  }

  const admin = createAdminClient()
  // 마이그레이션 supabase/trends_v4_reject_learning.sql 적용 후 generated types 재생성 필요.
  const { error } = await admin
    .from('jimscanner_trends_reject_labels' as never)
    .upsert(
      {
        product_id,
        decision,
        reason: body.reason ?? null,
        decided_by: user.email ?? 'admin',
        surface: body.surface ?? 'trend-radar',
      } as never,
      { onConflict: 'product_id,decision' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
