import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

// 도매꾹 국내 소싱 + 로켓그로스 흑자 후보(마진순) — /admin/sourcing 비교 페이지가 읽음.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = admin()
  const { data, error } = await sb
    .from('jimscanner_scout_sourcing')
    .select('*')
    .order('margin', { ascending: false })
    .limit(300)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ candidates: data ?? [], batch: data?.[0]?.batch ?? null })
}
