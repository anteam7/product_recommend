#!/usr/bin/env node
// scripts/compute-seasonality.mjs
//
// jimscanner_trends_keywords 의 24개월 히스토리를 읽어
// (1) category_top 별 월별 seasonal_index 계산
// (2) 각 product 의 alias 들로 product 시계열 합성 → product 별 seasonal_index
//     데이터 부족(fit_quality < THRESHOLD) 이면 같은 category_top 의 인덱스 상속
// 결과를 jimscanner_trends_seasonality 에 upsert.
//
// 알고리즘 (가벼운 STL 대용):
//   1) 월별 평균 volume_relative 시계열 (Y[t], t=0..N-1)
//   2) 12-month centered moving average = trend[t]
//   3) detrended[t] = Y[t] - trend[t]  (또는 ratio 모드: Y[t]/trend[t])
//   4) 각 캘린더 월 m (1..12) 평균 → seasonal_raw[m]
//   5) 1.0 중심으로 정규화: seasonal_index[m] = seasonal_raw[m] / mean(seasonal_raw)
//   6) peak/trough/amp_ratio/fit_quality 산출
//
// 실행: node scripts/compute-seasonality.mjs
// 필요 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const MONTHS_BACK = 24
const FIT_QUALITY_INHERIT_THRESHOLD = 0.5 // < 0.5 면 category 인덱스 상속
const DEFAULT_LEAD_TIME_DAYS = 21         // 1688 ~ 한국 도착 평균

function monthKey(d) {
  // KST 기준 'YYYY-MM'
  const kst = new Date(d.getTime() + 9 * 3600_000)
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`
}

function buildMonthlySeries(rows, monthsBack = MONTHS_BACK) {
  // rows: [{ collected_at, volume_relative }]
  // 월별 평균 volume_relative
  const now = new Date()
  const buckets = new Map() // 'YYYY-MM' -> { sum, count }
  // 최근 monthsBack 개 월 키 (오름차순) 생성
  const keys = []
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    keys.push(monthKey(d))
  }
  for (const k of keys) buckets.set(k, { sum: 0, count: 0 })

  for (const r of rows) {
    if (r.volume_relative == null) continue
    const v = Number(r.volume_relative)
    if (!Number.isFinite(v)) continue
    const k = monthKey(new Date(r.collected_at))
    const b = buckets.get(k)
    if (!b) continue
    b.sum += v
    b.count += 1
  }
  const series = keys.map((k) => {
    const b = buckets.get(k)
    return { key: k, value: b.count > 0 ? b.sum / b.count : null, count: b.count }
  })
  return series
}

function centeredMovingAverage(values, window = 12) {
  // values: (number|null)[], returns same length with null padding
  const n = values.length
  const out = new Array(n).fill(null)
  const half = Math.floor(window / 2)
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= n) continue
      const v = values[j]
      if (v == null) continue
      sum += v
      cnt += 1
    }
    if (cnt >= Math.max(6, Math.floor(window / 2))) out[i] = sum / cnt
  }
  return out
}

function computeSeasonality(series) {
  // series[i] = { key: 'YYYY-MM', value, count }
  const values = series.map((s) => s.value)
  const trend = centeredMovingAverage(values, 12)

  // detrended (ratio 모드: Y/trend; 값/추세가 0 또는 null 이면 skip)
  const ratio = values.map((v, i) => {
    const t = trend[i]
    if (v == null || t == null || t <= 0) return null
    return v / t
  })

  // 캘린더 월(1..12) 별 평균
  const monthBuckets = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }))
  let usedMonths = 0
  for (let i = 0; i < series.length; i++) {
    const r = ratio[i]
    if (r == null) continue
    const monthIdx = Number(series[i].key.slice(5, 7)) // 1..12
    const b = monthBuckets[monthIdx - 1]
    b.sum += r
    b.count += 1
    usedMonths += 1
  }

  const raw = monthBuckets.map((b) => (b.count > 0 ? b.sum / b.count : null))
  // 비어있는 월은 1.0 로 채우고 fit_quality 페널티
  const filled = raw.map((v) => (v == null ? 1.0 : v))
  const mean = filled.reduce((a, b) => a + b, 0) / 12 || 1
  const idx = filled.map((v) => v / mean)

  const sampleCount = monthBuckets.map((b) => b.count)
  const monthsCovered = sampleCount.filter((c) => c > 0).length
  const fitQuality = Math.min(1, monthsCovered / 12) * (usedMonths / Math.max(1, MONTHS_BACK))

  let peakMonth = 1
  let troughMonth = 1
  for (let m = 1; m <= 12; m++) {
    if (idx[m - 1] > idx[peakMonth - 1]) peakMonth = m
    if (idx[m - 1] < idx[troughMonth - 1]) troughMonth = m
  }
  const ampRatio = idx[troughMonth - 1] > 0 ? idx[peakMonth - 1] / idx[troughMonth - 1] : null

  return {
    seasonalIndex: idx,
    sampleCount,
    peakMonth,
    troughMonth,
    ampRatio,
    fitQuality: Number(fitQuality.toFixed(3)),
    monthsCovered,
    usedMonths,
  }
}

async function fetchCategoryKeywordRows(categoryTop, sinceISO) {
  // category_top 일치하는 모든 키워드 시계열
  const all = []
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data, error } = await sb
      .from('jimscanner_trends_keywords')
      .select('collected_at, volume_relative')
      .eq('category_top', categoryTop)
      .gte('collected_at', sinceISO)
      .not('volume_relative', 'is', null)
      .order('collected_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

async function fetchAliases(productId) {
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias')
    .eq('product_id', productId)
  if (error) throw error
  return (data ?? []).map((r) => r.alias).filter(Boolean)
}

async function fetchProductKeywordRows(aliases, sinceISO) {
  if (aliases.length === 0) return []
  const all = []
  // chunked IN: keyword in (alias1, alias2, ...)
  const CHUNK = 50
  for (let i = 0; i < aliases.length; i += CHUNK) {
    const slice = aliases.slice(i, i + CHUNK)
    let from = 0
    const PAGE = 1000
    for (;;) {
      const { data, error } = await sb
        .from('jimscanner_trends_keywords')
        .select('collected_at, volume_relative')
        .in('keyword', slice)
        .gte('collected_at', sinceISO)
        .not('volume_relative', 'is', null)
        .order('collected_at', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw error
      if (!data || data.length === 0) break
      all.push(...data)
      if (data.length < PAGE) break
      from += PAGE
    }
  }
  return all
}

async function upsertSubject({ subjectKind, productId, categoryKey, result, inheritedFromCategory }) {
  // 12 row delete + insert (subject 단위)
  const filter = subjectKind === 'product'
    ? { subject_kind: 'product', product_id: productId }
    : { subject_kind: 'category', category_key: categoryKey }

  const del = sb.from('jimscanner_trends_seasonality').delete()
  let delQ = del.eq('subject_kind', filter.subject_kind)
  if (subjectKind === 'product') delQ = delQ.eq('product_id', productId)
  else delQ = delQ.eq('category_key', categoryKey)
  const { error: delErr } = await delQ
  if (delErr) throw delErr

  const rows = []
  for (let m = 1; m <= 12; m++) {
    rows.push({
      subject_kind: subjectKind,
      product_id: subjectKind === 'product' ? productId : null,
      category_key: subjectKind === 'category' ? categoryKey : null,
      period_month: m,
      seasonal_index: Number(result.seasonalIndex[m - 1].toFixed(4)),
      sample_count: result.sampleCount[m - 1],
      peak_month: result.peakMonth,
      trough_month: result.troughMonth,
      amp_ratio: result.ampRatio == null ? null : Number(result.ampRatio.toFixed(3)),
      fit_quality: result.fitQuality,
      lead_time_days_default: DEFAULT_LEAD_TIME_DAYS,
      inherited_from_category: !!inheritedFromCategory,
      source_payload: {
        months_covered: result.monthsCovered,
        used_months: result.usedMonths,
      },
    })
  }
  const { error: insErr } = await sb.from('jimscanner_trends_seasonality').insert(rows)
  if (insErr) throw insErr
}

async function main() {
  const sinceISO = new Date(Date.now() - MONTHS_BACK * 30 * 86400_000).toISOString()
  console.log(`[seasonality] since=${sinceISO.slice(0, 10)} (${MONTHS_BACK}개월)`)

  // ── 1) Category 인덱스
  const CATEGORIES = ['health', 'living', 'digital']
  const categoryResults = new Map() // category_top -> result

  for (const cat of CATEGORIES) {
    const rows = await fetchCategoryKeywordRows(cat, sinceISO)
    console.log(`[category:${cat}] rows=${rows.length}`)
    if (rows.length === 0) continue
    const series = buildMonthlySeries(rows)
    const result = computeSeasonality(series)
    categoryResults.set(cat, result)
    await upsertSubject({
      subjectKind: 'category',
      categoryKey: cat,
      result,
      inheritedFromCategory: false,
    })
    console.log(
      `  → peak=M${result.peakMonth} trough=M${result.troughMonth} amp=${result.ampRatio?.toFixed(2)} fit=${result.fitQuality}`,
    )
  }

  // ── 2) Product 인덱스 (alias → keyword 시계열 합성)
  const { data: products, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
  if (prodErr) throw prodErr
  console.log(`[products] total=${products?.length ?? 0}`)

  let computed = 0
  let inherited = 0
  for (const p of products ?? []) {
    const aliases = await fetchAliases(p.id)
    if (aliases.length === 0) {
      // category 인덱스 상속
      const cat = categoryResults.get(p.category_top)
      if (cat) {
        await upsertSubject({ subjectKind: 'product', productId: p.id, result: cat, inheritedFromCategory: true })
        inherited += 1
      }
      continue
    }
    const rows = await fetchProductKeywordRows(aliases, sinceISO)
    if (rows.length < 6) {
      const cat = categoryResults.get(p.category_top)
      if (cat) {
        await upsertSubject({ subjectKind: 'product', productId: p.id, result: cat, inheritedFromCategory: true })
        inherited += 1
      }
      continue
    }
    const series = buildMonthlySeries(rows)
    const result = computeSeasonality(series)
    if (result.fitQuality < FIT_QUALITY_INHERIT_THRESHOLD) {
      const cat = categoryResults.get(p.category_top)
      if (cat) {
        await upsertSubject({ subjectKind: 'product', productId: p.id, result: cat, inheritedFromCategory: true })
        inherited += 1
        continue
      }
    }
    await upsertSubject({ subjectKind: 'product', productId: p.id, result, inheritedFromCategory: false })
    computed += 1
  }

  console.log(`[seasonality] done. products: computed=${computed}, inherited=${inherited}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
