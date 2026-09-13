import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  runBatch,
  ALL_FETCHER_SLUGS,
  PLAYWRIGHT_SLUGS,
  VERCEL_BLOCKED_SLUGS,
  isPlaywrightSlug,
  isVercelBlockedSlug,
} from '@/lib/rate-fetchers/run'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel 함수 최대 실행시간. 비-Playwright 사이트 합산 ~50s 관측(2026-09), 여유분 포함.
export const maxDuration = 300

/**
 * 등록된 fetcher 중 Vercel 에서 실행 가능한 사이트 일괄 갱신.
 * - PLAYWRIGHT_SLUGS 제외: 서버리스에서 chromium 못 띄움 → 어드민 "갱신" 버튼/CLI 로 처리.
 * - VERCEL_BLOCKED_SLUGS 제외: WAF 가 데이터센터 IP 를 403 차단 → 로컬 CLI 로 처리.
 *
 * 트리거: 로컬 Windows 작업 스케줄러(jimscanner-product-recommend-crons, 매일 KST 03:30)의
 * scripts/run-crons.mjs 가 호출. vercel.json crons 는 비어 있음(Hobby 한도 우회).
 *
 * 응답 정책: 일부 사이트 실패는 200 + ok:false + error 요약(부분 성공을 정직하게 보고).
 * HTTP 500 은 전 사이트 실패(인프라 문제) 또는 라우트 자체 오류일 때만.
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

  const slugs = ALL_FETCHER_SLUGS.filter(
    (s) => !isPlaywrightSlug(s) && !isVercelBlockedSlug(s),
  )
  const startedAt = Date.now()

  try {
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
    // 실패 사유 요약 — 로컬 러너(run-crons.mjs summarize)가 'error' 키를 로그에 남긴다.
    // 값은 fetcher/DB 오류 메시지(HTTP 상태 등)만 담기며 시크릿은 포함되지 않는다.
    const errorSummary = allOk
      ? undefined
      : results
          .filter((r) => r.status === 'error')
          .map((r) => `${r.slug}: ${r.error ?? 'unknown'}`)
          .join('; ')
          .slice(0, 500)
    // 전 사이트 실패(성공 0)일 때만 인프라 장애로 보고 500. 부분 실패는 200 + 정직한 보고.
    const allFailed = errorCount > 0 && okCount + partialCount === 0

    return NextResponse.json(
      {
        ok: allOk,
        error: errorSummary,
        executed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        inserted: totalInserted,
        excluded_playwright: [...PLAYWRIGHT_SLUGS],
        excluded_vercel_blocked: [...VERCEL_BLOCKED_SLUGS],
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
      { status: allFailed ? 500 : 200 },
    )
  } catch (e) {
    // 라우트 자체 오류도 사유를 본문에 남겨 진단 가능하게 (메시지에 시크릿 없음)
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[refresh-shipping-rates] batch 실패:', msg)
    return NextResponse.json(
      { ok: false, error: `batch 실행 실패: ${msg}`.slice(0, 500) },
      { status: 500 },
    )
  }
}
