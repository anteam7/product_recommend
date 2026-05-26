#!/usr/bin/env node
/**
 * Reorder Cadence 자동 검출 — Consumable LTV·구독 후보 보드.
 *
 * Naver search_trend·shopping_insight 일별 시계열에 자기상관(ACF) 적용해
 * keyword/product 별 자연 재구매 주기를 추정.
 *
 * 알고리즘:
 *   1) jimscanner_trends_products 의 LLM 분류 완료 product 를 fetch
 *   2) aliases 로 매핑된 keyword 들을 jimscanner_trends_keywords 에서 일별 합산
 *   3) 일 단위 시계열 N >= 21 인 경우만 ACF 계산 (lag 7..min(N-2, 90))
 *   4) peak (local max, acf > 0.3) 검출 → cycle_days = peak lag
 *   5) Bartlett 근사 p-value 계산 (acf * sqrt(N) ~ N(0,1) 가정)
 *   6) segment 분류: consumable (≤45d) / repeatable (46~120d) / durable (>120d)
 *   7) supplier 가격 있으면 LTV proxy = price × (365 / cycle_days)
 *   8) upsert into jimscanner_trends_reorder_cycle (unique product_id+source)
 *
 * 호출:
 *   node --env-file=.env.local scripts/scan-reorder-cadence.mjs
 *
 * scripts/run-crons.mjs 가 classify-trends-llm 직후 호출.
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

const SOURCE_KEY = 'naver_search_trend'   // 1차 소스 (shopping_insight 는 v2)
const MIN_SERIES_LENGTH = 21              // 최소 N (의미 있는 ACF)
const MIN_PEAK_ACF = 0.3
const MAX_LAG_DAYS = 90                   // 일배 cron, 90일 이상 cycle 은 별도 분석
const MIN_LAG_DAYS = 7

function segmentFromCycle(days) {
  if (days <= 45) return 'consumable'
  if (days <= 120) return 'repeatable'
  return 'durable'
}

// Pearson autocorrelation at lag k for series x (length N).
function autocorr(x, k) {
  const n = x.length
  if (k >= n - 1) return 0
  const mean = x.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) den += (x[i] - mean) ** 2
  if (den === 0) return 0
  for (let i = 0; i < n - k; i++) {
    num += (x[i] - mean) * (x[i + k] - mean)
  }
  return num / den
}

// Standard normal CDF (Abramowitz & Stegun approximation).
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp(-(z * z) / 2)
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z > 0 ? 1 - p : p
}

// Two-sided p-value under Bartlett large-N gaussian approximation.
function pValue(acf, n) {
  const z = Math.abs(acf) * Math.sqrt(n)
  return 2 * (1 - normalCdf(z))
}

// Find first significant local max in ACF in lag window.
function findPeak(series) {
  const n = series.length
  const lagMax = Math.min(MAX_LAG_DAYS, n - 2)
  const acfs = []
  for (let k = MIN_LAG_DAYS; k <= lagMax; k++) {
    acfs.push({ lag: k, acf: autocorr(series, k) })
  }
  if (acfs.length === 0) return null

  // Pick global max (additionally require it is a local max — strictly greater than neighbors)
  let best = null
  for (let i = 0; i < acfs.length; i++) {
    const a = acfs[i]
    if (a.acf < MIN_PEAK_ACF) continue
    const prev = i > 0 ? acfs[i - 1].acf : -Infinity
    const next = i < acfs.length - 1 ? acfs[i + 1].acf : -Infinity
    if (a.acf >= prev && a.acf >= next) {
      if (!best || a.acf > best.acf) best = a
    }
  }
  // top-5 ACFs for debugging chart
  const top = [...acfs].sort((a, b) => b.acf - a.acf).slice(0, 5)
  return { peak: best, top, acfs }
}

async function fetchProductsWithAliases() {
  // product + alias_count > 0 + classified or not (we still try)
  const { data: products, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, alias_count, category_top')
    .gt('alias_count', 0)
    .limit(5000)
  if (error) throw new Error(`products fetch: ${error.message}`)
  return products ?? []
}

async function fetchAliasMap(productIds) {
  const map = new Map()
  if (productIds.length === 0) return map
  // chunked IN
  for (let i = 0; i < productIds.length; i += 200) {
    const slice = productIds.slice(i, i + 200)
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias, source')
      .in('product_id', slice)
    for (const r of data ?? []) {
      if (!map.has(r.product_id)) map.set(r.product_id, new Set())
      map.get(r.product_id).add(r.alias)
    }
  }
  return map
}

async function fetchKeywordSeries(keywords, sinceIso) {
  // Build keyword → date → ratio map. We aggregate (max) per day if multiple
  // collections happened in the same day.
  const out = new Map()
  if (keywords.length === 0) return out
  // chunked
  for (let i = 0; i < keywords.length; i += 100) {
    const slice = keywords.slice(i, i + 100)
    const { data } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, volume_relative, collected_at')
      .eq('source', SOURCE_KEY)
      .in('keyword', slice)
      .gte('collected_at', sinceIso)
      .limit(50000)
    for (const r of data ?? []) {
      if (r.volume_relative == null) continue
      const day = r.collected_at.slice(0, 10)
      let perKw = out.get(r.keyword)
      if (!perKw) {
        perKw = new Map()
        out.set(r.keyword, perKw)
      }
      const prev = perKw.get(day) ?? 0
      const v = Number(r.volume_relative)
      if (v > prev) perKw.set(day, v)
    }
  }
  return out
}

async function fetchSupplierPriceMap(productIds) {
  const map = new Map()
  if (productIds.length === 0) return map
  for (let i = 0; i < productIds.length; i += 200) {
    const slice = productIds.slice(i, i + 200)
    const { data } = await sb
      .from('jimscanner_trends_supplier')
      .select('product_id, price_krw, collected_at')
      .in('product_id', slice)
      .not('price_krw', 'is', null)
      .order('collected_at', { ascending: false })
      .limit(5000)
    for (const r of data ?? []) {
      if (!map.has(r.product_id)) map.set(r.product_id, Number(r.price_krw))
    }
  }
  return map
}

// Reconstruct daily series across union of keyword days.
// product series = sum of per-keyword ratios at each day.
function buildDailySeries(productAliases, kwSeries) {
  const dayTotals = new Map()
  for (const alias of productAliases) {
    const perKw = kwSeries.get(alias)
    if (!perKw) continue
    for (const [day, v] of perKw) {
      dayTotals.set(day, (dayTotals.get(day) ?? 0) + v)
    }
  }
  if (dayTotals.size === 0) return null
  const days = [...dayTotals.keys()].sort()
  // Fill gaps with zero between min and max day for proper ACF (lag in days).
  const start = new Date(days[0] + 'T00:00:00Z')
  const end = new Date(days[days.length - 1] + 'T00:00:00Z')
  const series = []
  const dayList = []
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10)
    dayList.push(iso)
    series.push(dayTotals.get(iso) ?? 0)
  }
  return { series, dayList }
}

async function upsertCycle(row) {
  const { error } = await sb
    .from('jimscanner_trends_reorder_cycle')
    .upsert(row, { onConflict: 'product_id,source' })
  if (error) throw new Error(`upsert: ${error.message}`)
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'scan_reorder_cadence',
      triggered_by: 'local_cli',
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] scan-reorder-cadence start`)

  const products = await fetchProductsWithAliases()
  console.log(`  products with aliases: ${products.length}`)

  const productIds = products.map((p) => p.id)
  const aliasMap = await fetchAliasMap(productIds)

  // collect all unique aliases to query keyword series
  const allAliases = new Set()
  for (const set of aliasMap.values()) for (const a of set) allAliases.add(a)
  console.log(`  unique aliases: ${allAliases.size}`)

  // 365일치 series 만 가져옴 (그 이상은 RAM 부담)
  const sinceIso = new Date(Date.now() - 365 * 86400_000).toISOString()
  const kwSeries = await fetchKeywordSeries([...allAliases], sinceIso)
  console.log(`  keywords with series rows: ${kwSeries.size}`)

  const priceMap = await fetchSupplierPriceMap(productIds)

  let scanned = 0
  let detected = 0
  let skippedShort = 0
  let lastErr = null

  for (const p of products) {
    const aliases = aliasMap.get(p.id)
    if (!aliases) continue
    const built = buildDailySeries(aliases, kwSeries)
    if (!built) continue
    if (built.series.length < MIN_SERIES_LENGTH) {
      skippedShort++
      continue
    }
    scanned++

    const result = findPeak(built.series)
    if (!result?.peak) continue

    const { peak, top } = result
    const n = built.series.length
    const p_value = pValue(peak.acf, n)
    if (p_value > 0.05) continue

    // confidence: blend of peak strength, sample size, and acf gap vs noise floor
    const meanAbsAcf =
      result.acfs.reduce((s, a) => s + Math.abs(a.acf), 0) / result.acfs.length
    const lift = Math.max(0, peak.acf - meanAbsAcf)
    const confidence = Math.max(
      0,
      Math.min(1, peak.acf * 0.5 + lift * 0.3 + Math.min(1, n / 90) * 0.2),
    )

    const segment = segmentFromCycle(peak.lag)
    const price = priceMap.get(p.id) ?? null
    const ltv =
      price && peak.lag > 0
        ? Math.round(price * (365 / peak.lag))
        : null

    try {
      await upsertCycle({
        product_id: p.id,
        source: SOURCE_KEY,
        cycle_days: peak.lag,
        peak_strength: Number(peak.acf.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        p_value: Number(p_value.toFixed(6)),
        segment,
        series_length: n,
        series_start: built.dayList[0],
        series_end: built.dayList[built.dayList.length - 1],
        acf_top_lags: top.map((t) => ({
          lag: t.lag,
          acf: Number(t.acf.toFixed(4)),
        })),
        ltv_proxy_krw: ltv,
        ltv_basis_price: price,
        computed_at: new Date().toISOString(),
      })
      detected++
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      console.error(`  upsert failed (${p.canonical_name}): ${lastErr}`)
    }
  }

  await logRun({
    status: lastErr ? 'partial' : 'ok',
    fetched_count: products.length,
    inserted_count: detected,
    duration_ms: Date.now() - t0,
    error_message: lastErr,
  })

  console.log(
    `[${new Date().toISOString()}] done — scanned=${scanned} detected=${detected} skipped_short=${skippedShort} (${Date.now() - t0}ms)`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({
    status: 'error',
    fetched_count: 0,
    inserted_count: 0,
    duration_ms: 0,
    error_message: msg,
  })
  process.exit(1)
})
