import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface Weights {
  trend: number
  commerce: number
  supplier: number
  competition: number
}

const DEFAULT_WEIGHTS: Weights = {
  trend: 0.25,
  commerce: 0.25,
  supplier: 0.25,
  competition: 0.25,
}

function parseWeights(input: Partial<Weights> | null | undefined): Weights {
  const raw = {
    trend: Number(input?.trend ?? DEFAULT_WEIGHTS.trend),
    commerce: Number(input?.commerce ?? DEFAULT_WEIGHTS.commerce),
    supplier: Number(input?.supplier ?? DEFAULT_WEIGHTS.supplier),
    competition: Number(input?.competition ?? DEFAULT_WEIGHTS.competition),
  }
  for (const k of Object.keys(raw) as (keyof Weights)[]) {
    if (!Number.isFinite(raw[k]) || raw[k] < 0) raw[k] = 0
  }
  const sum = raw.trend + raw.commerce + raw.supplier + raw.competition
  if (sum === 0) return DEFAULT_WEIGHTS
  return {
    trend: raw.trend / sum,
    commerce: raw.commerce / sum,
    supplier: raw.supplier / sum,
    competition: raw.competition / sum,
  }
}

/**
 * 시뮬레이션 전용 — DB 에 쓰지 않음.
 *   POST body: { weights: { trend, commerce, supplier, competition }, horizon_days?, threshold? }
 *   응답: 동일 데이터에 새 가중치를 적용했을 때 precision / hit rate / top movers
 */
export async function POST(req: NextRequest) {
  let body: any
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const weights = parseWeights(body?.weights)
  const horizonDays = Number(body?.horizon_days ?? 14)
  const threshold = Number(body?.threshold ?? 50)

  const sb = createAdminClient()
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_score_backtest' as any)
    .select(
      'product_id, baseline_at, baseline_final, baseline_components, horizon_days, outcome_metrics, hit',
    )
    .eq('horizon_days', horizonDays)
    .gte('evaluated_at', since)
    .limit(5000)

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as unknown as Array<{
    product_id: string
    baseline_at: string
    baseline_final: number
    baseline_components: {
      trend?: number
      commerce?: number
      supplier?: number
      competition?: number
    }
    horizon_days: number
    outcome_metrics: any
    hit: boolean
  }>

  let positives = 0
  let positiveHits = 0
  let topMovers: Array<{
    product_id: string
    original_final: number
    simulated_final: number
    delta: number
    hit: boolean
  }> = []

  for (const r of rows) {
    const c = r.baseline_components ?? {}
    const simulated =
      weights.trend * (c.trend ?? 0) +
      weights.commerce * (c.commerce ?? 0) +
      weights.supplier * (c.supplier ?? 0) +
      weights.competition * (c.competition ?? 0)
    if (simulated >= threshold) {
      positives++
      if (r.hit) positiveHits++
    }
    topMovers.push({
      product_id: r.product_id,
      original_final: r.baseline_final,
      simulated_final: Math.round(simulated * 10) / 10,
      delta: Math.round((simulated - r.baseline_final) * 10) / 10,
      hit: r.hit,
    })
  }

  topMovers = topMovers
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 20)

  const baseHitRate =
    rows.length === 0 ? 0 : rows.filter((r) => r.hit).length / rows.length

  return NextResponse.json({
    ok: true,
    weights,
    horizon_days: horizonDays,
    threshold,
    sample_size: rows.length,
    base_hit_rate: Math.round(baseHitRate * 1000) / 1000,
    simulated_precision:
      positives === 0 ? 0 : Math.round((positiveHits / positives) * 1000) / 1000,
    simulated_positives: positives,
    simulated_hits: positiveHits,
    top_movers: topMovers,
  })
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    usage:
      'POST { weights: { trend, commerce, supplier, competition }, horizon_days?, threshold? }',
    default_weights: DEFAULT_WEIGHTS,
  })
}
