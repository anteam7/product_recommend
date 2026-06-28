import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && isAdminEmail(user.email) ? user : null
}

// 목록(콘솔 폴링)
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await admin()
    .from('jimscanner_work_instructions')
    .select('id, title, status, priority, created_by, created_at, started_at, ended_at, result, error')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

/**
 * 작업 지시 생성 — jimscanner_work_instructions 에 queued 로 등록.
 * 실제 실행은 로컬 work-agent.mjs 가 큐를 폴링해 Claude 로 자율 수행한다.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const instruction = String(body?.instruction ?? '').trim()
  if (!instruction) return NextResponse.json({ error: '지시 내용이 비어 있습니다' }, { status: 400 })
  const priority = Number.isFinite(body?.priority) ? Math.max(1, Math.min(10, Number(body.priority))) : 5
  const title = instruction.split('\n')[0].slice(0, 80)

  const sb = admin()
  const { data, error } = await sb
    .from('jimscanner_work_instructions')
    .insert({ instruction, title, priority, created_by: user.email, status: 'queued' })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await sb.from('jimscanner_work_instruction_events').insert({ instruction_id: data.id, role: 'user', type: 'log', content: instruction })
  return NextResponse.json({ ok: true, id: data.id })
}
