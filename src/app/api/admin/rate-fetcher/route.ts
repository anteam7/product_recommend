import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import {
  runForSlug,
  runBatch,
  ALL_FETCHER_SLUGS,
  isPlaywrightSlug,
} from '@/lib/rate-fetchers/run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * 어드민 UI "갱신" 버튼 백엔드.
 *  POST { slug: string }   → 단일 사이트 페치
 *  POST { all: true }      → 전체 (비-Playwright) 일괄 페치
 *
 * Vercel 서버리스에서는 chromium 못 띄우므로 Playwright slug 는 거부.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as { slug?: string; all?: boolean }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정' },
      { status: 500 },
    )
  }
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  if (body.slug) {
    if (isPlaywrightSlug(body.slug)) {
      return NextResponse.json(
        {
          error: `Playwright fetcher (${body.slug}) 는 서버리스 환경에서 동작 불가. CLI 에서 실행: npx tsx scripts/run-rate-fetcher.ts --slug ${body.slug}`,
        },
        { status: 400 },
      )
    }
    const result = await runForSlug(admin, body.slug, {
      triggeredBy: 'admin',
      noSnapshot: true,
    })
    return NextResponse.json({
      ok: result.status !== 'error',
      result,
    })
  }

  if (body.all) {
    const slugs = ALL_FETCHER_SLUGS.filter((s) => !isPlaywrightSlug(s))
    const results = await runBatch(admin, slugs, {
      triggeredBy: 'admin-batch',
      noSnapshot: true,
    })
    const errorCount = results.filter((r) => r.status === 'error').length
    return NextResponse.json({
      ok: errorCount === 0,
      total: results.length,
      summary: {
        ok: results.filter((r) => r.status === 'ok').length,
        partial: results.filter((r) => r.status === 'partial').length,
        error: errorCount,
        skipped: results.filter((r) => r.status === 'skipped').length,
        total_inserted: results.reduce((a, r) => a + r.inserted, 0),
      },
      results,
    })
  }

  return NextResponse.json({ error: 'slug 또는 all 필수' }, { status: 400 })
}
