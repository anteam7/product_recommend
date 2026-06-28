import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

/**
 * 작업 취소 — queued/escalated/resuming 상태만 취소 가능(running 중인 건 에이전트가 끝낼 때까지 둠).
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = admin()
  const { error } = await sb.from('jimscanner_work_instructions')
    .update({ status: 'cancelled', ended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['queued', 'escalated', 'resuming'])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await sb.from('jimscanner_work_instruction_events').insert({ instruction_id: id, role: 'user', type: 'status', content: '⛔ 사용자 취소' })
  return NextResponse.json({ ok: true })
}
