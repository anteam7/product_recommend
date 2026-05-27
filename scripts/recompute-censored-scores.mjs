#!/usr/bin/env node
/**
 * 품절 보정 수요 복원 — 야간 재계산 cron
 *
 * 매일 1회 실행:
 *   node --env-file=.env.local scripts/recompute-censored-scores.mjs
 *
 * 동작:
 *   1. jimscanner_ggsan_stockout_30d 뷰에서 각 ggsan goods_no 의 최근 30일 품절 비율 로드.
 *   2. jimscanner_trends_aliases (alias_type IN ('ggsan_goods_no','sku')) 으로 product_id 매핑.
 *      매핑이 없는 경우 ggsan title ↔ canonical_name 의 직접 매칭(소문자 정규화)도 fallback 으로 시도.
 *   3. 각 product 의 가장 최근 jimscanner_trends_scores row 를 가져와
 *      score_components.censored_correction_factor 필드를 UPDATE 한다.
 *   4. Tobit / Kaplan-Meier 스타일의 단순 보정계수: factor = 1 / max(1 - censored_fraction, 0.1)
 *      (10% floor — 30일 내내 품절이었던 SKU 도 10배 이상 부풀리지 않음.)
 *
 * 부작용:
 *   기존 row 의 score_components 만 갱신. final_score 등 raw 점수는 건드리지 않는다.
 *   UI 는 corrected = raw * factor 로 계산.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락. --env-file=.env.local 로 실행하세요.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const FLOOR = 0.1 // 최소 (1 - censored_fraction) — factor 상한 10x

function normalizeName(s) {
  return (s ?? '')
    .toString()
    .toLowerCase()
    .replace(/[\s\-_/().,\[\]]+/g, '')
    .trim()
}

async function loadStockoutFractions() {
  const { data, error } = await sb
    .from('jimscanner_ggsan_stockout_30d')
    .select('goods_no, stockout_days, censored_fraction')
  if (error) throw error
  const byGoodsNo = new Map()
  for (const r of data ?? []) {
    byGoodsNo.set(r.goods_no, {
      goods_no: r.goods_no,
      stockout_days: Number(r.stockout_days ?? 0),
      censored_fraction: Number(r.censored_fraction ?? 0),
    })
  }
  return byGoodsNo
}

async function loadGgsanTitles() {
  const { data, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title')
  if (error) throw error
  const byNormalizedTitle = new Map()
  const byGoodsNo = new Map()
  for (const r of data ?? []) {
    byGoodsNo.set(r.goods_no, r.title ?? '')
    byNormalizedTitle.set(normalizeName(r.title), r.goods_no)
  }
  return { byNormalizedTitle, byGoodsNo }
}

async function loadAliasMap() {
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, alias_type')
    .in('alias_type', ['ggsan_goods_no', 'sku', 'product_title'])
  if (error) throw error
  // product_id -> set(goods_no candidates)
  const productToGoodsNos = new Map()
  for (const a of data ?? []) {
    let goodsNo = null
    if (a.alias_type === 'ggsan_goods_no') goodsNo = a.alias
    else if (a.alias_type === 'sku' && /^\d{7,}$/.test(a.alias)) goodsNo = a.alias
    if (!goodsNo) continue
    if (!productToGoodsNos.has(a.product_id)) productToGoodsNos.set(a.product_id, new Set())
    productToGoodsNos.get(a.product_id).add(goodsNo)
  }
  return productToGoodsNos
}

async function loadLatestScores() {
  // product_id 별 latest score row.
  const { data, error } = await sb
    .from('jimscanner_trends_scores')
    .select('id, product_id, score_components, computed_at, final_score')
    .order('computed_at', { ascending: false })
    .limit(5000)
  if (error) throw error
  const seen = new Set()
  const latest = []
  for (const r of data ?? []) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }
  return latest
}

async function loadProducts(productIds) {
  if (productIds.length === 0) return new Map()
  const chunkSize = 500
  const out = new Map()
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize)
    const { data, error } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', chunk)
    if (error) throw error
    for (const p of data ?? []) out.set(p.id, p.canonical_name)
  }
  return out
}

function computeFactor(fraction) {
  const survivors = Math.max(1 - fraction, FLOOR)
  return 1 / survivors
}

async function main() {
  const startedAt = Date.now()
  console.log('[censored] loading inputs…')
  const [stockoutByGoodsNo, ggsanTitles, aliasMap, latestScores] = await Promise.all([
    loadStockoutFractions(),
    loadGgsanTitles(),
    loadAliasMap(),
    loadLatestScores(),
  ])
  console.log(
    `[censored] stockout_30d=${stockoutByGoodsNo.size} aliases=${aliasMap.size} scores=${latestScores.length}`,
  )

  const products = await loadProducts(latestScores.map((s) => s.product_id))

  let touched = 0
  let withStockout = 0
  let unchanged = 0
  let errors = 0

  for (const score of latestScores) {
    const pid = score.product_id
    const candidates = new Set(aliasMap.get(pid) ?? [])
    // fallback: name match
    if (candidates.size === 0) {
      const cname = normalizeName(products.get(pid))
      const goodsNo = cname ? ggsanTitles.byNormalizedTitle.get(cname) : null
      if (goodsNo) candidates.add(goodsNo)
    }

    let bestFraction = 0
    let bestGoodsNo = null
    let bestStockoutDays = 0
    for (const gno of candidates) {
      const s = stockoutByGoodsNo.get(gno)
      if (!s) continue
      if (s.censored_fraction > bestFraction) {
        bestFraction = s.censored_fraction
        bestGoodsNo = gno
        bestStockoutDays = s.stockout_days
      }
    }

    const factor = computeFactor(bestFraction)
    if (bestFraction > 0) withStockout++

    const existing = (score.score_components ?? {})
    const prevPayload = existing.censored_correction_factor
    const newPayload = {
      factor: Number(factor.toFixed(4)),
      censored_fraction: Number(bestFraction.toFixed(4)),
      stockout_days: Number(bestStockoutDays.toFixed(2)),
      goods_no: bestGoodsNo,
      method: 'kaplan_meier_1minus_f',
      floor: FLOOR,
      updated_at: new Date().toISOString(),
    }

    const isSame =
      prevPayload &&
      Number(prevPayload.factor ?? 0) === newPayload.factor &&
      Number(prevPayload.censored_fraction ?? 0) === newPayload.censored_fraction &&
      (prevPayload.goods_no ?? null) === newPayload.goods_no

    if (isSame) {
      unchanged++
      continue
    }

    const merged = { ...existing, censored_correction_factor: newPayload }
    const { error } = await sb
      .from('jimscanner_trends_scores')
      .update({ score_components: merged })
      .eq('id', score.id)
    if (error) {
      errors++
      console.warn(`[censored] update failed product=${pid}:`, error.message)
    } else {
      touched++
    }
  }

  const ms = Date.now() - startedAt
  console.log(
    `[censored] done in ${ms}ms — updated=${touched} with_stockout=${withStockout} unchanged=${unchanged} errors=${errors}`,
  )

  // 감사 로그 (jimscanner_trends_runs 가 있으면 best-effort 로 기록)
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'censored_demand_correction',
      status: errors > 0 ? 'partial' : 'ok',
      fetched_count: latestScores.length,
      inserted_count: touched,
      duration_ms: ms,
      triggered_by: 'cron',
      finished_at: new Date().toISOString(),
    })
  } catch {
    // 무시 — 감사 로그 실패는 cron 실패가 아님
  }

  process.exit(errors > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[censored] fatal:', err)
  process.exit(1)
})
