#!/usr/bin/env node
/**
 * 재구매 주기(Autocorrelation) 분석 배치 — 2026-05-16
 *
 * 매일 새벽 1회 실행. jimscanner_trends_keywords 의 시계열(volume_relative)을
 * product_id 단위로 묶어 ACF(자기상관) 계산 → cycle_days / acf_peak / confidence
 * 산출 후 jimscanner_trends_repurchase_metrics 에 upsert.
 *
 * 호출:
 *   node --env-file=.env.local scripts/compute-repurchase-cycle.mjs
 *
 * 의존:
 *   - supabase/trends_v4_repurchase.sql 적용 완료
 *   - jimscanner_trends_products / jimscanner_trends_aliases 정상 동작
 *
 * 외부 라이브러리 사용 안 함 — ACF 는 순수 JS 로 구현.
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

const LOOKBACK_DAYS = 60          // 분석 윈도 (네이버 7d 이상 누적 후 안정)
const MIN_SERIES_LENGTH = 10      // 최소 시계열 길이 (이하면 skip)
const MIN_AVG_VOLUME = 1          // 평균 검색량 너무 낮으면 skip
const MAX_LAG = 35                // 최대 lag (=5주). 월 단위는 28일 근처에 잡힘
const SOURCES = ['naver_search_trend', 'naver_shopping_insight']

/**
 * 시계열 ACF 계산 — biased estimator, lag 0..maxLag.
 * 반환: number[] (acf[0]=1)
 */
function autocorrelation(series, maxLag) {
  const n = series.length
  const mean = series.reduce((s, v) => s + v, 0) / n
  const centered = series.map((v) => v - mean)
  const variance = centered.reduce((s, v) => s + v * v, 0)
  if (variance === 0) return null
  const acf = new Array(maxLag + 1).fill(0)
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i < n - lag; i++) s += centered[i] * centered[i + lag]
    acf[lag] = s / variance
  }
  return acf
}

/**
 * ACF 에서 의미 있는 peak 추출 — lag>=2 이고 양옆보다 크고 양수인 점.
 * 반환: [{lag, value}] 정렬 (value desc), 상위 5개.
 */
function findPeaks(acf) {
  const peaks = []
  for (let i = 2; i < acf.length - 1; i++) {
    if (acf[i] > 0 && acf[i] > acf[i - 1] && acf[i] >= acf[i + 1]) {
      peaks.push({ lag: i, value: acf[i] })
    }
  }
  peaks.sort((a, b) => b.value - a.value)
  return peaks.slice(0, 5)
}

/**
 * 일자 → volume 시계열로 정렬. 누락 일자는 0 으로 채움.
 */
function buildDailySeries(rows, startDate, endDate) {
  const map = new Map()
  for (const r of rows) {
    const day = r.collected_at.slice(0, 10)
    const v = Number(r.volume_relative ?? 0)
    // 동일 일자 중복 → 최댓값 (소스 여러 개)
    map.set(day, Math.max(map.get(day) ?? 0, v))
  }
  const series = []
  const cur = new Date(startDate)
  const end = new Date(endDate)
  while (cur <= end) {
    const key = cur.toISOString().slice(0, 10)
    series.push(map.get(key) ?? 0)
    cur.setDate(cur.getDate() + 1)
  }
  return series
}

function clamp01(x) {
  if (Number.isNaN(x) || !Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

async function main() {
  const startedAt = Date.now()
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - LOOKBACK_DAYS)
  const startISO = startDate.toISOString().slice(0, 10)
  const endISO = endDate.toISOString().slice(0, 10)

  console.log(`[repurchase] window ${startISO} → ${endISO}`)

  // 1) product 목록
  const { data: products, error: pErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  if (pErr) {
    console.error('[repurchase] failed to load products:', pErr.message)
    process.exit(1)
  }
  console.log(`[repurchase] loaded ${products?.length ?? 0} products`)

  // 2) alias 매핑 (product_id → keyword set)
  const { data: aliases, error: aErr } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
  if (aErr) {
    console.error('[repurchase] failed to load aliases:', aErr.message)
    process.exit(1)
  }
  const aliasByProduct = new Map()
  for (const a of aliases ?? []) {
    if (!aliasByProduct.has(a.product_id)) aliasByProduct.set(a.product_id, new Set())
    aliasByProduct.get(a.product_id).add(a.alias)
  }

  // 3) trends_keywords 시계열 일괄 로딩 (메모리 절약 위해 source 별)
  const keywordIndex = new Map() // keyword → [{collected_at, volume_relative}]
  for (const src of SOURCES) {
    const { data, error } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, volume_relative, collected_at')
      .eq('source', src)
      .gte('collected_at', startDate.toISOString())
      .order('collected_at', { ascending: true })
      .limit(50000)
    if (error) {
      console.error(`[repurchase] failed to load keywords for ${src}:`, error.message)
      continue
    }
    for (const row of data ?? []) {
      const k = row.keyword
      if (!keywordIndex.has(k)) keywordIndex.set(k, [])
      keywordIndex.get(k).push({
        collected_at: row.collected_at,
        volume_relative: row.volume_relative,
      })
    }
  }
  console.log(`[repurchase] indexed ${keywordIndex.size} keywords`)

  // 4) product 별 ACF 산출
  const upserts = []
  let analyzed = 0
  let cycleFound = 0

  for (const p of products ?? []) {
    const aliasSet = aliasByProduct.get(p.id) ?? new Set()
    if (aliasSet.size === 0) continue
    const merged = []
    for (const alias of aliasSet) {
      const rows = keywordIndex.get(alias)
      if (rows) merged.push(...rows)
    }
    if (merged.length < MIN_SERIES_LENGTH) continue

    const series = buildDailySeries(merged, startDate, endDate)
    if (series.length < MIN_SERIES_LENGTH) continue
    const avgVolume = series.reduce((s, v) => s + v, 0) / series.length
    if (avgVolume < MIN_AVG_VOLUME) continue

    const maxLag = Math.min(MAX_LAG, Math.floor(series.length / 2))
    const acf = autocorrelation(series, maxLag)
    if (!acf) continue

    const peaks = findPeaks(acf)
    analyzed++

    let cycleDays = null
    let acfPeak = null
    if (peaks.length > 0) {
      cycleDays = peaks[0].lag
      acfPeak = clamp01(peaks[0].value)
      cycleFound++
    }

    // 신뢰도: peak 값 자체 × series 충만도 × SNR(peak 대 2위)
    const fullness = clamp01(series.filter((v) => v > 0).length / series.length)
    const snr = peaks.length >= 2 ? clamp01((peaks[0].value - peaks[1].value) / (peaks[0].value + 1e-6)) : 0.5
    const confidence = clamp01((acfPeak ?? 0) * 0.5 + fullness * 0.3 + snr * 0.2)

    // 재구매성 지수: ACF peak × confidence × log(volume) 정규화 → 0~100
    const repurchaseIndex = clamp01((acfPeak ?? 0) * confidence * (Math.log10(avgVolume + 1) / 2)) * 100

    // LTV: 주기 짧을수록 (1년 내 반복 횟수 비례) × repurchaseIndex 정규화 → 0~100
    let ltvScore = 0
    if (cycleDays && cycleDays > 0) {
      const repeatsPerYear = Math.min(52, 365 / cycleDays)
      ltvScore = clamp01((repeatsPerYear / 52) * 0.6 + (repurchaseIndex / 100) * 0.4) * 100
    }

    upserts.push({
      product_id: p.id,
      cycle_days: cycleDays,
      acf_peak: acfPeak,
      confidence: Number(confidence.toFixed(4)),
      repurchase_index: Number(repurchaseIndex.toFixed(2)),
      ltv_score: Number(ltvScore.toFixed(2)),
      acf_peaks: peaks.map((pk) => ({ lag: pk.lag, value: Number(pk.value.toFixed(4)) })),
      series_length: series.length,
      series_start: startISO,
      series_end: endISO,
      avg_volume: Number(avgVolume.toFixed(2)),
      computed_at: new Date().toISOString(),
    })
  }

  console.log(`[repurchase] analyzed ${analyzed} products, cycle found ${cycleFound}`)

  // 5) upsert metrics (batch)
  const BATCH = 500
  for (let i = 0; i < upserts.length; i += BATCH) {
    const chunk = upserts.slice(i, i + BATCH)
    const { error } = await sb
      .from('jimscanner_trends_repurchase_metrics')
      .upsert(chunk, { onConflict: 'product_id' })
    if (error) {
      console.error('[repurchase] upsert error:', error.message)
    }
  }

  // 6) products 캐시 컬럼 동기화 (한 row 씩 — count 적으므로 OK)
  let synced = 0
  for (const m of upserts) {
    const { error } = await sb
      .from('jimscanner_trends_products')
      .update({
        repurchase_cycle_days: m.cycle_days,
        ltv_score: m.ltv_score,
      })
      .eq('id', m.product_id)
    if (error) {
      console.error('[repurchase] product cache update error:', error.message)
      continue
    }
    synced++
  }

  console.log(`[repurchase] upserted ${upserts.length} metrics, synced ${synced} product caches`)
  console.log(`[repurchase] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error('[repurchase] fatal:', e)
  process.exit(1)
})
