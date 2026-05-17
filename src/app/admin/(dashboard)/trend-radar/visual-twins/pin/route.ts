import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 비전 트윈 클러스터 → 기존 jimscanner_trends_pins 에 핀으로 저장.
 *   keyword = `visual_twin:<cluster_id>`
 *   source  = 'visual_twin'
 *   notes   = representative_title
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const form = await request.formData()
  const clusterId = form.get('cluster_id')?.toString()
  const title = form.get('title')?.toString() ?? ''
  if (!clusterId) {
    return NextResponse.json({ error: 'cluster_id required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { error } = await admin.from('jimscanner_trends_pins').upsert(
    {
      keyword: `visual_twin:${clusterId}`,
      source: 'visual_twin',
      notes: title || null,
      pinned_at: new Date().toISOString(),
    },
    { onConflict: 'keyword,source' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.redirect(new URL('/admin/trend-radar/visual-twins', request.url), {
    status: 303,
  })
}
