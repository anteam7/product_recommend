import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

// 흑자 후보 + 진행상태(콘솔 폴링)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = admin()
  const { data: candidates } = await sb
    .from('jimscanner_domemedb_margin_candidates')
    .select('*')
    .order('est_margin_rate', { ascending: false })
    .limit(200)
  const { data: state } = await sb.from('jimscanner_domemedb_run_state').select('*').eq('id', 1).single()
  return NextResponse.json({ candidates: candidates ?? [], state: state ?? null })
}
