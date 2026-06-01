import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'
import { fetchAndDecompose, seasonalAdjustedTrendScore } from '@/lib/trends/seasonality'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 계절성 분해 enrichment cron.
 * ─────────────────────────────────────────────
 * 상위 후보 product 에 대해 Naver DataLab 다년치 월별 시계열을 on-demand 로 받아
 * seasonal_index / deseasonalized_novelty 를 산출, 각 product 의 "가장 최근" score row 의
 * score_components.seasonality 에 기록한다. (컬럼 추가 불필요 — jsonb 갱신)
 *
 * recompute(WSL) 와 분리된 가벼운 보정 단계. DataLab rate limit 고려해 상위 N개만.
 *   /api/cron/enrich-seasonality?limit=40
 */
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

  const limit = Math.min(Number(new URL(request.url).searchParams.get('limit')) || 40, 100)
  const startedAt = Date.now()

  // 1) 최신 score 별 product_id (final_score 상위)
  const { data: latestScores, error: sErr } = await admin
    .from('jimscanner_trends_scores')
    .select('id, product_id, trend_score, final_score, score_components, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)
  if (sErr) {
    return NextResponse.json({ error: sErr.message }, { status: 500 })
  }

  type SRow = {
    id: string
    product_id: string
    trend_score: number
    final_score: number
    score_components: Record<string, unknown> | null
    computed_at: string
  }
  const seen = new Set<string>()
  const latest: SRow[] = []
  for (const s of (latestScores ?? []) as SRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  const targets = latest.sort((a, b) => b.final_score - a.final_score).slice(0, limit)
  if (targets.length === 0) {
    return NextResponse.json({ status: 'ok', enriched: 0, note: 'no scores' })
  }

  // 2) 각 product 의 대표 키워드 (최고 confidence 의 keyword alias)
  const productIds = targets.map((t) => t.product_id)
  const { data: aliases } = await admin
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, alias_type, confidence')
    .in('product_id', productIds)
    .eq('alias_type', 'keyword')
    .order('confidence', { ascending: false })

  const repKeyword = new Map<string, string>()
  for (const a of (aliases ?? []) as Array<{ product_id: string; alias: string }>) {
    if (!repKeyword.has(a.product_id)) repKeyword.set(a.product_id, a.alias)
  }

  // 3) 분해 + score_components.seasonality 갱신
  let enriched = 0
  let skipped = 0
  let lastErr: string | undefined
  for (const t of targets) {
    const keyword = repKeyword.get(t.product_id)
    if (!keyword) {
      skipped++
      continue
    }
    try {
      const decomp = await fetchAndDecompose(keyword, 3)
      if (!decomp) {
        skipped++
        continue
      }
      const adjusted = seasonalAdjustedTrendScore(t.trend_score, decomp)
      const components = { ...(t.score_components ?? {}) }
      ;(components as Record<string, unknown>).seasonality = {
        ...decomp,
        keyword,
        trend_score_raw: t.trend_score,
        trend_score_deseasonalized: adjusted,
        enriched_at: new Date().toISOString(),
      }
      const { error: uErr } = await admin
        .from('jimscanner_trends_scores')
        // score_components 만 갱신 — trend_score 자체는 recompute 소관
        .update({ score_components: components } as never)
        .eq('id', t.id)
      if (uErr) lastErr = uErr.message
      else enriched++
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  return NextResponse.json({
    status: lastErr ? (enriched > 0 ? 'partial' : 'error') : 'ok',
    enriched,
    skipped,
    durationMs: Date.now() - startedAt,
    error: lastErr ?? null,
  })
}
