#!/usr/bin/env node
/**
 * cost-drift-scan — 임계치를 넘은 발행 SKU 를 한 줄씩 출력하고
 * SLACK_WEBHOOK_URL 또는 ALERT_EMAIL_WEBHOOK 환경변수가 있으면 푸시한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/cost-drift-scan.mjs
 *   node --env-file=.env.local scripts/cost-drift-scan.mjs --dry  # 푸시 없이 콘솔만
 *
 * 의존: jimscanner_v_listing_cost_drift 뷰 (supabase/trends_v4_cost_drift.sql).
 *
 * 임계치는 뷰 측 cost_drift_alert 플래그를 그대로 신뢰한다.
 */

import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락. --env-file=.env.local 로 실행하세요.')
  process.exit(1)
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const SLACK = process.env.SLACK_WEBHOOK_URL
const EMAIL_HOOK = process.env.ALERT_EMAIL_WEBHOOK

const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const { data, error } = await sb
  .from('jimscanner_v_listing_cost_drift')
  .select(
    'id, source_goods_no, registered_title, brand, dome_price_registered_krw, dome_price_current_krw, dome_price_delta_pct, estimated_margin_pct, recalculated_margin_pct, status_current, status_churn_30d, recommended_action, cost_drift_alert, product_id',
  )
  .eq('cost_drift_alert', true)
  .order('dome_price_delta_pct', { ascending: false, nullsFirst: false })
  .limit(100)

if (error) {
  console.error('view 조회 실패:', error.message)
  process.exit(2)
}

const rows = data ?? []
console.log(`[cost-drift-scan] ${new Date().toISOString()} — alert ${rows.length} 건`)
for (const r of rows) {
  const delta = r.dome_price_delta_pct == null ? '—' : `${r.dome_price_delta_pct >= 0 ? '+' : ''}${r.dome_price_delta_pct.toFixed(1)}%`
  const margin = r.recalculated_margin_pct == null ? '—' : `${r.recalculated_margin_pct.toFixed(1)}%`
  const baseMargin = r.estimated_margin_pct == null ? '—' : `${r.estimated_margin_pct.toFixed(1)}%`
  console.log(
    `  ⚠ ${r.source_goods_no} Δ${delta} 마진 ${baseMargin}→${margin} churn=${r.status_churn_30d} 액션=${r.recommended_action} | ${(r.registered_title ?? '').slice(0, 40)}`,
  )
}

if (rows.length === 0) {
  console.log('  ✓ 알람 없음')
  process.exit(0)
}

if (DRY) {
  console.log('[dry-run] 푸시 생략')
  process.exit(0)
}

function buildSlackPayload() {
  const top = rows.slice(0, 10)
  const lines = top.map((r) => {
    const delta = r.dome_price_delta_pct == null ? '—' : `${r.dome_price_delta_pct >= 0 ? '+' : ''}${r.dome_price_delta_pct.toFixed(1)}%`
    const margin = r.recalculated_margin_pct == null ? '—' : `${r.recalculated_margin_pct.toFixed(1)}%`
    const url = r.product_id ? ` <https://www.coupang.com/vp/products/${r.product_id}|쿠팡>` : ''
    return `• \`${r.source_goods_no}\` Δ도매 ${delta} → 재산정 마진 ${margin} · ${r.recommended_action}${url}`
  })
  return {
    text: `[jimscanner] 도매원가 드리프트 알람 ${rows.length}건`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📈 공급가 인상 알람 — ${rows.length}건` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') || '(없음)' },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '<https://www.jimscanner.co.kr/admin/coupang-publish/cost-drift|보드 열기>',
          },
        ],
      },
    ],
  }
}

let pushed = 0
let failed = 0

async function push(url, label, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`)
    console.log(`  ✓ ${label} 전송`)
    pushed++
  } catch (e) {
    console.error(`  ✗ ${label} 실패: ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}

if (SLACK) await push(SLACK, 'slack', buildSlackPayload())
if (EMAIL_HOOK) await push(EMAIL_HOOK, 'email', { subject: `cost-drift ${rows.length}건`, rows })

if (!SLACK && !EMAIL_HOOK) {
  console.log('  (SLACK_WEBHOOK_URL / ALERT_EMAIL_WEBHOOK 미설정 — 콘솔 출력만)')
}

process.exit(failed > 0 ? 1 : 0)
