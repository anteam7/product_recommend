import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** body { seed_id, is_active?: boolean, display_order?: number } */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    seed_id?: string
    is_active?: boolean
    display_order?: number
  }
  if (!body.seed_id) {
    return NextResponse.json({ error: 'seed_id required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const patch: Record<string, unknown> = {}
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
  if (typeof body.display_order === 'number') patch.display_order = body.display_order
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  const { error } = await admin
    .from('jimscanner_trends_seeds')
    .update(patch)
    .eq('id', body.seed_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, ...patch })
}
