import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const lead = url.searchParams.get('lead') ?? ''
  const lag = url.searchParams.get('lag') ?? ''
  if (!lead || !lag) {
    return NextResponse.json({ error: 'lead/lag required' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('jimscanner_trends_category_overlay' as never, {
    lead_cat: lead,
    lag_cat: lag,
    window_days: 45,
  } as never)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ rows: data ?? [] })
}
