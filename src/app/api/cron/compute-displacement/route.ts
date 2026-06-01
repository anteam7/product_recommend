import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'
import { computeDisplacement } from '@/lib/trends/displacement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 수요 대체(Displacement) 페어 재계산 cron.
 * recompute_scores 끝단에서 호출하거나, 로컬 스케줄러(run-crons.mjs)로 일 1회 호출.
 * ?window=14 로 관측 일수 조절 가능.
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

  const windowParam = request.nextUrl.searchParams.get('window')
  const windowDays = windowParam ? Math.max(5, Math.min(60, Number(windowParam))) : undefined

  const result = await computeDisplacement(admin, { windowDays })
  return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 })
}
