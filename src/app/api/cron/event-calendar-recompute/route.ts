/**
 * Event Calendar Recompute — Vercel Cron.
 *
 * 1일 1회 jimscanner_event_calendar_recompute() RPC 호출 → 이벤트별
 * 카테고리 lift / peak lag 갱신. 이벤트는 일정이 결정적이므로 매일
 * 한 번 누적 학습만 돌리면 충분.
 *
 * 스케줄: vercel.json 에서 KST 04:30 (UTC 19:30).
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

  const sb = createAdminClient()
  const t0 = Date.now()

  // 마이그레이션 적용 후 함수가 등록됨. RPC 타입 generation 전이므로 as any 캐스팅.
  const { data, error } = await (sb as any).rpc('jimscanner_event_calendar_recompute')

  const ms = Date.now() - t0
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message, ms },
      { status: 500 },
    )
  }

  const rows = (data ?? []) as Array<{ event_key: string; category_top: string }>
  return NextResponse.json({
    ok: true,
    processed: rows.length,
    distinct_events: new Set(rows.map((r) => r.event_key)).size,
    ms,
  })
}
