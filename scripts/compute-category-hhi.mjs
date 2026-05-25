#!/usr/bin/env node
/**
 * 카테고리 브랜드 집중도(HHI) 산출 — 로컬 cron.
 *
 *   node --env-file=.env.local scripts/compute-category-hhi.mjs
 *
 *  - jimscanner_trends_products 의 brand · alias_count 를 category_top 별로 집계
 *  - brand 미지정 row 는 canonical_name 의 첫 토큰을 brand 후보로 폴백
 *  - share_i = alias_weight_i / Σ alias_weight    (alias_count 가중치)
 *  - HHI = Σ (share_i × 100)^2     0 ~ 10000
 *  - upsert into jimscanner_trends_category_concentration
 *
 *  필요 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

function firstToken(name) {
  if (!name) return null
  const cleaned = String(name).trim().replace(/[\[\]\(\)]/g, ' ')
  const tok = cleaned.split(/\s+/)[0]
  if (!tok) return null
  if (tok.length < 2) return null
  if (/^[0-9]+$/.test(tok)) return null
  return tok
}

async function fetchAllProducts() {
  const rows = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, brand, alias_count')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return rows
}

function computeForCategory(products) {
  const weightByBrand = new Map()
  let total = 0
  let withBrand = 0
  for (const p of products) {
    const brand = p.brand && String(p.brand).trim() ? String(p.brand).trim() : firstToken(p.canonical_name)
    if (!brand) continue
    const w = Math.max(1, Number(p.alias_count ?? 1))
    weightByBrand.set(brand, (weightByBrand.get(brand) ?? 0) + w)
    total += w
    if (p.brand) withBrand++
  }
  if (total === 0 || weightByBrand.size === 0) {
    return {
      hhi: 0,
      top1_brand: null,
      top1_share: 0,
      top3_share: 0,
      brand_count: 0,
      distinct_skus: products.length,
    }
  }
  const shares = [...weightByBrand.entries()]
    .map(([brand, w]) => ({ brand, share: w / total }))
    .sort((a, b) => b.share - a.share)

  const hhi = shares.reduce((acc, s) => acc + Math.pow(s.share * 100, 2), 0)
  const top1 = shares[0]
  const top3_share = shares.slice(0, 3).reduce((a, s) => a + s.share, 0)

  return {
    hhi: Math.round(hhi * 100) / 100,
    top1_brand: top1.brand,
    top1_share: Math.round(top1.share * 10000) / 10000,
    top3_share: Math.round(top3_share * 10000) / 10000,
    brand_count: weightByBrand.size,
    distinct_skus: products.length,
  }
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] computing category HHI…`)

  const products = await fetchAllProducts()
  console.log(`  fetched ${products.length} products`)

  const byCategory = new Map()
  for (const p of products) {
    const c = p.category_top || 'other'
    if (!byCategory.has(c)) byCategory.set(c, [])
    byCategory.get(c).push(p)
  }

  const computed_at = new Date().toISOString()
  const rows = []
  for (const [cat, list] of byCategory.entries()) {
    const r = computeForCategory(list)
    rows.push({ category_top: cat, ...r, computed_at })
    console.log(
      `  ${cat.padEnd(10)}  HHI=${String(r.hhi).padStart(6)}  ` +
        `top1=${r.top1_brand ?? '-'}(${(r.top1_share * 100).toFixed(1)}%)  ` +
        `top3=${(r.top3_share * 100).toFixed(1)}%  brands=${r.brand_count}  skus=${r.distinct_skus}`,
    )
  }

  const { error } = await sb
    .from('jimscanner_trends_category_concentration')
    .upsert(rows, { onConflict: 'category_top' })

  if (error) {
    console.error('upsert error:', error)
    process.exit(1)
  }
  console.log(
    `[${new Date().toISOString()}] done — ${rows.length} categories in ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
