#!/usr/bin/env node
/**
 * Source × Category Lead-Time 학습 — 일 1회 cron.
 *
 * 실제 학습은 RPC jimscanner_source_leadtime(window_days) 가 수행하므로
 * 본 스크립트는 단순히 RPC 를 호출해서 결과를 로깅/감사한다.
 *  - 현재 모델로 학습 가능한 (source, category) 셀 수
 *  - 신뢰도 (predictive_strength) 분포
 *  - 표본 부족(n<2) 으로 누락된 정도
 *
 * 호출:
 *   node --env-file=.env.local scripts/learn-source-leadtime.mjs
 *
 * scripts/run-crons.mjs 의 일 1회 단계에 추가해서 매일 돌리면 된다.
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

const WINDOW_DAYS = Number(process.env.LEADTIME_WINDOW_DAYS ?? 30)

const t0 = Date.now()
const { data, error } = await sb.rpc('jimscanner_source_leadtime', {
  window_days: WINDOW_DAYS,
})

if (error) {
  console.error('[learn-source-leadtime] RPC error:', error)
  process.exit(1)
}

const rows = data ?? []
const sources = new Set(rows.map((r) => r.source))
const categories = new Set(rows.map((r) => r.category_top))
const strongCells = rows.filter((r) => Number(r.predictive_strength) >= 0.4)
const leadingCells = rows.filter((r) => Number(r.lead_days) > 0)

console.log(`[learn-source-leadtime] window=${WINDOW_DAYS}d · ${Date.now() - t0}ms`)
console.log(`  matrix cells     : ${rows.length}`)
console.log(`  unique sources   : ${sources.size}`)
console.log(`  unique categories: ${categories.size}`)
console.log(`  strong (≥0.4)    : ${strongCells.length}`)
console.log(`  leading (>0d)    : ${leadingCells.length}`)

// Top 10 셀 (predictive_strength 내림차순)
const topRows = [...rows]
  .sort((a, b) => Number(b.predictive_strength ?? 0) - Number(a.predictive_strength ?? 0))
  .slice(0, 10)

console.log('\n  TOP 10 (by predictive_strength):')
for (const r of topRows) {
  console.log(
    `    ${String(r.source).padEnd(28)}  ${String(r.category_top).padEnd(14)}  lead=${String(r.lead_days).padStart(5)}d  ps=${r.predictive_strength}  n=${r.sample_n}`,
  )
}
