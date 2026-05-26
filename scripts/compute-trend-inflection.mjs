#!/usr/bin/env node
/**
 * 트렌드 score 시계열 2차미분(변곡점) 계산기.
 *
 * jimscanner_trends_scores 가 매 recompute 마다 누적해 둔 row 를 읽어,
 * product_id × score_kind('final'/'trend'/'commerce'/'supplier'/'competition')
 * 별로:
 *   - 최근 7일 회귀 slope_7d (1차 미분)
 *   - 그 직전 7일 회귀 slope 와의 차이 accel_7d (2차 미분)
 *   - 사분면(accel_up / decel_up / accel_down / decel_down / flat)
 *   - rank_score = |slope| * |accel|
 * 을 산출해 jimscanner_trends_inflection 에 upsert.
 *
 * 사용:
 *   node --env-file=.env.local scripts/compute-trend-inflection.mjs
 *
 * 환경: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

const SCORE_KINDS = /** @type {const} */ (['final', 'trend', 'commerce', 'supplier', 'competition'])
const SCORE_COLUMNS = {
  final: 'final_score',
  trend: 'trend_score',
  commerce: 'commerce_score',
  supplier: 'supplier_score',
  competition: 'competition_score',
}

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_DAYS = 7
const FLAT_SLOPE_EPS = 0.05
const FLAT_ACCEL_EPS = 0.05
const FETCH_DAYS = 21 // 최근 21일 row 만 가져옴 (현재+직전 window 커버)
const PAGE_SIZE = 1000

// 단순 OLS slope (y = a + b*x). x 는 day index (가장 오래된 = 0).
// 표본 0~1개면 0 반환.
function linearSlope(points) {
  const n = points.length
  if (n < 2) return 0
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  for (const [x, y] of points) {
    sx += x
    sy += y
    sxy += x * y
    sxx += x * x
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return 0
  return (n * sxy - sx * sy) / denom
}

function classifyQuadrant(slope, accel) {
  if (Math.abs(slope) < FLAT_SLOPE_EPS) return 'flat'
  if (slope > 0) return accel > FLAT_ACCEL_EPS ? 'accel_up' : 'decel_up'
  return accel < -FLAT_ACCEL_EPS ? 'accel_down' : 'decel_down'
}

async function fetchAllScores() {
  const sinceIso = new Date(Date.now() - FETCH_DAYS * DAY_MS).toISOString()
  let from = 0
  const all = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb
      .from('jimscanner_trends_scores')
      .select(
        'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at',
      )
      .gte('computed_at', sinceIso)
      .order('computed_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

function computeForProduct(rows, kind) {
  const col = SCORE_COLUMNS[kind]
  const now = Date.now()
  const windowMs = WINDOW_DAYS * DAY_MS

  // (currentWindow) 최근 7일, (prevWindow) 그 직전 7일
  const cur = []
  const prev = []
  for (const r of rows) {
    const t = new Date(r.computed_at).getTime()
    const ageDays = (now - t) / DAY_MS
    const y = Number(r[col])
    if (!Number.isFinite(y)) continue
    // x 좌표: 가장 오래된 게 0 이 되도록 (day 단위, 음수 부호 뒤집기 위해)
    if (ageDays <= WINDOW_DAYS) {
      cur.push([WINDOW_DAYS - ageDays, y])
    } else if (ageDays <= 2 * WINDOW_DAYS) {
      prev.push([2 * WINDOW_DAYS - ageDays, y])
    }
  }

  if (cur.length === 0) return null
  // latest = 가장 최근 row
  const latest = rows.reduce((acc, r) => {
    if (!acc) return r
    return new Date(r.computed_at) > new Date(acc.computed_at) ? r : acc
  }, null)
  const latestScore = Number(latest[col])
  if (!Number.isFinite(latestScore)) return null

  const slopeCur = linearSlope(cur)
  const slopePrev = prev.length >= 2 ? linearSlope(prev) : 0
  const accel = slopeCur - slopePrev

  const quadrant = classifyQuadrant(slopeCur, accel)
  const rankScore = Math.abs(slopeCur) * Math.abs(accel)

  return {
    score_kind: kind,
    latest_score: round2(latestScore),
    slope_7d: round4(slopeCur),
    accel_7d: round4(accel),
    sample_count: cur.length + prev.length,
    quadrant,
    rank_score: round4(rankScore),
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}
function round4(n) {
  return Math.round(n * 10000) / 10000
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] fetching trends_scores rows (last ${FETCH_DAYS}d)`)
  const rows = await fetchAllScores()
  console.log(`  fetched ${rows.length} score rows`)

  const byProduct = new Map()
  for (const r of rows) {
    const arr = byProduct.get(r.product_id) ?? []
    arr.push(r)
    byProduct.set(r.product_id, arr)
  }
  console.log(`  ${byProduct.size} unique products`)

  const upserts = []
  for (const [productId, prodRows] of byProduct.entries()) {
    for (const kind of SCORE_KINDS) {
      const result = computeForProduct(prodRows, kind)
      if (!result) continue
      upserts.push({
        product_id: productId,
        ...result,
        computed_at: new Date().toISOString(),
      })
    }
  }

  console.log(`  upserting ${upserts.length} inflection rows`)
  let inserted = 0
  for (let i = 0; i < upserts.length; i += 500) {
    const chunk = upserts.slice(i, i + 500)
    const { error } = await sb
      .from('jimscanner_trends_inflection')
      .upsert(chunk, { onConflict: 'product_id,score_kind' })
    if (error) {
      console.error('  upsert error:', error.message)
      process.exit(1)
    }
    inserted += chunk.length
  }

  const elapsed = Date.now() - t0
  console.log(
    `[${new Date().toISOString()}] done — ${inserted} rows upserted in ${elapsed}ms`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
