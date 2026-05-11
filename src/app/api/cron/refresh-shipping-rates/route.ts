import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  runBatch,
  ALL_FETCHER_SLUGS,
  PLAYWRIGHT_SLUGS,
  isPlaywrightSlug,
} from '@/lib/rate-fetchers/run'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel 함수 최대 실행시간. 비-Playwright 21 사이트 합산 ~75s 관측됨, 여유분 포함.
export const maxDuration = 300

/**
 * Vercel Cron — 등록된 fetcher 중 비-Playwright 사이트 일괄 갱신.
 * Vercel 서버리스에서는 chromium 못 띄우므로 PLAYWRIGHT_SLUGS 제외.
 * 그 4개는 어드민 UI 의 "갱신" 버튼(서버에서 별도 환경) 이나 CLI 로 처리.
 *
 * vercel.json crons 매핑: "/api/cron/refresh-shipping-rates" — 매일 KST 05시.
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

  const slugs = ALL_FETCHER_SLUGS.filter((s) => !isPlaywrightSlug(s))
  const startedAt = Date.now()

  const results = await runBatch(admin, slugs, {
    triggeredBy: 'cron',
    noSnapshot: true,
    log: (line) => console.log(line),
  })

  const okCount = results.filter((r) => r.status === 'ok').length
  const partialCount = results.filter((r) => r.status === 'partial').length
  const errorCount = results.filter((r) => r.status === 'error').length
  const skippedCount = results.filter((r) => r.status === 'skipped').length
  const totalInserted = results.reduce((a, r) => a + r.inserted, 0)
  const allOk = errorCount === 0

  return NextResponse.json(
    {
      ok: allOk,
      executed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      excluded_playwright: [...PLAYWRIGHT_SLUGS],
      summary: {
        ok: okCount,
        partial: partialCount,
        error: errorCount,
        skipped: skippedCount,
        total_inserted: totalInserted,
      },
      results: results.map((r) => ({
        slug: r.slug,
        status: r.status,
        parsed: r.parsed,
        inserted: r.inserted,
        duration_ms: r.durationMs,
        error: r.error,
      })),
    },
    { status: allOk ? 200 : 500 },
  )
}
