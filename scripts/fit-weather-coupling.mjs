#!/usr/bin/env node
/**
 * 핀(product) 단위 lag 기상 회귀 fit — jimscanner_trends_weather_coupling
 *
 * 사용:
 *   node --env-file=.env.local scripts/fit-weather-coupling.mjs
 *
 * 입력:
 *   - jimscanner_trends_keywords (pinned=true 상품들의 시계열)
 *   - jimscanner_weather_daily (forecast=false 우선, 없으면 forecast=true 도 사용)
 *
 * 출력:
 *   - jimscanner_trends_weather_coupling (각 product × lead_days × weather_var 행)
 *   - R²≥0.3 인 행만 채택 (그 외 skip)
 *
 * 회귀:
 *   - 단순 단변수 릿지 회귀 (lambda=1.0). lag/lead 기준은 weather(t - lead_days) → demand(t).
 *   - n_obs < 7 면 skip.
 */

import { createClient } from '@supabase/supabase-js'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB_URL || !SB_KEY) {
  console.error('supabase env missing')
  process.exit(1)
}

const sb = createClient(SB_URL, SB_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const LEAD_DAYS = [0, 1, 2, 3, 5, 7]
const WEATHER_VARS = ['tmin', 'tmax', 'tavg', 'humidity', 'precip', 'feels_like']
const R2_THRESHOLD = 0.3
const LAMBDA = 1.0
const LOOKBACK_DAYS = 60

const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()

// 1) 기상 시계열 로드 — 같은 (date, region) 에서 forecast=false 가 있으면 우선.
const { data: weatherRows, error: wErr } = await sb
  .from('jimscanner_weather_daily')
  .select('date, region, tmin, tmax, tavg, humidity, precip, feels_like, forecast')
  .gte('date', since.slice(0, 10))
  .order('date', { ascending: true })

if (wErr) {
  console.error(`[fit] weather load error: ${wErr.message}`)
  process.exit(1)
}

const weatherByDate = new Map()
for (const r of weatherRows ?? []) {
  const existing = weatherByDate.get(r.date)
  if (!existing || (existing.forecast && !r.forecast)) {
    weatherByDate.set(r.date, r)
  }
}
if (weatherByDate.size < 7) {
  console.log(`[fit] insufficient weather data (${weatherByDate.size} days) — exiting`)
  process.exit(0)
}

// 2) 핀 상품 시계열 로드
//   jimscanner_trends_keywords 의 pinned=true 인 keyword 들을 product 매핑.
const { data: pinned, error: pErr } = await sb
  .from('jimscanner_trends_keywords')
  .select('keyword, volume_relative, collected_at')
  .eq('pinned', true)
  .gte('collected_at', since)

if (pErr) {
  console.error(`[fit] pinned load error: ${pErr.message}`)
  process.exit(1)
}

const pinnedKeywords = [...new Set((pinned ?? []).map((r) => r.keyword))]
if (pinnedKeywords.length === 0) {
  console.log(`[fit] no pinned keywords — exiting`)
  process.exit(0)
}

// keyword → product_id 매핑 (alias 테이블)
const { data: aliases } = await sb
  .from('jimscanner_trends_aliases')
  .select('alias, product_id')
  .in('alias', pinnedKeywords)

const kw2pid = new Map()
for (const a of aliases ?? []) kw2pid.set(a.alias, a.product_id)

// product_id → 일별 평균 volume_relative
const seriesByPid = new Map()
for (const row of pinned ?? []) {
  const pid = kw2pid.get(row.keyword)
  if (!pid) continue
  const d = row.collected_at?.slice(0, 10)
  if (!d) continue
  let m = seriesByPid.get(pid)
  if (!m) {
    m = new Map()
    seriesByPid.set(pid, m)
  }
  const v = m.get(d) ?? { sum: 0, n: 0 }
  v.sum += Number(row.volume_relative) || 0
  v.n += 1
  m.set(d, v)
}

// 3) 회귀 fit
function ridgeFit(xs, ys, lambda = 1.0) {
  // 단변수 릿지: beta = sum((x-xm)*(y-ym)) / (sum((x-xm)^2) + lambda)
  const n = xs.length
  if (n < 2) return null
  const xm = xs.reduce((a, b) => a + b, 0) / n
  const ym = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xm
    const dy = ys[i] - ym
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  const beta = sxy / (sxx + lambda)
  const intercept = ym - beta * xm
  // R^2 (predicted - actual)
  let ssRes = 0
  for (let i = 0; i < n; i++) {
    const yhat = intercept + beta * xs[i]
    const e = ys[i] - yhat
    ssRes += e * e
  }
  const r2 = Math.max(0, 1 - ssRes / syy)
  return { beta, intercept, r2 }
}

const inserts = []
let evaluated = 0

for (const [pid, dayMap] of seriesByPid.entries()) {
  // 일별 평균
  const demand = new Map()
  for (const [d, v] of dayMap.entries()) {
    demand.set(d, v.sum / v.n)
  }
  for (const lead of LEAD_DAYS) {
    for (const varName of WEATHER_VARS) {
      // (x = weather[d - lead], y = demand[d])
      const xs = []
      const ys = []
      for (const [d, y] of demand.entries()) {
        const dt = new Date(d + 'T00:00:00Z')
        dt.setUTCDate(dt.getUTCDate() - lead)
        const wd = dt.toISOString().slice(0, 10)
        const w = weatherByDate.get(wd)
        const x = w?.[varName]
        if (x == null || y == null) continue
        xs.push(Number(x))
        ys.push(Number(y))
      }
      if (xs.length < 7) continue
      evaluated++
      const fit = ridgeFit(xs, ys, LAMBDA)
      if (!fit) continue
      if (fit.r2 < R2_THRESHOLD) continue
      inserts.push({
        product_id: pid,
        lead_days: lead,
        weather_var: varName,
        beta: fit.beta,
        intercept: fit.intercept,
        r2: fit.r2,
        n_obs: xs.length,
        sample: { x_mean: xs.reduce((a, b) => a + b, 0) / xs.length, y_mean: ys.reduce((a, b) => a + b, 0) / ys.length },
      })
    }
  }
}

console.log(`[fit] evaluated ${evaluated} (pid×lead×var) combos, accepted ${inserts.length} (r2≥${R2_THRESHOLD})`)

if (inserts.length > 0) {
  // 청크 단위 insert
  const CHUNK = 200
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const slice = inserts.slice(i, i + CHUNK)
    const { error } = await sb.from('jimscanner_trends_weather_coupling').insert(slice)
    if (error) {
      console.error(`[fit] insert error: ${error.message}`)
      process.exit(1)
    }
  }
}

console.log(`[fit] done`)
