import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 가장 최근 weather_forecast 스냅샷 × elasticity → demand_forecast 행 생성.

type ForecastRow = {
  region: string
  target_date: string
  lead_days: number
  temp_min: number | null
  temp_max: number | null
  temp_anomaly: number | null
  precipitation_mm: number | null
  precipitation_prob: number | null
  pm10: number | null
  pm25: number | null
  heat_wave: boolean | null
  cold_wave: boolean | null
  typhoon: boolean | null
  captured_at: string
}

type ElasticityRow = {
  category: string
  weather_var: string
  coefficient: number
  lead_days: number
}

function pickValue(f: ForecastRow, weatherVar: string): number {
  switch (weatherVar) {
    case 'temp_max': return Number(f.temp_max ?? 0)
    case 'temp_min': return Number(f.temp_min ?? 0)
    case 'temp_anomaly': return Number(f.temp_anomaly ?? 0)
    case 'precipitation_mm': return Number(f.precipitation_mm ?? 0)
    case 'precipitation_prob': return Number(f.precipitation_prob ?? 0)
    case 'pm10': return Number(f.pm10 ?? 0)
    case 'pm25': return Number(f.pm25 ?? 0)
    case 'heat_wave': return f.heat_wave ? 1 : 0
    case 'cold_wave': return f.cold_wave ? 1 : 0
    case 'typhoon': return f.typhoon ? 1 : 0
    default: return 0
  }
}

// 변수별 정규화 — 회귀 학습 전엔 합리적 스케일로 surge score 를 0~10 근방으로 유지.
function normalize(weatherVar: string, value: number): number {
  switch (weatherVar) {
    case 'temp_max': return Math.max(0, (value - 25) / 10)      // 35°C → 1.0
    case 'temp_min': return Math.max(0, (5 - value) / 15)        // -10°C → 1.0
    case 'temp_anomaly': return Math.abs(value) / 5              // ±5°C → 1.0
    case 'precipitation_mm': return Math.min(value / 30, 2)      // 30mm → 1.0
    case 'precipitation_prob': return Math.max(0, (value - 40) / 60)
    case 'pm10': return Math.max(0, (value - 80) / 70)            // 150 → 1.0
    case 'pm25': return Math.max(0, (value - 35) / 40)            // 75 → 1.0
    case 'heat_wave':
    case 'cold_wave':
    case 'typhoon': return value
    default: return value
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key)
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = new Date()

  // 1) 각 target_date 마다 가장 최근 captured_at 스냅샷만 사용.
  const { data: fcRaw, error: fcErr } = await admin
    .from('jimscanner_weather_forecast' as never)
    .select('region, target_date, lead_days, temp_min, temp_max, temp_anomaly, precipitation_mm, precipitation_prob, pm10, pm25, heat_wave, cold_wave, typhoon, captured_at')
    .gte('target_date', new Date().toISOString().slice(0, 10))
    .order('captured_at', { ascending: false })
    .limit(2000)

  if (fcErr) return NextResponse.json({ error: fcErr.message }, { status: 500 })

  const latestByDate = new Map<string, ForecastRow>()
  for (const r of (fcRaw ?? []) as ForecastRow[]) {
    const k = `${r.region}::${r.target_date}`
    if (!latestByDate.has(k)) latestByDate.set(k, r)
  }

  // 2) elasticity 전체 로드.
  const { data: elasRaw, error: elasErr } = await admin
    .from('jimscanner_weather_category_elasticity' as never)
    .select('category, weather_var, coefficient, lead_days')
  if (elasErr) return NextResponse.json({ error: elasErr.message }, { status: 500 })
  const elasticities = (elasRaw ?? []) as ElasticityRow[]

  // 3) target_date × category → surge_score 누적.
  type Acc = { score: number; drivers: { var: string; value: number; coef: number; contribution: number }[]; leadDays: number }
  const byKey = new Map<string, Acc>()

  for (const fc of latestByDate.values()) {
    for (const e of elasticities) {
      const raw = pickValue(fc, e.weather_var)
      if (!raw) continue
      const norm = normalize(e.weather_var, raw)
      if (norm <= 0) continue
      const contribution = norm * e.coefficient * 10  // 0~10 스케일
      if (contribution <= 0.05) continue
      const k = `${fc.target_date}::${e.category}`
      const prev = byKey.get(k) ?? { score: 0, drivers: [], leadDays: e.lead_days }
      prev.score += contribution
      prev.drivers.push({ var: e.weather_var, value: raw, coef: e.coefficient, contribution: Math.round(contribution * 100) / 100 })
      if (e.lead_days > prev.leadDays) prev.leadDays = e.lead_days
      byKey.set(k, prev)
    }
  }

  const computedAt = new Date().toISOString()
  const rows = [...byKey.entries()].map(([k, v]) => {
    const [target_date, category] = k.split('::')
    const target = new Date(target_date + 'T00:00:00Z')
    const recommendDate = new Date(target.getTime() - v.leadDays * 86400_000)
    return {
      target_date,
      category,
      surge_score: Math.round(v.score * 100) / 100,
      drivers: v.drivers,
      recommend_publish_date: recommendDate.toISOString().slice(0, 10),
      ggsan_match_count: 0,
      computed_at: computedAt,
    }
  })

  let insertedCount = 0
  let insertError: string | null = null
  if (rows.length > 0) {
    const { data: ins, error } = await admin
      .from('jimscanner_weather_demand_forecast' as never)
      .insert(rows as never)
      .select('id')
    if (error) insertError = error.message
    else insertedCount = ins?.length ?? 0
  }

  await admin
    .from('jimscanner_trends_runs')
    .insert({
      source: 'weather_demand_forecast',
      status: insertError ? 'error' : 'ok',
      fetched_count: rows.length,
      inserted_count: insertedCount,
      duration_ms: Date.now() - startedAt.getTime(),
      error_message: insertError,
      triggered_by: 'cron',
      finished_at: new Date().toISOString(),
    } as never)

  return NextResponse.json({
    ok: !insertError,
    forecasts: latestByDate.size,
    elasticities: elasticities.length,
    predictions: rows.length,
    inserted: insertedCount,
    insertError,
  })
}
