/**
 * 루프 엔지니어링 — Sense 단계 (쿠팡)
 * DB 현재 상태 스캔 → jimscanner_loop_action_queue 생성
 *
 * 감지 규칙:
 *   restock(80)          : STOPPED + stock_status=in_stock  → 재고 복구 가능
 *   review-rejected(90)  : REJECTED / FAILED               → 수동 검토 필요 (human_review)
 *   request-approval(60) : TEMPORARY_SAVE                  → 승인 재요청
 *   review-display(70)   : APPROVED + displayable=false    → 노출 제한 검토 (human_review)
 *
 * 실행: node scripts/loop-sense-coupang.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) { console.error(`env 누락: ${key}`); process.exit(1) }
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

console.log('[1] jimscanner_coupang_listings 조회…')
const { data: listings, error: lErr } = await sb
  .from('jimscanner_coupang_listings')
  .select('seller_product_id, registered_title, status, stock_status, displayable, source_goods_no')
  .neq('status', 'SKIPPED')

if (lErr) { console.error('listings 조회 실패:', lErr.message); process.exit(1) }
if (!listings) { console.error('listings 응답 null'); process.exit(1) }
console.log(`    ${listings.length}건\n`)

// 이미 큐에 있는 pending/in_progress/human_review 항목 → dedup용
const { data: existing, error: eErr } = await sb
  .from('jimscanner_loop_action_queue')
  .select('product_id, action_type')
  .eq('market', 'coupang')
  .in('status', ['pending', 'in_progress', 'human_review'])
if (eErr) { console.error('기존 큐 조회 실패:', eErr.message); process.exit(1) }

const existingSet = new Set((existing ?? []).map(e => `${e.product_id}::${e.action_type}`))

console.log('[2] 규칙 적용 중…')
const candidates = []

for (const r of listings) {
  const pid = r.seller_product_id?.toString()
  if (!pid) continue

  const push = (action_type, priority, status = 'pending', extra = {}) => {
    const key = `${pid}::${action_type}`
    if (existingSet.has(key)) return
    candidates.push({
      market: 'coupang',
      product_id: pid,
      product_name: (r.registered_title ?? '').slice(0, 100),
      action_type,
      priority,
      status,
      payload: { source_goods_no: r.source_goods_no, ...extra },
      retry_count: 0,
    })
    existingSet.add(key)
  }

  // 규칙 1: 재고 복구 가능 (ggsan 재입고됐는데 쿠팡이 STOPPED)
  if (r.status === 'STOPPED' && r.stock_status === 'in_stock') {
    push('restock', 80)
  }

  // 규칙 2: 거절/실패 → 사람 검토
  if (r.status === 'REJECTED' || r.status === 'FAILED') {
    push('review-rejected', 90, 'human_review', { db_status: r.status })
  }

  // 규칙 3: 임시저장 → 승인 재요청
  if (r.status === 'TEMPORARY_SAVE') {
    push('request-approval', 60)
  }

  // 규칙 4: 승인완료지만 노출 꺼짐 → 사람 검토
  if (r.status === 'APPROVED' && r.displayable === false) {
    push('review-display', 70, 'human_review')
  }
}

const now = new Date().toISOString()
const toInsert = candidates.map(c => ({ ...c, created_at: now, updated_at: now }))

console.log(`\n[3] 큐 삽입 (신규 ${toInsert.length}건)`)

const dist = {}
for (const c of toInsert) dist[`${c.action_type}(${c.status})`] = (dist[`${c.action_type}(${c.status})`] ?? 0) + 1
for (const [k, v] of Object.entries(dist)) console.log(`    ${k.padEnd(35)} : ${v}`)

if (toInsert.length > 0) {
  const { error } = await sb.from('jimscanner_loop_action_queue').insert(toInsert)
  if (error) { console.error('큐 삽입 실패:', error.message); process.exit(1) }
}

console.log('\nSense 완료.')
