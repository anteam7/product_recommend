#!/usr/bin/env node
/**
 * STL 계절성 분해 cron (로컬 전용, nightly).
 *
 * jimscanner_trends_keywords 시계열을 키워드/소스 별로 fit:
 *   observed = trend + seasonal + residual
 *
 * 단순화한 classical decomposition:
 *  - trend  = centered moving average (window = period)
 *  - season = period-aligned average of (observed - trend)
 *  - resid  = observed - trend - seasonal
 * 그리고 윈도우 평균/표준편차로 trend_z, residual_z 계산.
 *
 * 출력: jimscanner_trends_stl (latest row per (keyword, source, window_days, period))
 *
 * 사용:
 *   node --env-file=.env.local scripts/stl-decompose.mjs
 *   node --env-file=.env.local scripts/stl-decompose.mjs --window=180 --period=7 --min-samples=21
 *   node --env-file=.env.local scripts/stl-decompose.mjs --source=naver_search_trend
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
function arg(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const WINDOW_DAYS = parseInt(arg('window', '90'), 10)
const PERIOD = parseInt(arg('period', '7'), 10)
const MIN_SAMPLES = parseInt(arg('min-samples', String(PERIOD * 3)), 10)
const SOURCE_FILTER = arg('source', null)
const DEFAULT_SOURCES = [
  'naver_search_trend',
  'naver_shopping_insight',
  'naver_tvtime',
]
const SOURCES = SOURCE_FILTER ? [SOURCE_FILTER] : DEFAULT_SOURCES
const BATCH_INSERT = 500

function mean(xs) {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}
function stddev(xs, mu) {
  if (xs.length < 2) return 0
  let s = 0
  for (const x of xs) {
    const d = x - mu
    s += d * d
  }
  return Math.sqrt(s / (xs.length - 1))
}

/**
 * 단순 classical decomposition.
 * series: number[] (시간순)
 * period: int
 * returns { trend[], seasonal[], residual[] } 길이는 series 와 동일 (트렌드 가장자리는 null).
 */
function decompose(series, period) {
  const n = series.length
  const trend = new Array(n).fill(null)
  const seasonal = new Array(n).fill(0)
  const residual = new Array(n).fill(null)

  const half = Math.floor(period / 2)
  for (let i = half; i < n - half; i++) {
    let sum = 0
    let count = 0
    for (let j = i - half; j <= i + half; j++) {
      const v = series[j]
      if (Number.isFinite(v)) {
        sum += v
        count++
      }
    }
    if (count > 0) trend[i] = sum / count
  }

  // detrended = obs - trend
  const detrended = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (trend[i] != null && Number.isFinite(series[i])) {
      detrended[i] = series[i] - trend[i]
    }
  }

  // seasonal indices (period-aligned mean)
  const seasonIdx = new Array(period).fill(0)
  const seasonCount = new Array(period).fill(0)
  for (let i = 0; i < n; i++) {
    if (detrended[i] != null) {
      const k = i % period
      seasonIdx[k] += detrended[i]
      seasonCount[k]++
    }
  }
  for (let k = 0; k < period; k++) {
    seasonIdx[k] = seasonCount[k] > 0 ? seasonIdx[k] / seasonCount[k] : 0
  }
  // center seasonal indices so they sum to 0
  const seasonalMean = mean(seasonIdx)
  for (let k = 0; k < period; k++) seasonIdx[k] -= seasonalMean

  for (let i = 0; i < n; i++) {
    seasonal[i] = seasonIdx[i % period]
    if (trend[i] != null && Number.isFinite(series[i])) {
      residual[i] = series[i] - trend[i] - seasonal[i]
    }
  }

  return { trend, seasonal, residual, seasonIdx }
}

/**
 * (keyword, source) 별 시계열 — 동일 날짜 multiple row 는 평균.
 * Returns: { byKey: Map<keyword, { dates: string[], values: number[] }> }
 */
function buildSeries(rows, days) {
  // rows: { keyword, volume_relative, collected_at }
  const byKey = new Map()
  for (const r of rows) {
    if (!r.keyword) continue
    const v = Number(r.volume_relative)
    if (!Number.isFinite(v)) continue
    const day = r.collected_at.slice(0, 10) // YYYY-MM-DD KST 대신 UTC 기준이지만 일관성만 있으면 OK
    let m = byKey.get(r.keyword)
    if (!m) {
      m = new Map()
      byKey.set(r.keyword, m)
    }
    const cur = m.get(day)
    if (cur) {
      cur.sum += v
      cur.n += 1
    } else {
      m.set(day, { sum: v, n: 1 })
    }
  }

  // build day grid: last `days` days ending today
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const dayList = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000)
    dayList.push(d.toISOString().slice(0, 10))
  }

  const result = new Map()
  for (const [keyword, dayMap] of byKey.entries()) {
    const values = new Array(dayList.length).fill(NaN)
    let nObs = 0
    for (let i = 0; i < dayList.length; i++) {
      const cell = dayMap.get(dayList[i])
      if (cell) {
        values[i] = cell.sum / cell.n
        nObs++
      }
    }
    if (nObs >= MIN_SAMPLES) {
      result.set(keyword, { dates: dayList, values, nObs })
    }
  }
  return result
}

function labelAnomaly(seasonalVal, sigma, residualZ) {
  const inSeason = sigma > 0 && seasonalVal > 0.3 * sigma // 시즌 위쪽
  const isAnom = residualZ >= 2.0
  if (inSeason && isAnom) return 'in_season_anomaly'
  if (!inSeason && isAnom) return 'out_of_season_anomaly'
  if (inSeason) return 'in_season_normal'
  return 'out_of_season_normal'
}

async function runForSource(source) {
  const t0 = Date.now()
  console.log(`\n[STL] source=${source} window=${WINDOW_DAYS}d period=${PERIOD}d`)
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

  // 페이지네이션 — Supabase default 1000 cap
  let from = 0
  const pageSize = 1000
  const rows = []
  while (true) {
    const { data, error } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, volume_relative, collected_at')
      .eq('source', source)
      .gte('collected_at', since)
      .order('collected_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) {
      console.error(`  fetch error: ${error.message}`)
      return { source, decomposed: 0, error: error.message }
    }
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  console.log(`  fetched=${rows.length} rows`)

  const series = buildSeries(rows, WINDOW_DAYS)
  console.log(`  keywords with >=${MIN_SAMPLES} samples: ${series.size}`)

  if (series.size === 0) return { source, decomposed: 0 }

  const computedAt = new Date().toISOString()
  const stlRows = []

  for (const [keyword, { values, nObs }] of series.entries()) {
    const obsFinite = values.filter(Number.isFinite)
    const mu = mean(obsFinite)
    const sigma = stddev(obsFinite, mu)
    const { trend, seasonal, residual, seasonIdx } = decompose(values, PERIOD)

    // pick the most recent valid index
    let idx = -1
    for (let i = values.length - 1; i >= 0; i--) {
      if (Number.isFinite(values[i]) && trend[i] != null && residual[i] != null) {
        idx = i
        break
      }
    }
    if (idx === -1) continue

    const observed = values[idx]
    const tVal = trend[idx]
    const sVal = seasonal[idx]
    const rVal = residual[idx]

    // residual sigma — std of residuals across window
    const residFinite = residual.filter((x) => x != null && Number.isFinite(x))
    const rMu = mean(residFinite)
    const rSigma = stddev(residFinite, rMu)
    const residualZ = rSigma > 0 ? (rVal - rMu) / rSigma : 0

    const trendFinite = trend.filter((x) => x != null && Number.isFinite(x))
    const tMu = mean(trendFinite)
    const tSigma = stddev(trendFinite, tMu)
    const trendZ = tSigma > 0 ? (tVal - tMu) / tSigma : 0

    // seasonal phase — relative amplitude
    const seasonAbs = seasonIdx.map(Math.abs)
    const seasonalPhase = sigma > 0 ? Math.abs(sVal) / sigma : 0

    const inSeason = sigma > 0 && sVal > 0.3 * sigma
    const anomalyLabel = labelAnomaly(sVal, sigma, residualZ)

    stlRows.push({
      keyword,
      source,
      period: PERIOD,
      window_days: WINDOW_DAYS,
      observed: round(observed),
      trend: round(tVal),
      seasonal: round(sVal),
      residual: round(rVal),
      trend_z: round(trendZ),
      seasonal_phase: round(seasonalPhase),
      residual_z: round(residualZ),
      in_season: inSeason,
      anomaly_label: anomalyLabel,
      n_samples: nObs,
      computed_at: computedAt,
    })
  }

  // batch insert
  let inserted = 0
  for (let i = 0; i < stlRows.length; i += BATCH_INSERT) {
    const chunk = stlRows.slice(i, i + BATCH_INSERT)
    const { error } = await sb.from('jimscanner_trends_stl').insert(chunk)
    if (error) {
      console.error(`  insert error (chunk ${i}): ${error.message}`)
      break
    }
    inserted += chunk.length
  }

  console.log(`  inserted=${inserted} elapsed=${Date.now() - t0}ms`)
  return { source, decomposed: stlRows.length, inserted }
}

function round(x) {
  if (x == null || !Number.isFinite(x)) return null
  return Math.round(x * 1000) / 1000
}

async function recordRun(status, info) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'stl_decompose',
      status,
      fetched_count: info.fetched ?? 0,
      inserted_count: info.inserted ?? 0,
      duration_ms: info.elapsed ?? null,
      error_message: info.error ?? null,
      triggered_by: 'cli',
      finished_at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('failed to log run:', e?.message ?? e)
  }
}

async function main() {
  const t0 = Date.now()
  let totalFetched = 0
  let totalInserted = 0
  let lastError = null

  for (const src of SOURCES) {
    try {
      const r = await runForSource(src)
      totalFetched += r.decomposed ?? 0
      totalInserted += r.inserted ?? 0
      if (r.error) lastError = r.error
    } catch (e) {
      lastError = e?.message ?? String(e)
      console.error(`[STL] source=${src} failed:`, lastError)
    }
  }

  const status = lastError ? 'partial' : 'ok'
  await recordRun(status, {
    fetched: totalFetched,
    inserted: totalInserted,
    elapsed: Date.now() - t0,
    error: lastError,
  })
  console.log(
    `\n[STL] done in ${Date.now() - t0}ms · decomposed=${totalFetched} · inserted=${totalInserted}`,
  )
}

main().catch((e) => {
  console.error('[STL] fatal:', e)
  process.exit(1)
})
