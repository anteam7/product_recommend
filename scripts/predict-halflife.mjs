#!/usr/bin/env node
/**
 * 트렌드 반감기(T½) 예측 — cosine analog 매칭.
 *
 * 알고리즘 (method='cosine_analog_v1'):
 *  1) 활성(active) 후보: jimscanner_trends_scores 에 최근 8주 내 row 가 있고,
 *     최신 final_score >= 30 인 상품.
 *  2) 종료(analog) 풀: 최근 6주간 row 가 없는, 과거 full-lifecycle 을 가진 상품.
 *  3) 후보의 초기 4주 final_score 벡터를 종료 풀의 초기 4주 벡터와 cosine 유사도 측정.
 *     sim >= 0.85 인 analog 만 채택.
 *  4) 채택된 각 analog 의 실제 T½(점수가 첫 피크 대비 50% 로 떨어진 주차) 분포에서
 *     중앙값을 t_half_weeks, 10·90 백분위를 ci_low·ci_high 로.
 *  5) analog_count >= 8 → confidence='high', >=3 → 'mid', else 'low'.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/predict-halflife.mjs
 *   node --env-file=.env.local scripts/predict-halflife.mjs --dry
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
const DRY = args.includes('--dry')

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const INITIAL_WINDOW_WEEKS = 4         // 초기 패턴 비교 길이
const ACTIVE_RECENT_WEEKS = 8           // 활성 후보 기준
const ANALOG_DORMANT_WEEKS = 6          // 종료 트렌드 기준
const SIMILARITY_THRESHOLD = 0.85
const MIN_PEAK_DROP_FOR_HALFLIFE = 0.5  // 50% 까지 떨어진 시점을 T½ 로

function isoWeekFloor(ts) {
  const d = new Date(ts)
  d.setUTCHours(0, 0, 0, 0)
  const day = d.getUTCDay()
  // 월요일 기준 주
  const diff = (day + 6) % 7
  d.setUTCDate(d.getUTCDate() - diff)
  return d.getTime()
}

function bucketByWeek(rows) {
  // rows: [{ final_score, computed_at }] (오래된 → 최신 순)
  if (rows.length === 0) return []
  const startWeek = isoWeekFloor(rows[0].computed_at)
  const buckets = new Map()
  for (const r of rows) {
    const w = Math.round((isoWeekFloor(r.computed_at) - startWeek) / WEEK_MS)
    if (w < 0) continue
    const cur = buckets.get(w) ?? { sum: 0, n: 0 }
    cur.sum += Number(r.final_score)
    cur.n += 1
    buckets.set(w, cur)
  }
  const maxW = Math.max(...buckets.keys())
  const out = new Array(maxW + 1).fill(0)
  let lastVal = 0
  for (let i = 0; i <= maxW; i++) {
    const b = buckets.get(i)
    if (b) {
      lastVal = b.sum / b.n
      out[i] = lastVal
    } else {
      // 빈 주차는 직전 값을 carry (점수 시계열은 보통 carry 가 자연스러움)
      out[i] = lastVal
    }
  }
  return out
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function findHalflifeWeek(series) {
  // series: 주차별 평균 final_score (idx 0 = 시작주)
  if (series.length < 2) return null
  // 첫 피크 찾기 (시작 ~ argmax)
  let peakIdx = 0
  let peak = series[0]
  for (let i = 1; i < series.length; i++) {
    if (series[i] > peak) {
      peak = series[i]
      peakIdx = i
    }
  }
  const target = peak * MIN_PEAK_DROP_FOR_HALFLIFE
  for (let i = peakIdx + 1; i < series.length; i++) {
    if (series[i] <= target) return i - peakIdx
  }
  return null // 절반 이하로 떨어지지 않음 (still hot)
}

console.log(`[${new Date().toISOString()}] predict-halflife start (dry=${DRY})`)

// 1) 모든 product_id 의 score 시계열 조회 — 페이지네이션
const PAGE = 1000
const allScores = []
for (let from = 0; ; from += PAGE) {
  const { data, error } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) {
    console.error('scores fetch error:', error.message)
    process.exit(1)
  }
  if (!data || data.length === 0) break
  allScores.push(...data)
  if (data.length < PAGE) break
}

const byProduct = new Map()
for (const s of allScores) {
  const arr = byProduct.get(s.product_id) ?? []
  arr.push(s)
  byProduct.set(s.product_id, arr)
}
console.log(`  loaded ${allScores.length} scores across ${byProduct.size} products`)

const now = Date.now()
const activeCutoff = now - ACTIVE_RECENT_WEEKS * WEEK_MS
const dormantCutoff = now - ANALOG_DORMANT_WEEKS * WEEK_MS

const actives = [] // { productId, series, latestScore, weeks }
const analogs = [] // { productId, initialVec, halflifeWeeks }

for (const [pid, rows] of byProduct) {
  if (rows.length < 2) continue
  const series = bucketByWeek(rows)
  if (series.length === 0) continue
  const lastTs = new Date(rows[rows.length - 1].computed_at).getTime()
  const latestScore = Number(rows[rows.length - 1].final_score)

  if (lastTs >= activeCutoff && latestScore >= 30) {
    actives.push({
      productId: pid,
      series,
      latestScore,
      weeks: series.length,
      initial: series.slice(0, INITIAL_WINDOW_WEEKS),
    })
  } else if (lastTs < dormantCutoff && series.length >= INITIAL_WINDOW_WEEKS + 2) {
    const halflife = findHalflifeWeek(series)
    if (halflife != null && halflife > 0) {
      analogs.push({
        productId: pid,
        initialVec: series.slice(0, INITIAL_WINDOW_WEEKS),
        halflifeWeeks: halflife,
      })
    }
  }
}

console.log(`  actives=${actives.length} analogs=${analogs.length}`)

// 2) active 각각에 대해 analog 매칭
const forecasts = []
for (const a of actives) {
  if (a.initial.length < 2) continue
  const matches = []
  for (const an of analogs) {
    if (an.initialVec.length < 2) continue
    const sim = cosine(a.initial, an.initialVec)
    if (sim >= SIMILARITY_THRESHOLD) {
      matches.push({ id: an.productId, sim, hl: an.halflifeWeeks })
    }
  }

  let tHalf = null
  let ciLow = null
  let ciHigh = null
  let confidence = 'low'

  if (matches.length > 0) {
    const sortedHl = matches.map((m) => m.hl).sort((x, y) => x - y)
    tHalf = percentile(sortedHl, 0.5)
    ciLow = percentile(sortedHl, 0.1)
    ciHigh = percentile(sortedHl, 0.9)
    if (matches.length >= 8) confidence = 'high'
    else if (matches.length >= 3) confidence = 'mid'
    else confidence = 'low'
  }

  forecasts.push({
    product_id: a.productId,
    t_half_weeks: tHalf,
    ci_low: ciLow,
    ci_high: ciHigh,
    analog_ids: matches.map((m) => m.id),
    analog_count: matches.length,
    confidence,
    current_score: a.latestScore,
    weeks_observed: a.weeks,
    method: 'cosine_analog_v1',
  })
}

console.log(`  computed ${forecasts.length} forecasts`)
if (DRY) {
  for (const f of forecasts.slice(0, 5)) {
    console.log(' ', JSON.stringify(f))
  }
  process.exit(0)
}

if (forecasts.length === 0) {
  console.log('  nothing to insert.')
  process.exit(0)
}

// 3) 배치 insert (chunk 500)
const CHUNK = 500
let inserted = 0
for (let i = 0; i < forecasts.length; i += CHUNK) {
  const batch = forecasts.slice(i, i + CHUNK)
  const { error } = await sb.from('jimscanner_trends_halflife_forecasts').insert(batch)
  if (error) {
    console.error('insert error:', error.message)
    process.exit(1)
  }
  inserted += batch.length
}
console.log(`[${new Date().toISOString()}] inserted ${inserted} forecasts`)
process.exit(0)
