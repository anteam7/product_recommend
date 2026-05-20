#!/usr/bin/env node
/**
 * sample-review-curves.mjs
 *
 * 카테고리별 SERP 상위 셀러의 리뷰 누적 곡선을 백테스트로 추정해,
 * jimscanner_trends_review_velocity 테이블을 채운다.
 *
 * 실측 SERP 크롤링 인프라가 아직 없으므로 1차 구현은:
 *  1) jimscanner_trends_scores 의 최근 30일 score 분포에서
 *     category_top 별 상위 SERP 가설 셀러군을 뽑아
 *  2) commerce_score / supplier_score / final_score 를 proxy 로
 *     리뷰 누적 곡선의 형태 (logistic-ish, 첫주 폭발 → 감쇠) 를 합성한다.
 *  3) day_bucket = [7,14,30,60,90,120,180] 에서 p50/p90 분위를 계산.
 *
 * 실측 크롤러가 붙으면 1)을 raw 리뷰 카운트 시계열로 교체한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/sample-review-curves.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. Run with --env-file=.env.local')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const DAY_BUCKETS = [7, 14, 30, 60, 90, 120, 180]

/**
 * commerce / supplier / final score 를 proxy 로 리뷰 누적 곡선 합성.
 * - 카테고리에 commerce 가 강하면 첫 30일에 더 빨리 누적된다 가정.
 * - 누적 = saturation * (1 - exp(-k * day))
 *   saturation ≈ commerce * 10 + final * 5
 *   k         ≈ 0.01 + commerce/2000 (commerce 높을수록 빨리 차오름)
 */
function syntheticReviewCurve(score, day) {
  const commerce = Number(score.commerce_score ?? 0)
  const final = Number(score.final_score ?? 0)
  const supplier = Number(score.supplier_score ?? 0)
  const saturation = Math.max(20, commerce * 10 + final * 5 + supplier * 2)
  const k = 0.01 + commerce / 2000
  return Math.round(saturation * (1 - Math.exp(-k * day)))
}

function quantile(arr, q) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] sampling review velocity curves…`)

  // 최근 30일 score 추출 (product 별 latest)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: scores, error: scoresErr } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, commerce_score, supplier_score, final_score, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: false })
    .limit(5000)

  if (scoresErr) {
    console.error('scores fetch error:', scoresErr.message)
    process.exit(1)
  }

  const seen = new Set()
  const latest = []
  for (const s of scores ?? []) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  if (latest.length === 0) {
    console.log('  no scores in last 30d — skipping')
    process.exit(0)
  }

  const productIds = latest.map((s) => s.product_id)
  const { data: products, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, category_top')
    .in('id', productIds)

  if (prodErr) {
    console.error('products fetch error:', prodErr.message)
    process.exit(1)
  }

  const catById = new Map((products ?? []).map((p) => [p.id, p.category_top]))

  // category_top 별로 묶기
  const byCat = new Map()
  for (const s of latest) {
    const cat = catById.get(s.product_id) ?? 'all'
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(s)
  }

  const computedAt = new Date().toISOString()
  const rows = []
  for (const [cat, group] of byCat.entries()) {
    if (group.length < 3) continue // 표본 부족 → 스킵
    for (const day of DAY_BUCKETS) {
      const samples = group.map((s) => syntheticReviewCurve(s, day))
      rows.push({
        category_top: cat,
        day_bucket: day,
        reviews_p50: Number(quantile(samples, 0.5).toFixed(2)),
        reviews_p90: Number(quantile(samples, 0.9).toFixed(2)),
        samples_n: samples.length,
        computed_at: computedAt,
      })
    }
  }

  if (rows.length === 0) {
    console.log('  no category groups large enough — skipping insert')
    process.exit(0)
  }

  const { error: insErr } = await sb
    .from('jimscanner_trends_review_velocity')
    .insert(rows)

  if (insErr) {
    console.error('insert error:', insErr.message)
    process.exit(1)
  }

  const elapsed = Date.now() - t0
  console.log(
    `[${new Date().toISOString()}] inserted ${rows.length} rows across ${byCat.size} categories in ${elapsed}ms`,
  )
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
