import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { collectNaverSeasonality } from '@/lib/trends/collect'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 연간 시즌 선점 — trailing 13개월 월별 검색곡선에서 위상 산출.
// 30일 롤링 윈도우와 무관하게 즉시 백필 가능 → 주 1회 정도 갱신으로 충분.
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

  const result = await collectNaverSeasonality(admin, 'cron')
  return NextResponse.json(result, { status: result.status === 'error' ? 500 : 200 })
}
