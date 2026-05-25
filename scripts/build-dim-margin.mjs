/**
 * DIM Margin Builder
 *
 * 핀 큐의 ggsan SKU 별로:
 *  1. raw_payload.weight_g / box_l_cm / box_w_cm / box_h_cm 추출
 *  2. dim_weight_g = L × W × H / 6000 × 1000
 *  3. billable_weight_g = max(actual, dim)
 *  4. courier_fee = lookup(kr_courier_rate_tiers, carrier='cj', billable_weight)
 *  5. landed_cost = 도매가 + 택배비 + serp_median × (market_fee_pct + payment_fee_pct) / 100
 *  6. serp_median (V0): ggsan price × 1.7  (실제 SERP 데이터 들어오기 전 임시 — TODO V1)
 *  7. margin_pct, gate_status 계산 후 jimscanner_ggsan_dim_margin 에 upsert
 *
 * 게이트:
 *   billable_weight_g >= 3000  &&  margin_pct < 25  →  'hold'
 *   weight/dim 데이터 부재                            →  'no_data'
 *   그 외                                              →  'pass'
 *
 * 사용:
 *   node scripts/build-dim-margin.mjs           # 전체 ggsan 상품
 *   node scripts/build-dim-margin.mjs --limit 50
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const argLimit = (() => {
  const i = process.argv.indexOf('--limit')
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null
})()

const CARRIER = 'cj' // 기준 택배사
const MARKET_FEE_PCT = 12 // 마켓 수수료 (스마트스토어 ~5.5, 쿠팡 ~11, 평균치)
const PAYMENT_FEE_PCT = 3.3 // 결제 수수료
const SERP_MULTIPLIER = 1.7 // V0 — 실제 SERP 데이터 수집 전 임시 배수

function pickNum(payload, ...keys) {
  for (const k of keys) {
    const v = payload?.[k]
    if (v == null) continue
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''))
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function extractDims(raw) {
  if (!raw || typeof raw !== 'object') return { weight: null, l: null, w: null, h: null }
  const weight = pickNum(raw, 'weight_g', 'weightG', 'weight')
  const l = pickNum(raw, 'box_l_cm', 'boxL', 'length_cm', 'length')
  const w = pickNum(raw, 'box_w_cm', 'boxW', 'width_cm', 'width')
  const h = pickNum(raw, 'box_h_cm', 'boxH', 'height_cm', 'height')
  return { weight, l, w, h }
}

function bucketOf(g) {
  if (g == null) return 'unknown'
  if (g < 2000) return 'lt2'
  if (g < 5000) return '2_5'
  if (g < 10000) return '5_10'
  if (g < 20000) return '10_20'
  return 'gt20'
}

async function loadRateTiers() {
  const { data, error } = await sb
    .from('kr_courier_rate_tiers')
    .select('carrier, min_g, max_g, fee_krw')
    .eq('carrier', CARRIER)
    .order('min_g', { ascending: true })
  if (error) throw new Error(`rate_tiers load: ${error.message}`)
  return data ?? []
}

function feeFor(tiers, weightG) {
  if (weightG == null) return null
  for (const t of tiers) {
    if (weightG >= t.min_g && weightG <= t.max_g) return t.fee_krw
  }
  // 최대 구간 초과 시 마지막 구간 + 50%
  const last = tiers[tiers.length - 1]
  return last ? Math.round(last.fee_krw * 1.5) : null
}

async function main() {
  console.log('[1] 요금표 로드 …')
  const tiers = await loadRateTiers()
  if (tiers.length === 0) {
    console.error('   ❌ kr_courier_rate_tiers 비어있음. supabase/kr_courier_rate_tiers.sql 적용 필요.')
    process.exit(1)
  }
  console.log(`   ✓ ${CARRIER} 구간 ${tiers.length}개`)

  console.log('[2] ggsan 상품 로드 …')
  let q = sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, raw_payload')
    .eq('status', 'active')
    .not('price_krw', 'is', null)
  if (argLimit) q = q.limit(argLimit)
  const { data: products, error: pErr } = await q
  if (pErr) throw new Error(`products load: ${pErr.message}`)
  console.log(`   ✓ ${products.length}건`)

  console.log('[3] 계산 + upsert …')
  let pass = 0, hold = 0, noData = 0, errCount = 0
  const rows = []
  for (const p of products) {
    const { weight, l, w, h } = extractDims(p.raw_payload)
    const dim = l && w && h ? Math.round((l * w * h) / 6000 * 1000) : null
    const billable = weight != null && dim != null ? Math.max(weight, dim) : (weight ?? dim)
    const bucket = bucketOf(billable)
    const fee = feeFor(tiers, billable)
    const serpMedian = p.price_krw != null ? Math.round(p.price_krw * SERP_MULTIPLIER) : null

    let landed = null
    let marginKrw = null
    let marginPct = null
    if (p.price_krw != null && fee != null && serpMedian != null) {
      const platformFee = Math.round(serpMedian * (MARKET_FEE_PCT + PAYMENT_FEE_PCT) / 100)
      landed = p.price_krw + fee + platformFee
      marginKrw = serpMedian - landed
      marginPct = +(marginKrw / serpMedian * 100).toFixed(2)
    }

    let gate = 'no_data'
    let reason = '무게/박스 치수 데이터 없음'
    if (billable != null && marginPct != null) {
      if (billable >= 3000 && marginPct < 25) {
        gate = 'hold'
        reason = `부피무게 ${(billable / 1000).toFixed(1)}kg + 마진 ${marginPct}% < 25%`
      } else {
        gate = 'pass'
        reason = `${(billable / 1000).toFixed(1)}kg / 마진 ${marginPct}%`
      }
    }

    if (gate === 'pass') pass++
    else if (gate === 'hold') hold++
    else noData++

    rows.push({
      goods_no: p.goods_no,
      actual_weight_g: weight,
      box_l_cm: l,
      box_w_cm: w,
      box_h_cm: h,
      dim_weight_g: dim,
      billable_weight_g: billable,
      weight_bucket: bucket,
      courier_fee_krw: fee,
      market_fee_pct: MARKET_FEE_PCT,
      payment_fee_pct: PAYMENT_FEE_PCT,
      unit_landed_cost_krw: landed,
      serp_median_krw: serpMedian,
      margin_krw: marginKrw,
      margin_pct: marginPct,
      gate_status: gate,
      gate_reason: reason,
      computed_at: new Date().toISOString(),
    })
  }

  // chunk upsert
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await sb.from('jimscanner_ggsan_dim_margin').upsert(slice, { onConflict: 'goods_no' })
    if (error) {
      errCount += slice.length
      console.log(`   ❌ chunk ${i}: ${error.message}`)
    }
  }

  console.log('\n=== 결과 ===')
  console.log(`  pass     : ${pass}`)
  console.log(`  hold     : ${hold}  ← 자동 보류 게이트 (≥3kg & <25%)`)
  console.log(`  no_data  : ${noData}`)
  console.log(`  errors   : ${errCount}`)
  console.log('완료.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
