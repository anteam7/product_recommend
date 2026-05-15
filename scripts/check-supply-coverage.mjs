#!/usr/bin/env node
// ────────────────────────────────────────────────────────────
// check-supply-coverage.mjs
// ────────────────────────────────────────────────────────────
// 일 1회 실행. v_supply_diversification 에서 single_source_risk = true
// 인 후보를 모두 jimscanner_supply_alerts 에 스냅샷 + 콘솔 요약.
// 사용처: cron, 또는 npm run check:supply
// ────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const { data: rows, error } = await sb
  .from('v_supply_diversification')
  .select(
    'product_id, canonical_name, category_top, supplier_count, supplier_sources, ' +
      'ggsan_goods_no, in_stock_count, limited_count, out_of_stock_count, inventory_total, ' +
      'price_cv, min_lead_time_days, single_source_risk, risk_label',
  )
  .eq('single_source_risk', true)
  .limit(2000)

if (error) {
  console.error('view query failed:', error.message)
  process.exit(1)
}

const list = rows ?? []
console.log(`[supply-coverage] single-source-risk 후보: ${list.length}건`)

const byLabel = list.reduce((acc, r) => {
  acc[r.risk_label] = (acc[r.risk_label] ?? 0) + 1
  return acc
}, {})
console.log('  breakdown:', byLabel)

// alert 스냅샷 — 같은 날짜+product 면 충돌 (UNIQUE) 이므로 ignore.
const snapshot_at = new Date().toISOString()
const inserts = list.map((r) => ({
  product_id: r.product_id,
  risk_label: r.risk_label,
  supplier_count: r.supplier_count,
  ggsan_goods_no: r.ggsan_goods_no,
  snapshot_at,
}))

if (inserts.length > 0) {
  // chunk 500
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500)
    const { error: insErr } = await sb
      .from('jimscanner_supply_alerts')
      .upsert(chunk, { onConflict: 'product_id,snapshot_at', ignoreDuplicates: true })
    if (insErr) {
      console.error('alert insert failed:', insErr.message)
      process.exit(1)
    }
  }
  console.log(`[supply-coverage] ${inserts.length}건 alert 스냅샷 적재 (snapshot_at=${snapshot_at})`)
}

// Top 20 콘솔 출력
console.log('\nTop 20 (no_supplier > single_supplier > out_of_stock):')
const order = { no_supplier: 0, single_supplier: 1, all_out_of_stock_or_limited: 2 }
list
  .slice()
  .sort((a, b) => (order[a.risk_label] ?? 9) - (order[b.risk_label] ?? 9))
  .slice(0, 20)
  .forEach((r) => {
    const inv =
      r.inventory_total > 0
        ? `${r.in_stock_count}/${r.limited_count}/${r.out_of_stock_count}`
        : '—'
    console.log(
      `  [${r.risk_label}] ${r.canonical_name} (cat=${r.category_top}, suppliers=${r.supplier_count}, inv=${inv})`,
    )
  })

process.exit(0)
