import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED = new Set(['live', 'exit_win', 'exit_loss', 'exit_dead'])

/** body { keyword, source, status, exit_reason? } */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = (await request.json().catch(() => ({}))) as {
    keyword?: string
    source?: string
    status?: string
    exit_reason?: string
  }
  if (!body.keyword || !body.source || !body.status || !ALLOWED.has(body.status)) {
    return NextResponse.json({ error: 'keyword, source, status (live|exit_win|exit_loss|exit_dead) required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const isExit = body.status !== 'live'
  const patch: Record<string, unknown> = {
    status: body.status,
    exited_at: isExit ? new Date().toISOString() : null,
    exit_reason: isExit ? (body.exit_reason ?? null) : null,
  }

  const { error } = await admin
    // status / exited_at / exit_reason 컬럼은 trends_pins_v2.sql 적용 후 존재.
    .from('jimscanner_trends_pins')
    .update(patch as never)
    .eq('keyword', body.keyword)
    .eq('source', body.source)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, status: body.status })
}
