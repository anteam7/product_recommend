import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Cron — 마진 확장 윈도우 사전 집계 sanity ping.
 *
 * 현재는 view (jimscanner_margin_windows) 가 즉시 계산형이라 별도 적재 단계가 없다.
 * 이 endpoint 는:
 *   1) view 가 살아있는지 확인 (스키마/index 캐시 워밍)
 *   2) is_margin_window=true 행 카운트를 trends_runs 로 로깅
 * 향후 materialized view 로 전환 시 여기서 REFRESH 호출.
 *
 * scripts/run-crons.mjs 가 매일 KST 03:30 에 호출.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'env missing' }, { status: 500 })
  }

  const sb = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = new Date().toISOString()

  // view 가 아직 적용 안된 환경에서도 빌드/배포가 깨지지 않도록 cast.
  const { data, error } = await (sb.from('jimscanner_margin_windows' as never) as any)
    .select('product_id, is_margin_window')
    .eq('is_margin_window', true)
    .limit(500)

  if (error) {
    return NextResponse.json(
      { ok: false, message: 'view 미적용 또는 쿼리 실패', error: error.message },
      { status: 200 },
    )
  }

  const count = Array.isArray(data) ? data.length : 0

  // trends_runs 가 있으면 가벼운 audit row 적재. 실패해도 무시.
  try {
    await (sb.from('jimscanner_trends_runs' as never) as any).insert({
      source: 'margin_windows',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: 'ok',
      fetched_count: count,
      inserted_count: 0,
    })
  } catch {
    // ignore
  }

  return NextResponse.json({ ok: true, processed: count, message: `margin-windows refreshed (${count} active)` })
}
