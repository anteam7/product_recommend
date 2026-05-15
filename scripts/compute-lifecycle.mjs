#!/usr/bin/env node
/**
 * compute-lifecycle.mjs
 * 매일 KST 06:30 cron — jimscanner_trends_scores 시계열 → jimscanner_trends_lifecycle 단계 라벨.
 *
 * 단계 규칙 (precedence):
 *   sample_count < 3                                  → 'emerging' (히스토리 부족)
 *   z_recent > 1 && slope_7d > 0 && sample_count < 8  → 'emerging'
 *   slope_7d > 0.5 && slope_28d >= 0                  → 'rising'
 *   peak_lag_days <= 3 && latest_score >= peak * 0.9  → 'peak'
 *   slope_7d < -0.5 && peak_lag_days >= 7             → 'declining'
 *   else if latest_score < 20 && |slope_28d| < 0.3    → 'dormant'
 *   else                                              → 'rising' (보수 fallback)
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const started = Date.now()
const runStart = new Date().toISOString()

async function main() {
  // 시계열 fetch — 최근 60일치
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const { data: scores, error } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })
    .limit(50000)

  if (error) throw error

  // product_id 별로 시계열 묶기
  const byProduct = new Map()
  for (const r of scores ?? []) {
    let arr = byProduct.get(r.product_id)
    if (!arr) { arr = []; byProduct.set(r.product_id, arr) }
    arr.push({ score: Number(r.final_score), t: new Date(r.computed_at).getTime() })
  }

  const now = Date.now()
  const rows = []
  for (const [productId, series] of byProduct) {
    const stats = computeStats(series, now)
    const stage = classify(stats)
    rows.push({
      product_id: productId,
      stage,
      latest_score: round2(stats.latest),
      slope_7d: round3(stats.slope7d),
      slope_28d: round3(stats.slope28d),
      z_recent: round3(stats.zRecent),
      peak_score: round2(stats.peak),
      peak_lag_days: stats.peakLagDays,
      sample_count: stats.n,
      computed_at: runStart,
    })
  }

  console.log(`[lifecycle] products: ${rows.length}`)
  // 단계별 분포
  const dist = rows.reduce((acc, r) => { acc[r.stage] = (acc[r.stage] ?? 0) + 1; return acc }, {})
  console.log('[lifecycle] distribution:', dist)

  // batch upsert (insert — 시계열 보존, 같은 computed_at 단일 batch)
  let inserted = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error: insErr } = await sb.from('jimscanner_trends_lifecycle').insert(chunk)
    if (insErr) {
      console.error('[lifecycle] insert error', insErr)
      break
    }
    inserted += chunk.length
  }

  await sb.from('jimscanner_trends_runs').insert({
    source: 'lifecycle_compute',
    status: inserted === rows.length ? 'ok' : (inserted === 0 ? 'error' : 'partial'),
    fetched_count: byProduct.size,
    inserted_count: inserted,
    duration_ms: Date.now() - started,
    triggered_by: 'cron',
    started_at: runStart,
    finished_at: new Date().toISOString(),
  })

  console.log(`[lifecycle] done: ${inserted}/${rows.length} in ${Date.now() - started}ms`)
}

function computeStats(series, now) {
  series.sort((a, b) => a.t - b.t)
  const n = series.length
  const latest = n > 0 ? series[n - 1].score : 0
  const day = 86400_000

  // peak
  let peak = -Infinity, peakT = now
  for (const p of series) { if (p.score > peak) { peak = p.score; peakT = p.t } }
  if (!isFinite(peak)) peak = 0
  const peakLagDays = Math.max(0, Math.round((now - peakT) / day))

  // slope: 단순 선형회귀 (day 단위 기울기)
  const slope7d = linearSlope(series.filter((p) => now - p.t <= 7 * day))
  const slope28d = linearSlope(series.filter((p) => now - p.t <= 28 * day))

  // z_recent — 최근 7일 평균 vs 전체 평균/표준편차
  const recent = series.filter((p) => now - p.t <= 7 * day)
  const recentAvg = recent.length > 0 ? mean(recent.map((p) => p.score)) : latest
  const allScores = series.map((p) => p.score)
  const mu = mean(allScores)
  const sigma = stddev(allScores, mu)
  const zRecent = sigma > 0 ? (recentAvg - mu) / sigma : 0

  return { latest, peak, peakLagDays, slope7d, slope28d, zRecent, n }
}

function linearSlope(pts) {
  if (pts.length < 2) return 0
  const day = 86400_000
  const t0 = pts[0].t
  const xs = pts.map((p) => (p.t - t0) / day)
  const ys = pts.map((p) => p.score)
  const xbar = mean(xs)
  const ybar = mean(ys)
  let num = 0, den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xbar) * (ys[i] - ybar)
    den += (xs[i] - xbar) ** 2
  }
  if (den === 0) return 0
  return num / den
}

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0 }
function stddev(arr, mu) {
  if (arr.length <= 1) return 0
  const v = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1)
  return Math.sqrt(v)
}

function classify(s) {
  if (s.n < 3) return 'emerging'
  if (s.zRecent > 1 && s.slope7d > 0 && s.n < 8) return 'emerging'
  if (s.slope7d > 0.5 && s.slope28d >= 0) return 'rising'
  if (s.peakLagDays <= 3 && s.peak > 0 && s.latest >= s.peak * 0.9) return 'peak'
  if (s.slope7d < -0.5 && s.peakLagDays >= 7) return 'declining'
  if (s.latest < 20 && Math.abs(s.slope28d) < 0.3) return 'dormant'
  if (s.slope7d > 0) return 'rising'
  if (s.slope7d < 0) return 'declining'
  return 'peak'
}

function round2(n) { return Math.round(n * 100) / 100 }
function round3(n) { return Math.round(n * 1000) / 1000 }

main().catch((e) => {
  console.error('[lifecycle] fatal', e)
  process.exit(1)
})
