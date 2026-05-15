#!/usr/bin/env node
/**
 * 계절성·신규성 분해 — 매년 반복되는 시즌 스파이크 vs 진짜 신규 트렌드.
 *
 * jimscanner_trends_keywords 의 source IN ('naver_search_trend', 'naver_shopping_insight')
 * 시계열을 jimscanner_trends_aliases 로 product_id 매핑한 뒤
 * (year, week_of_year) 단위로 평균/표준편차 베이스라인을 계산한다.
 *
 * 산식:
 *   value(p, y, w)        = mean(volume_relative WHERE alias matches p AND iso year=y AND iso week=w)
 *   baseline_mean(p, w)   = mean(value(p, y', w))  for y' in past years (y' < y)
 *   baseline_std(p, w)    = stddev_pop(value(p, y', w))  for y' < y
 *   novelty_z(p, y, w)    = (value - baseline_mean) / max(baseline_std, ε)
 *   seasonality_recurrence(p, w) = clamp01(baseline_mean(p, w) / yearly_mean(p))
 *     · 1 에 가까울수록 매년 같은 주차에 반복되는 시즌 상품
 *     · 0 에 가까울수록 동주차 베이스라인이 평년 평균 대비 낮음 (시즌성 없음)
 *
 * 점수 컴포넌트 반영:
 *   jimscanner_trends_scores.score_components.trend.seasonality_recurrence (0~1)
 *   jimscanner_trends_scores.score_components.trend.novelty_z (signed, ~-3..+3)
 *
 * 호출:
 *   node --env-file=.env.local scripts/decompose-seasonality.mjs
 *
 * 실행 시점: 매일 KST 03:00 직전 (classify-trends-llm.mjs 후), run-crons 마지막 단계.
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

const SOURCES = ['naver_search_trend', 'naver_shopping_insight']
const FETCH_BATCH = 1000
const HISTORY_DAYS = 365 * 4 + 30   // 약 4년치 (동주차 베이스라인 위해 최소 2년 권장)

function isoWeek(d) {
  // ISO 8601 week-of-year. d 가 KST 라고 가정 (collected_at 그대로 사용).
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return { year: date.getUTCFullYear(), week: weekNo }
}

async function loadAliases() {
  // alias text → product_id 맵. 쿼리 keyword 가 alias 와 정확히 일치해야 매핑됨.
  const map = new Map()
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('jimscanner_trends_aliases')
      .select('alias, product_id')
      .range(from, from + FETCH_BATCH - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const r of data) {
      // 같은 alias 가 두 product 에 매핑되는 경우는 첫 번째 keep (confidence 정렬은 따로 안 함)
      if (!map.has(r.alias)) map.set(r.alias, r.product_id)
    }
    if (data.length < FETCH_BATCH) break
    from += FETCH_BATCH
  }
  return map
}

async function loadKeywordTimeseries(sinceIso) {
  // (keyword, source, volume_relative, collected_at) — 최근 HISTORY_DAYS
  const rows = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, source, volume_relative, collected_at')
      .in('source', SOURCES)
      .gte('collected_at', sinceIso)
      .not('volume_relative', 'is', null)
      .range(from, from + FETCH_BATCH - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const r of data) rows.push(r)
    if (data.length < FETCH_BATCH) break
    from += FETCH_BATCH
  }
  return rows
}

function aggregate(rows, aliasMap) {
  // bucket: product_id → year → week → { sum, count }
  const buckets = new Map()
  for (const r of rows) {
    const pid = aliasMap.get(r.keyword)
    if (!pid) continue
    const v = Number(r.volume_relative)
    if (!Number.isFinite(v)) continue
    const { year, week } = isoWeek(new Date(r.collected_at))
    let byYear = buckets.get(pid)
    if (!byYear) { byYear = new Map(); buckets.set(pid, byYear) }
    let byWeek = byYear.get(year)
    if (!byWeek) { byWeek = new Map(); byYear.set(year, byWeek) }
    let agg = byWeek.get(week)
    if (!agg) { agg = { sum: 0, count: 0 }; byWeek.set(week, agg) }
    agg.sum += v
    agg.count += 1
  }
  return buckets
}

function computeBaselines(buckets) {
  // 각 (product_id, year, week) 에 대해 동일 week 의 다른 year 평균/std 계산.
  const out = []
  for (const [productId, byYear] of buckets) {
    // 동주차 lookup table: week → [{year, value}]
    const byWeek = new Map()
    let allValues = []
    for (const [year, weeks] of byYear) {
      for (const [week, agg] of weeks) {
        const value = agg.sum / agg.count
        if (!byWeek.has(week)) byWeek.set(week, [])
        byWeek.get(week).push({ year, value })
        allValues.push(value)
      }
    }
    const yearlyMean = allValues.length > 0
      ? allValues.reduce((a, b) => a + b, 0) / allValues.length
      : 0

    for (const [year, weeks] of byYear) {
      for (const [week, agg] of weeks) {
        const value = agg.sum / agg.count
        const sameWeekHistory = (byWeek.get(week) ?? []).filter((x) => x.year < year)
        const baselineYears = sameWeekHistory.length
        let baselineMean = null
        let baselineStd = null
        let noveltyZ = null
        if (baselineYears >= 1) {
          const m = sameWeekHistory.reduce((a, b) => a + b.value, 0) / baselineYears
          baselineMean = m
          if (baselineYears >= 2) {
            const variance =
              sameWeekHistory.reduce((acc, x) => acc + (x.value - m) ** 2, 0) / baselineYears
            baselineStd = Math.sqrt(variance)
          } else {
            // 1년치만 있으면 yearlyMean 의 25% 를 σ 의 fallback 으로 사용 (대략적 노이즈 가정)
            baselineStd = yearlyMean > 0 ? yearlyMean * 0.25 : 1
          }
          const denom = Math.max(baselineStd, 1e-3)
          noveltyZ = (value - baselineMean) / denom
        }

        // seasonality_recurrence: 동주차 평균이 평년 평균 대비 얼마나 높은가.
        // 비율 1.0 → 평년과 동일, 2.0 → 평년의 2배 (시즌성 강함).
        // clamp 후 sigmoid 로 0~1 매핑: r = clamp(ratio - 1, 0, 2) / 2.
        let seasonalityRecurrence = null
        if (baselineMean !== null && yearlyMean > 0) {
          const ratio = baselineMean / yearlyMean
          seasonalityRecurrence = Math.max(0, Math.min(1, (ratio - 1) / 1))
          // ratio 1.0 → 0, ratio 2.0 → 1.0, ratio ≥ 2.0 → 1.0
        }

        out.push({
          product_id: productId,
          year,
          week_of_year: week,
          value,
          sample_count: agg.count,
          baseline_mean: baselineMean,
          baseline_std: baselineStd,
          baseline_years: baselineYears,
          novelty_z: noveltyZ,
          seasonality_recurrence: seasonalityRecurrence,
        })
      }
    }
  }
  return out
}

async function upsertSeasonality(rows) {
  if (rows.length === 0) return 0
  let total = 0
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500).map((r) => ({
      ...r,
      computed_at: new Date().toISOString(),
    }))
    const { error } = await sb
      .from('jimscanner_trends_seasonality')
      .upsert(slice, { onConflict: 'product_id,year,week_of_year' })
    if (error) {
      console.error(`  upsert error at offset ${i}: ${error.message}`)
      throw error
    }
    total += slice.length
  }
  return total
}

async function patchScoreComponents(rows) {
  // 각 product_id 의 가장 최근 (year, week) 결과를 trend.seasonality_recurrence /
  // trend.novelty_z 로 score_components 에 머지. score row 자체는 만들지 않고
  // 가장 최근 score row 를 in-place 업데이트.
  const latestPerProduct = new Map()
  for (const r of rows) {
    const cur = latestPerProduct.get(r.product_id)
    if (!cur || r.year > cur.year || (r.year === cur.year && r.week_of_year > cur.week_of_year)) {
      latestPerProduct.set(r.product_id, r)
    }
  }
  let patched = 0
  for (const [productId, r] of latestPerProduct) {
    const { data: latest } = await sb
      .from('jimscanner_trends_scores')
      .select('id, score_components')
      .eq('product_id', productId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) continue
    const components = (latest.score_components ?? {})
    const trendBlock = { ...(components.trend ?? {}) }
    if (r.seasonality_recurrence !== null) trendBlock.seasonality_recurrence = Number(r.seasonality_recurrence.toFixed(3))
    if (r.novelty_z !== null) trendBlock.novelty_z = Number(r.novelty_z.toFixed(3))
    const next = { ...components, trend: trendBlock }
    const { error } = await sb
      .from('jimscanner_trends_scores')
      .update({ score_components: next })
      .eq('id', latest.id)
    if (!error) patched++
  }
  return patched
}

async function main() {
  const t0 = Date.now()
  const since = new Date(Date.now() - HISTORY_DAYS * 86400_000).toISOString()
  console.log(`[seasonality] loading aliases + keyword timeseries since ${since.slice(0, 10)}`)

  const [aliasMap, rows] = await Promise.all([loadAliases(), loadKeywordTimeseries(since)])
  console.log(`[seasonality] aliases=${aliasMap.size} rows=${rows.length}`)

  const buckets = aggregate(rows, aliasMap)
  const productCount = buckets.size
  const seasonalityRows = computeBaselines(buckets)
  console.log(`[seasonality] products=${productCount} (year, week) buckets=${seasonalityRows.length}`)

  const upserted = await upsertSeasonality(seasonalityRows)
  console.log(`[seasonality] upserted ${upserted} rows`)

  const patched = await patchScoreComponents(seasonalityRows)
  console.log(`[seasonality] patched score_components for ${patched} products`)

  const elapsed = Date.now() - t0
  console.log(`[seasonality] done in ${elapsed}ms`)
}

main().catch((e) => {
  console.error(`[seasonality] FATAL: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
