/**
 * 일 1회 핀 부패 스냅샷 적재.
 * RPC `jimscanner_snapshot_pin_health()` 를 호출하면 내부에서
 * `jimscanner_pin_decay(14)` 결과를 `jimscanner_pin_health_snapshots` 에 upsert.
 *
 * 스케줄: vercel.json crons 참조.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

  const t0 = Date.now()
  // RPC 미적용 환경에서도 빌드 통과를 위해 as any.
  const { data, error } = await (admin.rpc as any)('jimscanner_snapshot_pin_health')
  const elapsed = Date.now() - t0

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message, elapsed_ms: elapsed },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    inserted: typeof data === 'number' ? data : null,
    elapsed_ms: elapsed,
  })
}
