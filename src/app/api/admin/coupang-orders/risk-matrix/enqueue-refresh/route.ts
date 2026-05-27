/**
 * 위험 매트릭스 Q1/Q2 카드에서 호출 — ggsan 도매 카탈로그 즉시 갱신 큐잉.
 * 내부적으로 jimscanner_ggsan_refresh_queue 에 row 삽입 (기존 trend-radar/ggsan/refresh 와 동일 패턴).
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

  const { data: active } = await admin
    .from('jimscanner_ggsan_refresh_queue')
    .select('id, status')
    .in('status', ['pending', 'running'])
    .limit(1)
    .maybeSingle()
  if (active) {
    return NextResponse.json({
      ok: true,
      queueId: active.id,
      alreadyActive: true,
      status: active.status,
    })
  }

  const { data: row, error } = await admin
    .from('jimscanner_ggsan_refresh_queue')
    .insert({
      requested_by: `risk-matrix:${user.email ?? 'admin'}`,
      status: 'pending',
    })
    .select('id, status')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, queueId: row.id, status: row.status })
}
