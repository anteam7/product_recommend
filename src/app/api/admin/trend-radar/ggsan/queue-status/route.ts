/**
 * 어드민 페이지가 갱신 버튼 누른 후 진행 상황 polling 용.
 */
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

  const id = new URL(req.url).searchParams.get('id')
  const admin = createAdminClient()

  if (id) {
    const { data } = await admin
      .from('jimscanner_ggsan_refresh_queue')
      .select('id, status, requested_at, started_at, finished_at, fetched_count, inserted_count, error_message')
      .eq('id', id)
      .maybeSingle()
    return NextResponse.json({ row: data ?? null })
  }

  // id 미지정 시 최근 5건
  const { data } = await admin
    .from('jimscanner_ggsan_refresh_queue')
    .select('id, status, requested_at, started_at, finished_at, fetched_count, inserted_count, error_message')
    .order('requested_at', { ascending: false })
    .limit(5)
  return NextResponse.json({ rows: data ?? [] })
}
