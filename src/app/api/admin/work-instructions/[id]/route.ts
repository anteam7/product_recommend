import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

// 작업 상세 + 이벤트 스레드(콘솔 폴링)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = admin()
  const { data: instruction, error } = await sb.from('jimscanner_work_instructions').select('*').eq('id', id).single()
  if (error || !instruction) return NextResponse.json({ error: '작업을 찾을 수 없습니다' }, { status: 404 })
  const { data: events } = await sb.from('jimscanner_work_instruction_events').select('*').eq('instruction_id', id).order('created_at', { ascending: true })
  return NextResponse.json({ instruction, events: events ?? [] })
}
