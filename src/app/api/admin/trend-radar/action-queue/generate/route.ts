/**
 * POST /api/admin/trend-radar/action-queue/generate
 * 트리거 룰을 실행해 새 카드를 생성한다.
 * - register : final_score 가 ≥60 진입 (활성 카드 없을 때)
 * - reprice  : 핀 keyword 매칭 + supplier_score ≥ 70
 * - derecord : 최근 7d 평균 final_score 가 직전 30d 대비 ≤ -20
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
  // 마이그레이션 적용 전에는 RPC 가 없으므로 as any 캐스팅.
  const { data, error } = await (admin as any).rpc('jimscanner_trends_action_queue_generate')
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, results: data ?? [] })
}
