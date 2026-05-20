import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** body { target_id: uuid, source_id: uuid }
 *  target 으로 source 의 alias/image/score/supplier 를 흡수하고 source 를 삭제.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    target_id?: string
    source_id?: string
  }
  const target_id = body.target_id
  const source_id = body.source_id
  if (!target_id || !source_id) {
    return NextResponse.json({ error: 'target_id, source_id required' }, { status: 400 })
  }
  if (target_id === source_id) {
    return NextResponse.json({ error: 'target_id must differ from source_id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await admin.rpc('jimscanner_merge_products' as never, {
    target_id,
    source_id,
    actor: user.email ?? 'admin',
  } as never)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) })
}
