#!/usr/bin/env node
/**
 * 야간 cron — jimscanner_trends_analog_outcomes 테이블 재산출.
 *
 * 각 canonical 상품의 누적 final_score 시계열을 훑어 결말 라벨을 upsert.
 *   - peak_final / days_to_peak / post_peak_drawdown_pct / outcome_label
 *
 * 사용법:
 *   node --env-file=.env.local scripts/recompute-analog-outcomes.mjs
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

function classify(peak, drawdown, historyDays) {
  if (historyDays < 2) return 'unknown'
  if (peak < 40 || drawdown >= 60) return 'dead'
  if (peak >= 70 && drawdown < 30) return 'winner'
  if (peak >= 50 && drawdown >= 30) return 'decay'
  if (peak >= 40 && Math.abs(drawdown) < 25) return 'sideways'
  return 'sideways'
}

const t0 = Date.now()

const { data: products, error: prodErr } = await sb
  .from('jimscanner_trends_products')
  .select('id')
if (prodErr) {
  console.error(prodErr)
  process.exit(1)
}

let upserts = 0
let skipped = 0

for (const p of products ?? []) {
  const { data: scores, error: sErr } = await sb
    .from('jimscanner_trends_scores')
    .select('final_score, computed_at')
    .eq('product_id', p.id)
    .order('computed_at', { ascending: true })

  if (sErr) {
    console.error(`  ${p.id}: ${sErr.message}`)
    continue
  }
  if (!scores || scores.length === 0) {
    skipped++
    continue
  }

  let peakIdx = 0
  let peak = -1
  for (let i = 0; i < scores.length; i++) {
    if (scores[i].final_score > peak) {
      peak = scores[i].final_score
      peakIdx = i
    }
  }

  const first = new Date(scores[0].computed_at).getTime()
  const peakT = new Date(scores[peakIdx].computed_at).getTime()
  const lastT = new Date(scores[scores.length - 1].computed_at).getTime()
  const daysToPeak = Math.max(0, Math.round((peakT - first) / 86_400_000))
  const historyDays = Math.max(0, Math.round((lastT - first) / 86_400_000))

  // 피크 이후 점수 — 평균 final 로 drawdown 측정 (양수 = 하락)
  let drawdownPct = 0
  if (peakIdx < scores.length - 1) {
    const after = scores.slice(peakIdx + 1)
    const avgAfter =
      after.reduce((sum, r) => sum + Number(r.final_score), 0) / after.length
    if (peak > 0) drawdownPct = Math.max(0, ((peak - avgAfter) / peak) * 100)
  }

  const label = classify(peak, drawdownPct, historyDays)

  const { error: upErr } = await sb
    .from('jimscanner_trends_analog_outcomes')
    .upsert(
      {
        product_id: p.id,
        peak_final: Math.round(peak * 100) / 100,
        days_to_peak: daysToPeak,
        post_peak_drawdown_pct: Math.round(drawdownPct * 100) / 100,
        outcome_label: label,
        history_days: historyDays,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'product_id' },
    )

  if (upErr) {
    console.error(`  ${p.id}: ${upErr.message}`)
    continue
  }
  upserts++
}

const ms = Date.now() - t0
console.log(
  `[analog-outcomes] ${upserts} upserts, ${skipped} skipped (no scores) in ${ms}ms`,
)
process.exit(0)
