import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

/**
 * 에스컬레이션 답변 — reply 이벤트 추가 + status=resuming (work-agent 가 claude --resume 로 재개).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const reply = String(body?.reply ?? '').trim()
  if (!reply) return NextResponse.json({ error: '답변이 비어 있습니다' }, { status: 400 })

  const sb = admin()
  const { data: instr, error: e1 } = await sb.from('jimscanner_work_instructions').select('id, status, session_id').eq('id', id).single()
  if (e1 || !instr) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 })
  if (instr.status !== 'escalated') return NextResponse.json({ error: `현재 답변 불가 상태(${instr.status})` }, { status: 409 })
  if (!instr.session_id) return NextResponse.json({ error: '재개할 세션이 없습니다(에이전트 재시작 필요)' }, { status: 409 })

  await sb.from('jimscanner_work_instruction_events').insert({ instruction_id: id, role: 'user', type: 'reply', content: reply })
  const { error: e2 } = await sb.from('jimscanner_work_instructions').update({ status: 'resuming', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'escalated')
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
