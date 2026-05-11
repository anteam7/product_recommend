import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** body { keyword, source, pinned: boolean, notes? } */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = (await request.json().catch(() => ({}))) as {
    keyword?: string
    source?: string
    pinned?: boolean
    notes?: string
  }
  if (!body.keyword || !body.source) {
    return NextResponse.json({ error: 'keyword, source required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  if (body.pinned === false) {
    const { error } = await admin
      .from('jimscanner_trends_pins')
      .delete()
      .eq('keyword', body.keyword)
      .eq('source', body.source)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, pinned: false })
  }

  const { error } = await admin
    .from('jimscanner_trends_pins')
    .upsert(
      { keyword: body.keyword, source: body.source, notes: body.notes ?? null, pinned_at: new Date().toISOString() },
      { onConflict: 'keyword,source' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, pinned: true })
}
