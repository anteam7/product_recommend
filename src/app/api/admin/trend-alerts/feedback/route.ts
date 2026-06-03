import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

/**
 * 발화 피드백 — 자가 튜닝(노이즈 추적)용.
 * body: { alert_id, feedback: 'hit' | 'noise' }
 * 'hit' 으로 표시하면 해당 rule 의 hit_count 를 +1 (적중률 = hit/fired).
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const alertId = body?.alert_id
  const feedback = body?.feedback
  if (typeof alertId !== 'string' || (feedback !== 'hit' && feedback !== 'noise' && feedback !== null)) {
    return NextResponse.json({ error: 'alert_id, feedback(hit|noise|null) 필수' }, { status: 400 })
  }

  const admin = createAdminClient()

  // 직전 feedback 읽어서 hit_count 보정 (hit ↔ noise 토글 시 중복 카운트 방지)
  const { data: prev } = await (admin as any)
    .from('jimscanner_trends_alerts')
    .select('rule_id, feedback')
    .eq('id', alertId)
    .single()
  if (!prev) return NextResponse.json({ error: 'alert not found' }, { status: 404 })

  const { error: updErr } = await (admin as any)
    .from('jimscanner_trends_alerts')
    .update({ feedback })
    .eq('id', alertId)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  // hit_count delta: 새로 hit 이면 +1, hit 였다가 해제되면 -1
  const wasHit = prev.feedback === 'hit'
  const isHit = feedback === 'hit'
  const delta = isHit && !wasHit ? 1 : !isHit && wasHit ? -1 : 0
  if (delta !== 0 && prev.rule_id) {
    const { data: rule } = await (admin as any)
      .from('jimscanner_trends_alert_rules')
      .select('hit_count')
      .eq('id', prev.rule_id)
      .single()
    const base = rule?.hit_count ?? 0
    await (admin as any)
      .from('jimscanner_trends_alert_rules')
      .update({ hit_count: Math.max(0, base + delta) })
      .eq('id', prev.rule_id)
  }

  return NextResponse.json({ ok: true })
}
