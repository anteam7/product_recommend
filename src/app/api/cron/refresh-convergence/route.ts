import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Nightly REFRESH MATERIALIZED VIEW for jimscanner_keyword_convergence.
 * 호출: scripts/run-crons.mjs (HTTP).
 * 본체 로직은 SQL function jimscanner_refresh_keyword_convergence() 에 있음
 * (supabase/keyword_convergence.sql).
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정' },
      { status: 500 },
    )
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = Date.now()
  // generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await admin.rpc(
    'jimscanner_refresh_keyword_convergence' as never,
  )

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        duration_ms: Date.now() - startedAt,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    executed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    result: data,
  })
}
