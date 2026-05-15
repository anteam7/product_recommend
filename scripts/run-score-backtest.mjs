#!/usr/bin/env node
/**
 * 점수 백테스트 cron — 일 1회.
 *
 *   1) 30 / 14 / 7 일 전 jimscanner_trends_scores 스냅샷 수집
 *   2) baseline_at 이후 ~ now 까지 실제 outcome 측정
 *        - jimscanner_trends_aliases 신규 row (delta)
 *        - jimscanner_trends_supplier 신규 매칭 (delta)
 *        - jimscanner_trends_keywords source='naver_tvtime' push 수
 *        - market_signals_search_trend volume_relative 상승률
 *   3) hit 판정 (임계치 OR 조합)
 *   4) jimscanner_trends_score_backtest 에 upsert
 *
 * 사용법:
 *   node --env-file=.env.local scripts/run-score-backtest.mjs
 *   node --env-file=.env.local scripts/run-score-backtest.mjs --horizons=7,14
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const horizonsArg = args.find((a) => a.startsWith('--horizons='))
const HORIZONS = horizonsArg
  ? horizonsArg.split('=')[1].split(',').map((x) => Number(x.trim())).filter(Boolean)
  : [7, 14, 30]

const HIT_THRESHOLDS = {
  alias_delta: 2,
  supplier_new: 1,
  tv_push: 1,
  volume_lift_pct: 30,
}

const DAY_MS = 86_400_000

function judgeHit(o) {
  if ((o.alias_delta ?? 0) >= HIT_THRESHOLDS.alias_delta) return true
  if ((o.supplier_new ?? 0) >= HIT_THRESHOLDS.supplier_new) return true
  if ((o.tv_push ?? 0) >= HIT_THRESHOLDS.tv_push) return true
  if ((o.volume_lift_pct ?? 0) >= HIT_THRESHOLDS.volume_lift_pct) return true
  return false
}

/** baseline_at 직전 score row 가져오기 (해당 product_id 당 1행) */
async function fetchBaselineScores(baselineAt) {
  // baselineAt 직전 24h 윈도우 안의 score 만 후보 — 그 product_id 별 최신을 선택.
  const since = new Date(new Date(baselineAt).getTime() - DAY_MS).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at',
    )
    .gte('computed_at', since)
    .lte('computed_at', baselineAt)
    .order('computed_at', { ascending: false })
    .limit(5000)
  if (error) throw error
  const map = new Map()
  for (const r of data ?? []) {
    if (!map.has(r.product_id)) map.set(r.product_id, r)
  }
  return map
}

async function fetchAliasCountBetween(productIds, fromIso, toIso) {
  if (productIds.length === 0) return new Map()
  const counts = new Map()
  for (const id of productIds) counts.set(id, 0)
  // chunk in 200
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200)
    const { data, error } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, created_at')
      .in('product_id', chunk)
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
    if (error) throw error
    for (const r of data ?? []) counts.set(r.product_id, (counts.get(r.product_id) ?? 0) + 1)
  }
  return counts
}

async function fetchSupplierNewBetween(productIds, fromIso, toIso) {
  if (productIds.length === 0) return new Map()
  const counts = new Map()
  for (const id of productIds) counts.set(id, 0)
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200)
    const { data, error } = await sb
      .from('jimscanner_trends_supplier')
      .select('product_id, collected_at')
      .in('product_id', chunk)
      .gte('collected_at', fromIso)
      .lte('collected_at', toIso)
    if (error) throw error
    for (const r of data ?? []) counts.set(r.product_id, (counts.get(r.product_id) ?? 0) + 1)
  }
  return counts
}

/** TV push: product 의 alias 들 중 source=naver_tvtime keyword 와 일치하는 push 개수 */
async function fetchTvPushBetween(productIds, fromIso, toIso) {
  const counts = new Map()
  for (const id of productIds) counts.set(id, 0)
  if (productIds.length === 0) return counts

  // alias 모음 (전체 alias.text)
  const aliasIndex = new Map() // alias_text -> product_id
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200)
    const { data, error } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias')
      .in('product_id', chunk)
    if (error) throw error
    for (const r of data ?? []) {
      if (r.alias && !aliasIndex.has(r.alias)) aliasIndex.set(r.alias, r.product_id)
    }
  }

  const { data: pushes, error: pushErr } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, collected_at')
    .eq('source', 'naver_tvtime')
    .gte('collected_at', fromIso)
    .lte('collected_at', toIso)
    .limit(20_000)
  if (pushErr) throw pushErr
  for (const p of pushes ?? []) {
    const pid = aliasIndex.get(p.keyword)
    if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1)
  }
  return counts
}

async function processHorizon(horizonDays) {
  const now = Date.now()
  const baselineAt = new Date(now - horizonDays * DAY_MS).toISOString()
  console.log(`\n[horizon=${horizonDays}d] baseline_at=${baselineAt}`)

  const scores = await fetchBaselineScores(baselineAt)
  const productIds = [...scores.keys()]
  console.log(`  baseline scores: ${productIds.length} products`)
  if (productIds.length === 0) return { horizon: horizonDays, evaluated: 0, hits: 0 }

  const evalIso = new Date(now).toISOString()
  const [aliasDelta, supplierNew, tvPush] = await Promise.all([
    fetchAliasCountBetween(productIds, baselineAt, evalIso),
    fetchSupplierNewBetween(productIds, baselineAt, evalIso),
    fetchTvPushBetween(productIds, baselineAt, evalIso),
  ])

  let hits = 0
  const rows = []
  for (const [productId, sc] of scores) {
    const outcome = {
      alias_delta: aliasDelta.get(productId) ?? 0,
      supplier_new: supplierNew.get(productId) ?? 0,
      tv_push: tvPush.get(productId) ?? 0,
      volume_lift_pct: 0, // placeholder — market_signals 통합은 다음 PR
    }
    const hit = judgeHit(outcome)
    if (hit) hits++

    rows.push({
      product_id: productId,
      baseline_at: sc.computed_at,
      baseline_final: sc.final_score,
      baseline_components: {
        trend: sc.trend_score,
        commerce: sc.commerce_score,
        supplier: sc.supplier_score,
        competition: sc.competition_score,
        components: sc.score_components ?? {},
      },
      horizon_days: horizonDays,
      outcome_metrics: outcome,
      hit,
      evaluated_at: evalIso,
    })
  }

  // upsert in chunks (200 per request)
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await sb
      .from('jimscanner_trends_score_backtest')
      .upsert(chunk, { onConflict: 'product_id,baseline_at,horizon_days' })
    if (error) throw error
  }
  console.log(`  upserted ${rows.length} rows · hits=${hits}`)
  return { horizon: horizonDays, evaluated: rows.length, hits }
}

const t0 = Date.now()
const results = []
for (const h of HORIZONS) {
  try {
    results.push(await processHorizon(h))
  } catch (e) {
    console.error(`  horizon=${h} failed:`, e instanceof Error ? e.message : e)
    results.push({ horizon: h, error: String(e) })
  }
}
console.log(
  `\n[score-backtest] done in ${Date.now() - t0}ms`,
  JSON.stringify(results),
)
