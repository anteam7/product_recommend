#!/usr/bin/env node
/**
 * 품절→재입고 D-day 예측 cron.
 *
 * jimscanner_ggsan_restock_eta_list RPC 를 호출해 현재 sold_out SKU 별 ETA 를 계산하고,
 * D-3 이내 SKU 는 jimscanner_ggsan_restock_watch 큐에 upsert 한다 (status='watching').
 *
 * 재입고가 감지되면(상태가 active 로 복귀했을 때) scripts/coupang-register-one.mjs 가
 * 큐에서 watching SKU 를 끌어가 즉시 쿠팡 등록 — 재입고 24h 골든타임 선점용.
 *
 * 사용:
 *   node --env-file=.env.local scripts/predict-restock-eta.mjs
 *   node --env-file=.env.local scripts/predict-restock-eta.mjs --dry-run
 *   node --env-file=.env.local scripts/predict-restock-eta.mjs --threshold 5    # D-5 이내까지
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// .env.local 폴백 로드 (--env-file 안 쓸 때 대비)
function loadEnv() {
  try {
    const lines = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
    for (const l of lines) {
      const i = l.indexOf('=')
      const k = l.slice(0, i).trim()
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!process.env[k]) process.env[k] = v
    }
  } catch {
    // ignore — assume --env-file was used
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const thresholdIdx = args.indexOf('--threshold')
const threshold = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1]) : 3
const priorIdx = args.indexOf('--prior')
const prior = priorIdx >= 0 ? parseFloat(args[priorIdx + 1]) : 3

console.log(`[predict-restock-eta] threshold=D-${threshold}, prior=${prior}, dryRun=${dryRun}`)

const { data: rows, error } = await sb.rpc('jimscanner_ggsan_restock_eta_list', {
  prior_weight: prior,
  result_limit: 1000,
})

if (error) {
  console.error('RPC error:', error.message)
  process.exit(1)
}

const all = rows ?? []
console.log(`[predict-restock-eta] sold_out SKU 총 ${all.length}건`)

// D-threshold 이내(미래 + 지연 모두 포함) — 음수는 즉시 선점 가치 있음
const imminent = all.filter((r) => r.days_until_restock <= threshold)
console.log(`[predict-restock-eta] D-${threshold} 이내(+지연 포함): ${imminent.length}건`)

// 이미 watch 큐에 있는 항목 조회
const goodsNos = imminent.map((r) => r.goods_no)
let existing = new Set()
if (goodsNos.length > 0) {
  const { data: ex } = await sb
    .from('jimscanner_ggsan_restock_watch')
    .select('goods_no')
    .in('goods_no', goodsNos)
    .in('status', ['watching', 'registered'])
  existing = new Set((ex ?? []).map((r) => r.goods_no))
}

const toInsert = imminent.filter((r) => !existing.has(r.goods_no))
console.log(`[predict-restock-eta] 신규 푸시 대상: ${toInsert.length}건 (기존 watching/registered ${existing.size}건 skip)`)

if (dryRun) {
  for (const r of toInsert.slice(0, 20)) {
    const d = Math.round(r.days_until_restock)
    const dlabel = d < 0 ? `D+${Math.abs(d)}` : `D-${d}`
    console.log(`  ${dlabel.padEnd(7)} ${r.goods_no}  n=${r.sample_size}  ${r.title.slice(0, 50)}`)
  }
  if (toInsert.length > 20) console.log(`  ... 외 ${toInsert.length - 20}건`)
  console.log('[predict-restock-eta] dry-run 종료')
  process.exit(0)
}

let inserted = 0
let failed = 0
for (const r of toInsert) {
  const { error: insErr } = await sb.from('jimscanner_ggsan_restock_watch').upsert(
    {
      goods_no: r.goods_no,
      predicted_restock_at: r.predicted_restock_at,
      shrunk_median_days: r.shrunk_median_days,
      sample_size: r.sample_size,
      queued_by: 'predict-restock-eta',
      status: 'watching',
      notes: `auto: D-${Math.max(0, Math.round(r.days_until_restock))} (n=${r.sample_size}, sold_out ${r.days_sold_out.toFixed(1)}d)`,
    },
    { onConflict: 'goods_no' },
  )
  if (insErr) {
    failed++
    console.error(`  ✗ ${r.goods_no}: ${insErr.message}`)
  } else {
    inserted++
  }
}

// 부수효과: 재입고 완료된 watching 항목 정리 — 현재 active 인 SKU 의 watching 행은 status='expired' 로
// (재고 복귀 후 register-one 이 'registered' 로 안 바꿨다는 건 등록 누락 → 운영자 확인)
const watchingGoodsNos = (await sb
  .from('jimscanner_ggsan_restock_watch')
  .select('goods_no')
  .eq('status', 'watching'))
  .data?.map((r) => r.goods_no) ?? []

let expired = 0
if (watchingGoodsNos.length > 0) {
  const { data: nowActive } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, status')
    .in('goods_no', watchingGoodsNos)
    .eq('status', 'active')
  const expGoodsNos = (nowActive ?? []).map((r) => r.goods_no)
  if (expGoodsNos.length > 0) {
    await sb
      .from('jimscanner_ggsan_restock_watch')
      .update({ status: 'expired', ack_at: new Date().toISOString() })
      .in('goods_no', expGoodsNos)
      .eq('status', 'watching')
    expired = expGoodsNos.length
  }
}

console.log(
  `[predict-restock-eta] done · inserted=${inserted} failed=${failed} expired(=재입고 후 미등록)=${expired}`,
)
