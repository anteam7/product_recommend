#!/usr/bin/env node
/**
 * 가격 탄력성 추정기 (주1회)
 *
 * 각 jimscanner_trends_products 에 대해 시계열 패널을 구성:
 *   t / median_listing_price (Smartstore SERP 중위값) / volume_relative (DataLab) / competitor_count
 * log(volume) ~ log(price) + log(competitor) 회귀로 β(가격탄력성) 추정.
 *
 * 결과는 jimscanner_trends_elasticity 에 새 row 로 적재.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/compute-price-elasticity.mjs
 *   node --env-file=.env.local scripts/compute-price-elasticity.mjs --product <id>
 *   node --env-file=.env.local scripts/compute-price-elasticity.mjs --dry-run
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const productIdx = args.indexOf('--product')
const ONLY_PRODUCT = productIdx >= 0 ? args[productIdx + 1] : null
const WINDOW_DAYS = 90 // 최대 90일 윈도우
const MIN_DAYS = 30 // 회귀 최소 row 수

/**
 * 시계열 패널 구성.
 * 현재 인프라에서 가격/볼륨/경쟁사 카운트 일별 시리즈를 어떻게 가져오는지는
 * 환경에 따라 다름 (jimscanner_trends_keywords + supplier + smartstore_serp 등).
 * 본 스크립트는 generic 형태를 가정하고, 실제 컬럼 매핑은 어댑터 함수에서 처리.
 */
async function buildPanel(productId) {
  // 1) alias 목록
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias')
    .eq('product_id', productId)
  const aliasNames = (aliases ?? []).map((a) => a.alias)
  if (aliasNames.length === 0) return []

  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

  // 2) DataLab volume_relative — keyword 시계열
  const { data: volRows } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative, collected_at')
    .in('keyword', aliasNames)
    .gte('collected_at', since)
    .not('volume_relative', 'is', null)

  // 3) Smartstore SERP 중위값 — supplier 가격(원본가) 일별 중위
  //    실 인프라에서는 별도 smartstore_serp 테이블이 있을 수 있음.
  //    여기선 jimscanner_trends_supplier price_krw 의 일별 중위를 시장가 프록시로 사용.
  const { data: priceRows } = await sb
    .from('jimscanner_trends_supplier')
    .select('price_krw, collected_at')
    .eq('product_id', productId)
    .gte('collected_at', since)
    .not('price_krw', 'is', null)

  // 일자별 집계
  const byDay = new Map() // date(YYYY-MM-DD) -> { vol:[], prices:[], comp:Set }
  const dayKey = (iso) => iso.slice(0, 10)

  for (const r of volRows ?? []) {
    const d = dayKey(r.collected_at)
    const e = byDay.get(d) ?? { vol: [], prices: [], comp: new Set() }
    if (r.volume_relative != null && r.volume_relative > 0) e.vol.push(Number(r.volume_relative))
    byDay.set(d, e)
  }
  for (const r of priceRows ?? []) {
    const d = dayKey(r.collected_at)
    const e = byDay.get(d) ?? { vol: [], prices: [], comp: new Set() }
    if (r.price_krw != null && r.price_krw > 0) {
      e.prices.push(Number(r.price_krw))
      e.comp.add(`${r.price_krw}`) // distinct price points 를 경쟁자 프록시로
    }
    byDay.set(d, e)
  }

  const panel = []
  for (const [d, e] of byDay.entries()) {
    if (e.vol.length === 0 || e.prices.length === 0) continue
    panel.push({
      day: d,
      volume: median(e.vol),
      price: median(e.prices),
      competitor: Math.max(1, e.comp.size),
    })
  }
  panel.sort((a, b) => a.day.localeCompare(b.day))
  return panel
}

function median(arr) {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(arr, p) {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[idx]
}

/**
 * 다중 선형 회귀 (Y = a + b1*X1 + b2*X2).
 * 정규방정식 (X^T X)^-1 X^T y. 2-feature 라 3x3 역행렬만 풀면 됨.
 */
function regressLogLog(panel) {
  // y = log(volume), x1 = log(price), x2 = log(competitor)
  const rows = panel
    .map((p) => ({
      y: Math.log(p.volume),
      x1: Math.log(p.price),
      x2: Math.log(p.competitor),
    }))
    .filter((r) => Number.isFinite(r.y) && Number.isFinite(r.x1) && Number.isFinite(r.x2))

  const n = rows.length
  if (n < MIN_DAYS) return { n, ok: false, reason: `n=${n} < ${MIN_DAYS}` }

  // X^T X (3x3): [n, Σx1, Σx2; Σx1, Σx1², Σx1x2; Σx2, Σx1x2, Σx2²]
  let Sx1 = 0, Sx2 = 0, Sy = 0
  let Sx1x1 = 0, Sx2x2 = 0, Sx1x2 = 0
  let Sx1y = 0, Sx2y = 0
  for (const r of rows) {
    Sx1 += r.x1
    Sx2 += r.x2
    Sy += r.y
    Sx1x1 += r.x1 * r.x1
    Sx2x2 += r.x2 * r.x2
    Sx1x2 += r.x1 * r.x2
    Sx1y += r.x1 * r.y
    Sx2y += r.x2 * r.y
  }

  const A = [
    [n, Sx1, Sx2],
    [Sx1, Sx1x1, Sx1x2],
    [Sx2, Sx1x2, Sx2x2],
  ]
  const b = [Sy, Sx1y, Sx2y]
  const coef = solve3x3(A, b)
  if (!coef) return { n, ok: false, reason: 'singular_matrix' }

  const [intercept, beta1, beta2] = coef

  // R²
  const yMean = Sy / n
  let ssRes = 0, ssTot = 0
  for (const r of rows) {
    const yhat = intercept + beta1 * r.x1 + beta2 * r.x2
    ssRes += (r.y - yhat) ** 2
    ssTot += (r.y - yMean) ** 2
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0

  return { n, ok: true, intercept, beta1, beta2, r2 }
}

function solve3x3(A, b) {
  // Gauss-Jordan elimination on augmented 3x4 matrix.
  const M = A.map((row, i) => [...row, b[i]])
  for (let i = 0; i < 3; i++) {
    // pivot
    let pivot = i
    for (let k = i + 1; k < 3; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) pivot = k
    }
    if (Math.abs(M[pivot][i]) < 1e-12) return null
    if (pivot !== i) [M[i], M[pivot]] = [M[pivot], M[i]]
    const div = M[i][i]
    for (let j = i; j < 4; j++) M[i][j] /= div
    for (let k = 0; k < 3; k++) {
      if (k === i) continue
      const f = M[k][i]
      for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j]
    }
  }
  return [M[0][3], M[1][3], M[2][3]]
}

function decide({ beta1, r2, n, p10, p50, p90 }) {
  let confidence = 'low'
  if (r2 >= 0.6 && n >= 60) confidence = 'high'
  else if (r2 >= 0.3 && n >= 30) confidence = 'medium'

  if (confidence === 'low') {
    return { confidence, label: 'low_confidence', entry: p50 ?? null }
  }

  const abs = Math.abs(beta1)
  let label = 'mixed'
  let entry = p50
  if (abs >= 1.5) {
    label = 'price_sensitive'
    // 가격민감: p10 근처로 공격적 진입
    entry = p10 ?? p50
  } else if (abs <= 0.5) {
    label = 'differentiable'
    // 차별화 가능: p90 근처 프리미엄
    entry = p90 ?? p50
  } else {
    label = 'mixed'
    entry = p50
  }
  return { confidence, label, entry }
}

async function listProducts() {
  if (ONLY_PRODUCT) return [{ id: ONLY_PRODUCT }]
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .order('last_seen_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  return data ?? []
}

async function main() {
  const t0 = Date.now()
  const products = await listProducts()
  console.log(
    `[${new Date().toISOString()}] computing elasticity for ${products.length} product(s)`,
  )

  let inserted = 0
  let skipped = 0
  let failed = 0

  for (const p of products) {
    try {
      const panel = await buildPanel(p.id)
      if (panel.length < MIN_DAYS) {
        skipped++
        continue
      }
      const reg = regressLogLog(panel)
      const prices = panel.map((x) => x.price)
      const p10 = percentile(prices, 10)
      const p50 = percentile(prices, 50)
      const p90 = percentile(prices, 90)

      let row
      if (!reg.ok) {
        row = {
          product_id: p.id,
          elasticity_coef: null,
          competitor_coef: null,
          intercept: null,
          r_squared: null,
          sample_days: reg.n,
          price_band_p10: p10,
          price_band_p50: p50,
          price_band_p90: p90,
          optimal_entry_price: p50,
          decision_label: 'low_confidence',
          confidence: 'low',
        }
      } else {
        const { confidence, label, entry } = decide({
          beta1: reg.beta1,
          r2: reg.r2,
          n: reg.n,
          p10,
          p50,
          p90,
        })
        row = {
          product_id: p.id,
          elasticity_coef: round(reg.beta1, 4),
          competitor_coef: round(reg.beta2, 4),
          intercept: round(reg.intercept, 4),
          r_squared: round(reg.r2, 4),
          sample_days: reg.n,
          price_band_p10: p10 != null ? Math.round(p10) : null,
          price_band_p50: p50 != null ? Math.round(p50) : null,
          price_band_p90: p90 != null ? Math.round(p90) : null,
          optimal_entry_price: entry != null ? Math.round(entry) : null,
          decision_label: label,
          confidence,
        }
      }

      if (DRY) {
        console.log(`  DRY ${p.id} →`, row)
      } else {
        const { error } = await sb.from('jimscanner_trends_elasticity').insert(row)
        if (error) {
          console.error(`  ERR ${p.id}: ${error.message}`)
          failed++
          continue
        }
      }
      inserted++
    } catch (e) {
      console.error(`  EXC ${p.id}: ${e instanceof Error ? e.message : String(e)}`)
      failed++
    }
  }

  const ms = Date.now() - t0
  console.log(
    `[${new Date().toISOString()}] elasticity done — ${inserted} inserted, ${skipped} skipped (insufficient data), ${failed} failed in ${ms}ms`,
  )
  process.exit(failed > 0 ? 1 : 0)
}

function round(x, d) {
  if (x == null || !Number.isFinite(x)) return null
  const f = 10 ** d
  return Math.round(x * f) / f
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
