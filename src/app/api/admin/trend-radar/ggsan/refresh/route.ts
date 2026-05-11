/**
 * 어드민이 누른 "ggsan 카탈로그 갱신" 버튼이 호출하는 엔드포인트.
 *  Supabase queue 에 row 삽입 → WSL 의 poll-ggsan-queue 가 즉시 잡아서 collect-ggsan 실행.
 *  WSL polling 주기 = 매분.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // 이미 pending 또는 running 인 row 있으면 신규 큐잉 안 함 (중복 방지)
  const { data: active } = await admin
    .from('jimscanner_ggsan_refresh_queue')
    .select('id, status, requested_at')
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle()
  if (active) {
    return NextResponse.json({ ok: true, queueId: active.id, alreadyActive: true, status: active.status })
  }

  const { data: row, error } = await admin
    .from('jimscanner_ggsan_refresh_queue')
    .insert({
      requested_by: user.email ?? 'admin',
      status: 'pending',
    })
    .select('id, status, requested_at')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, queueId: row.id, status: row.status })
}
