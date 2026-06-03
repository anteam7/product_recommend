import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { evaluateAlerts } from '@/lib/trends/evaluate-alerts'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 발굴 트리거 룰 엔진 평가 cron.
 * recompute_scores 직후 도는 것을 전제 — 직전/현재 스냅샷을 비교해 룰 충족분을 발화한다.
 * (run-crons.mjs / Windows 스케줄러에서 score 재계산 다음 순번으로 호출)
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const result = await evaluateAlerts(admin)
  return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 })
}
