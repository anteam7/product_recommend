#!/usr/bin/env node
/**
 * 택배 경제성 게이트 — 배송부담률 캐시 산출.
 *
 * jimscanner_trends_products 의 (dim_weight_g, actual_weight_g, longest_cm,
 * fragility, hazard_class) + ggsan 매칭 도매가로 cached_unit_shipping_krw /
 * cached_estimated_sell_krw / cached_burden_ratio 를 일괄 갱신한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/compute-shipping-burden.mjs
 *
 * 의존:
 *   - LLM 분류로 물리속성이 채워진 row (dim_weight_g IS NOT NULL)
 *   - ggsan 매칭이 있는 row (canonical_name 으로 trigram 매칭 → 최저가)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// ── 동일 로직 (src/lib/trends/shipping-economics.ts 와 sync) ──
const WEIGHT_TIERS = [
  { maxKg: 2, krw: 3500 },
  { maxKg: 5, krw: 4500 },
  { maxKg: 10, krw: 5500 },
  { maxKg: 20, krw: 7500 },
  { maxKg: 30, krw: 10500 },
]
const OVERSIZED_KRW = 13500
const HAZARD = { none: 0, food: 800, liquid: 1200, electronics: 500, cosmetics: 400, battery: 1800 }
const FRAGILITY = { low: 0, med: 500, high: 1200 }

function marginMul(w) {
  if (w < 3000) return 4.0
  if (w < 10000) return 2.6
  if (w < 30000) return 2.0
  if (w < 100000) return 1.6
  return 1.4
}
function unitShipping({ dim, act, longest, hazard, frag }) {
  const wG = Math.max(dim ?? 0, act ?? 0)
  if (!wG) return null
  const wKg = wG / 1000
  let base = OVERSIZED_KRW
  for (const t of WEIGHT_TIERS) {
    if (wKg <= t.maxKg) { base = t.krw; break }
  }
  if ((longest ?? 0) > 100 && base < OVERSIZED_KRW) base = OVERSIZED_KRW
  return base + (HAZARD[hazard ?? 'none'] ?? 0) + (FRAGILITY[frag ?? 'low'] ?? 0)
}

async function fetchCandidates() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, actual_weight_g, dim_weight_g, longest_cm, fragility, hazard_class')
    .not('dim_weight_g', 'is', null)
    .limit(2000)
  if (error) throw error
  return data ?? []
}

async function fetchGgsanPrice(name) {
  // 단순 trigram 유사도 매칭 — 가장 가까운 ggsan 상품의 도매가.
  const { data } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw')
    .ilike('title', `%${name}%`)
    .not('price_krw', 'is', null)
    .order('price_krw', { ascending: true })
    .limit(1)
  if (data && data.length > 0) return data[0].price_krw
  return null
}

async function main() {
  const t0 = Date.now()
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] compute-shipping-burden start`)

  const rows = await fetchCandidates()
  console.log(`  candidates with physical props: ${rows.length}`)

  let updated = 0
  let skipped = 0
  const now = new Date().toISOString()

  for (const r of rows) {
    const ship = unitShipping({
      dim: r.dim_weight_g, act: r.actual_weight_g, longest: r.longest_cm,
      hazard: r.hazard_class, frag: r.fragility,
    })
    if (ship == null) { skipped++; continue }

    const wholesale = await fetchGgsanPrice(r.canonical_name)
    if (!wholesale) { skipped++; continue }

    const sell = Math.round(wholesale * marginMul(wholesale))
    const ratio = ship / sell
    await sb
      .from('jimscanner_trends_products')
      .update({
        cached_unit_shipping_krw: ship,
        cached_estimated_sell_krw: sell,
        cached_burden_ratio: Number(ratio.toFixed(4)),
        cached_economics_at: now,
      })
      .eq('id', r.id)
    updated++
  }

  console.log(
    `[${new Date().toISOString()}] done — ${updated} updated, ${skipped} skipped, ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
