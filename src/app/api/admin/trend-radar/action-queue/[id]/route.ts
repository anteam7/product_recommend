/**
 * PATCH /api/admin/trend-radar/action-queue/[id]
 * 카드 status 변경 (snoozed | done | skipped) + decision_note.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_STATUS = ['new', 'snoozed', 'done', 'skipped'] as const
type Status = (typeof ALLOWED_STATUS)[number]

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 })

  let body: { status?: string; decision_note?: string; snooze_hours?: number } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const status = body.status as Status | undefined
  if (!status || !ALLOWED_STATUS.includes(status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { status }
  if (typeof body.decision_note === 'string') patch.decision_note = body.decision_note.slice(0, 500)
  if (status === 'done' || status === 'skipped') {
    patch.processed_at = new Date().toISOString()
  }
  if (status === 'snoozed') {
    const hours = Math.min(Math.max(Number(body.snooze_hours ?? 24), 1), 24 * 14)
    patch.snoozed_until = new Date(Date.now() + hours * 3600_000).toISOString()
  }

  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('jimscanner_trends_action_queue')
    .update(patch)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
