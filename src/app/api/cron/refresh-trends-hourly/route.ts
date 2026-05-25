/**
 * 168시간 수요 히트맵 — hourly 집계 MV REFRESH cron.
 *
 * supabase/trends_v5_hourly_heatmap.sql 의 jimscanner_trends_hourly 를
 * 하루 1회 새로고침. CONCURRENT REFRESH 이므로 read 트래픽을 막지 않음.
 *
 * 스케줄: KST 05:30 (UTC 20:30) — 새벽 수집 cron 들이 다 끝난 뒤.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const t0 = Date.now()
  const sb = createAdminClient()
  try {
    // RPC 는 supabase/trends_v5_hourly_heatmap.sql 마이그레이션 적용 후 사용 가능.
    // 타입 미생성 상태에서 빌드 통과 위해 as any 캐스팅.
    const { data, error } = await (sb as any).rpc('jimscanner_refresh_trends_hourly')
    if (error) throw error

    const elapsed = Date.now() - t0
    return NextResponse.json({
      ok: true,
      duration_ms: elapsed,
      result: data,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { ok: false, error: msg, duration_ms: Date.now() - t0 },
      { status: 500 },
    )
  }
}
