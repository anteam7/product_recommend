import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 와디즈 졸업 트래커 카드의 핀 토글.
 * Form POST: { signal_id, pinned: '1' | '0' }
 * 핀 시 jimscanner_trends_pins 에도 동시 적재 (product_recommend 큐 진입용).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const form = await request.formData().catch(() => null)
  const signalId = form?.get('signal_id')?.toString()
  const pinnedFlag = form?.get('pinned')?.toString() === '1'
  if (!signalId) {
    return NextResponse.json({ error: 'signal_id required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as any

  await admin
    .from('jimscanner_wadiz_signals')
    .update({ pinned: pinnedFlag })
    .eq('id', signalId)

  if (pinnedFlag) {
    const { data: row } = await admin
      .from('jimscanner_wadiz_signals')
      .select('title, matched_keyword, source')
      .eq('id', signalId)
      .maybeSingle()
    const keyword = row?.matched_keyword ?? row?.title
    if (keyword) {
      await admin
        .from('jimscanner_trends_pins')
        .upsert(
          {
            keyword,
            source: 'wadiz',
            notes: `wadiz 졸업 트래커 — ${row?.title ?? ''}`,
            pinned_at: new Date().toISOString(),
          },
          { onConflict: 'keyword,source' },
        )
    }
  }

  return NextResponse.redirect(new URL('/admin/trend-radar/wadiz', request.url), 303)
}
