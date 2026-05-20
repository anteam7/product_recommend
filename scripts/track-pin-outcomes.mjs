#!/usr/bin/env node
/**
 * track-pin-outcomes — 핀 채택 후 +30/+60/+90일 사후 성과 추적
 *
 * 매일 KST 07:30 실행 가정 (Windows Task Scheduler 또는 run-crons 통합).
 *
 * 단계:
 *  1. jimscanner_trends_pins 전체 스캔
 *  2. 각 핀의 pinned_at 기준 +30/+60/+90일 도래분만 추출
 *  3. 키워드 → 상품 매칭 (alias 통해 product_id 회수)
 *  4. 해당 상품 최신 score row 의 4지표를 realized_* 로 스냅샷
 *     (V0: realized = "지금 시점 점수". V1: SERP/supplier 직접 재조회.)
 *  5. jimscanner_pin_outcomes upsert (UNIQUE(pin_source, pin_keyword, checkpoint_days))
 *  6. 카테고리별 잔차 회귀 → jimscanner_calibration_weights 갱신
 *  7. recompute_scores_calibrated() 호출
 *
 * 사용법:
 *   node --env-file=.env.local scripts/track-pin-outcomes.mjs
 *   node --env-file=.env.local scripts/track-pin-outcomes.mjs --dry-run
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락 — --env-file=.env.local 로 실행')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })
const DRY = process.argv.includes('--dry-run')
const CHECKPOINTS = [30, 60, 90]
const DAY_MS = 86_400_000
const TOLERANCE_DAYS = 1 // 정확히 30/60/90 ± 1일 안에 들면 처리

const now = Date.now()

async function main() {
  const { data: pins, error: pinErr } = await sb
    .from('jimscanner_trends_pins')
    .select('source, keyword, pinned_at, notes')
  if (pinErr) {
    console.error('pins fetch error:', pinErr)
    process.exit(1)
  }
  console.log(`[track-pin-outcomes] pins: ${pins?.length ?? 0}`)

  let processed = 0
  let inserted = 0

  for (const pin of pins ?? []) {
    const pinnedMs = new Date(pin.pinned_at).getTime()
    if (!Number.isFinite(pinnedMs)) continue
    const ageDays = (now - pinnedMs) / DAY_MS

    for (const cp of CHECKPOINTS) {
      if (Math.abs(ageDays - cp) > TOLERANCE_DAYS) continue
      processed++

      // 키워드 → 상품 매핑
      const { data: aliases } = await sb
        .from('jimscanner_trends_aliases')
        .select('product_id')
        .ilike('alias', pin.keyword)
        .limit(1)

      const productId = aliases?.[0]?.product_id ?? null

      // 최신 score row 회수
      let scoreRow = null
      let category = null
      if (productId) {
        const { data: scores } = await sb
          .from('jimscanner_trends_scores')
          .select('trend_score, commerce_score, supplier_score, competition_score, final_score, score_components')
          .eq('product_id', productId)
          .order('computed_at', { ascending: false })
          .limit(1)
        scoreRow = scores?.[0] ?? null

        const { data: prod } = await sb
          .from('jimscanner_trends_products')
          .select('category_top')
          .eq('id', productId)
          .single()
        category = prod?.category_top ?? null
      }

      // 핀 시점 예측은 score_components.snapshot_at_pin 이 있으면 사용,
      // 없으면 현재 score 의 4지표를 보조로 사용 (V0).
      const predicted_final_score = scoreRow?.final_score ?? null
      const predicted_trend_score = scoreRow?.trend_score ?? null
      const predicted_commerce_score = scoreRow?.commerce_score ?? null
      const predicted_supplier_score = scoreRow?.supplier_score ?? null
      const predicted_competition_score = scoreRow?.competition_score ?? null

      // realized 는 V0 에서는 현재 score 와 동일 — 향후 SERP/도매 재조회로 분기.
      const realized_score = scoreRow?.final_score ?? null

      const row = {
        pin_source: pin.source,
        pin_keyword: pin.keyword,
        pin_pinned_at: pin.pinned_at,
        product_id: productId,
        checkpoint_days: cp,
        observed_at: new Date().toISOString(),
        status: scoreRow ? 'observed' : 'missing_data',
        predicted_final_score,
        predicted_trend_score,
        predicted_commerce_score,
        predicted_supplier_score,
        predicted_competition_score,
        predicted_category: category,
        realized_serp_rank: null,
        realized_search_vol: null,
        realized_supplier_avail: scoreRow?.supplier_score != null ? scoreRow.supplier_score / 100 : null,
        realized_margin_est: null,
        realized_score,
        notes: pin.notes ?? null,
      }

      if (DRY) {
        console.log('  [DRY] upsert outcome:', { keyword: pin.keyword, cp, productId, realized_score })
        continue
      }

      const { error: upErr } = await sb
        .from('jimscanner_pin_outcomes')
        .upsert(row, { onConflict: 'pin_source,pin_keyword,checkpoint_days' })
      if (upErr) {
        console.error('  upsert error:', upErr.message, pin.keyword, cp)
        continue
      }
      inserted++
    }
  }

  console.log(`[track-pin-outcomes] processed=${processed} inserted=${inserted}`)

  if (DRY) {
    console.log('[DRY] skipping calibration regression')
    return
  }

  await recalibrateWeights()

  // recompute_scores_calibrated 호출
  const { error: rpcErr } = await sb.rpc('recompute_scores_calibrated')
  if (rpcErr) {
    console.error('recompute_scores_calibrated RPC error:', rpcErr.message)
  } else {
    console.log('[track-pin-outcomes] recompute_scores_calibrated OK')
  }
}

/**
 * 카테고리별 OLS 회귀 (간이): realized_score = wt*trend + wc*commerce + ws*supplier + wcomp*competition + bias.
 * 표본 5건 미만이면 _default 유지.
 * V0: closed-form 4D 회귀를 풀기 귀찮으니 가중평균 정규화로 근사.
 * V1: 정식 normal equations.
 */
async function recalibrateWeights() {
  const { data: rows, error } = await sb
    .from('jimscanner_calibration_residuals')
    .select('predicted_category, predicted_trend_score, predicted_commerce_score, predicted_supplier_score, predicted_competition_score, realized_score, residual')
  if (error) {
    console.error('residuals fetch error:', error.message)
    return
  }
  const byCat = new Map()
  for (const r of rows ?? []) {
    const cat = r.predicted_category ?? '_default'
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat).push(r)
  }

  for (const [cat, list] of byCat) {
    if (!cat || cat === '_default') continue
    if (list.length < 5) continue

    // V0 근사: 각 지표의 |corr(지표, realized)| 비율로 가중치 분배.
    const corr = (k) => {
      const xs = list.map((r) => r[k]).filter((v) => v != null)
      const ys = list.map((r) => r.realized_score).filter((v) => v != null)
      if (xs.length < 3) return 0
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length
      const my = ys.reduce((a, b) => a + b, 0) / ys.length
      let num = 0,
        dx = 0,
        dy = 0
      for (let i = 0; i < xs.length; i++) {
        const ex = xs[i] - mx
        const ey = ys[i] - my
        num += ex * ey
        dx += ex * ex
        dy += ey * ey
      }
      const denom = Math.sqrt(dx * dy)
      return denom > 0 ? num / denom : 0
    }
    const ct = Math.abs(corr('predicted_trend_score'))
    const cc = Math.abs(corr('predicted_commerce_score'))
    const cs = Math.abs(corr('predicted_supplier_score'))
    const ccomp = Math.abs(corr('predicted_competition_score'))
    const sum = ct + cc + cs + ccomp || 1

    const w_trend = +(ct / sum).toFixed(4)
    const w_commerce = +(cc / sum).toFixed(4)
    const w_supplier = +(cs / sum).toFixed(4)
    const w_competition = +(ccomp / sum).toFixed(4)

    const meanResidual = list.reduce((a, r) => a + (r.residual ?? 0), 0) / list.length
    const rmse = Math.sqrt(list.reduce((a, r) => a + (r.residual ?? 0) ** 2, 0) / list.length)

    const { error: upErr } = await sb
      .from('jimscanner_calibration_weights')
      .upsert({
        category_top: cat,
        w_trend,
        w_commerce,
        w_supplier,
        w_competition,
        bias: +meanResidual.toFixed(4),
        sample_n: list.length,
        residual_rmse: +rmse.toFixed(4),
        computed_at: new Date().toISOString(),
      })
    if (upErr) {
      console.error('weights upsert error:', upErr.message, cat)
    } else {
      console.log(`  weights[${cat}] n=${list.length} rmse=${rmse.toFixed(2)} w=[t:${w_trend} c:${w_commerce} s:${w_supplier} comp:${w_competition}]`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
