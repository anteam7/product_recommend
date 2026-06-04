import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DECISIONS = ['sourced', 'pinned', 'rejected', 'snoozed'] as const
const REASON_CODES = [
  'margin',
  'red_ocean',
  'cert_burden',
  'season_end',
  'brand_lock',
  'no_supplier',
  'other',
] as const

type Decision = (typeof DECISIONS)[number]

/**
 * 발굴 기각사유 학습 루프 — 운영자 판단 기록.
 * body { goods_no, decision, cate_cd?, title?, reason_code?, reason_text?, snooze_days?, clear?: boolean }
 * - decision='snoozed' 이고 snooze_days 가 있으면 expires_at = now + snooze_days.
 * - clear=true 면 해당 goods_no 결정 삭제(복원).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    goods_no?: string
    decision?: string
    cate_cd?: string | null
    title?: string | null
    reason_code?: string | null
    reason_text?: string | null
    snooze_days?: number
    clear?: boolean
  }

  if (!body.goods_no) {
    return NextResponse.json({ error: 'goods_no required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 복원 (결정 해제)
  if (body.clear) {
    const { error } = await admin
      .from('jimscanner_trends_decisions' as never)
      .delete()
      .eq('goods_no', body.goods_no)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, cleared: true })
  }

  if (!body.decision || !DECISIONS.includes(body.decision as Decision)) {
    return NextResponse.json(
      { error: `decision must be one of ${DECISIONS.join(', ')}` },
      { status: 400 },
    )
  }
  if (body.reason_code && !REASON_CODES.includes(body.reason_code as never)) {
    return NextResponse.json({ error: 'invalid reason_code' }, { status: 400 })
  }

  let expiresAt: string | null = null
  if (body.decision === 'snoozed') {
    const days = Number.isFinite(body.snooze_days) && body.snooze_days! > 0 ? body.snooze_days! : 14
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
  }

  const row = {
    goods_no: body.goods_no,
    cate_cd: body.cate_cd ?? null,
    title: body.title ?? null,
    decision: body.decision,
    reason_code: body.reason_code ?? null,
    reason_text: body.reason_text ?? null,
    decided_by: user.email ?? null,
    decided_at: new Date().toISOString(),
    expires_at: expiresAt,
  }

  const { error } = await admin
    .from('jimscanner_trends_decisions' as never)
    .upsert(row as never, { onConflict: 'goods_no' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, decision: body.decision, expires_at: expiresAt })
}
