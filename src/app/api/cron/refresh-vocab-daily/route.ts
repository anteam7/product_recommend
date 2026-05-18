/**
 * Vocabulary Velocity — daily MV refresh cron.
 *
 * jimscanner_vocab_daily 는 jimscanner_market_raw + jimscanner_trends_keywords
 * 본문 토큰을 집계한 머티리얼라이즈드 뷰. 매일 1회 REFRESH CONCURRENTLY.
 *
 * 적재 테이블:
 *  - jimscanner_vocab_daily (REFRESH)
 *  - jimscanner_trends_runs (감사 로그)
 *
 * 스케줄: vercel.json — KST 06:50 (UTC 21:50). Hobby 한도로 자동 발화 안 되므로
 * scripts/run-crons.mjs 에서도 호출.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SOURCE = 'refresh_vocab_daily'

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const started = Date.now()
  const sb = createAdminClient()

  let status: 'ok' | 'error' = 'ok'
  let errorMessage: string | null = null
  let rowsBefore: number | null = null
  let rowsAfter: number | null = null

  try {
    const before = await (sb as any)
      .from('jimscanner_vocab_daily')
      .select('term', { count: 'exact', head: true })
    rowsBefore = before.count ?? null

    const { error } = await (sb as any).rpc('jimscanner_refresh_vocab_daily')
    if (error) throw new Error(error.message)

    const after = await (sb as any)
      .from('jimscanner_vocab_daily')
      .select('term', { count: 'exact', head: true })
    rowsAfter = after.count ?? null
  } catch (e) {
    status = 'error'
    errorMessage = e instanceof Error ? e.message : String(e)
  }

  const durationMs = Date.now() - started

  // run audit log (best-effort)
  try {
    await (sb as any).from('jimscanner_trends_runs').insert({
      source: SOURCE,
      status,
      fetched_count: rowsBefore ?? 0,
      inserted_count: rowsAfter ?? 0,
      duration_ms: durationMs,
      error_message: errorMessage,
      triggered_by: 'cron',
      finished_at: new Date().toISOString(),
    })
  } catch {
    /* logging is best-effort */
  }

  return NextResponse.json({
    ok: status === 'ok',
    source: SOURCE,
    rows_before: rowsBefore,
    rows_after: rowsAfter,
    duration_ms: durationMs,
    error: errorMessage,
    executed_at: new Date().toISOString(),
  })
}
