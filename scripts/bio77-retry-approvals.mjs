/**
 * bio77-register.mjs 실행 중 "'임시저장' 상태의 상품만 승인 요청 가능합니다" 타이밍 오류로
 * 승인요청이 누락된 건을 찾아 재시도 + 재고설정까지 마무리.
 *   node --env-file=.env.local scripts/bio77-retry-approvals.mjs
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const sleep = ms => new Promise(r => setTimeout(r, ms))

function sign(m, p, q = '') { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + m + p + q).digest('hex') } }
async function api(m, p) {
  const { dt, sig } = sign(m, p)
  const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' } })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}

const { data: rows } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id, registered_title').eq('source', 'bio77').eq('status', 'TEMPORARY_SAVE')
console.log(`승인요청 누락 후보: ${rows?.length ?? 0}건`)

for (const row of rows ?? []) {
  const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}`)
  const statusName = detail.body?.data?.statusName
  if (statusName === '승인반려') {
    console.log(`⏭ ${row.registered_title} — 이미 승인반려(DENIED), 재시도 불가`)
    await sb.from('jimscanner_coupang_listings').update({ status: 'REJECTED', rejection_reason: '승인반려(DENIED)', last_synced_at: new Date().toISOString() }).eq('id', row.id)
    continue
  }
  const appr = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}/approvals`)
  if (appr.body?.code !== 'SUCCESS' && appr.body?.code !== 200) {
    console.log(`✗ ${row.registered_title} 승인요청 재시도 실패: ${JSON.stringify(appr.body).slice(0, 150)}`)
    await sleep(500); continue
  }
  await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', last_synced_at: new Date().toISOString() }).eq('id', row.id)
  console.log(`✓ ${row.registered_title} 승인요청 완료`)
  await sleep(1500)
  const d2 = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}`)
  const vendorItemIds = (d2.body?.data?.items ?? []).map(it => it.vendorItemId).filter(Boolean)
  if (vendorItemIds.length) {
    for (const vid of vendorItemIds) { await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/quantities/30`); await sleep(300) }
    console.log(`  → 재고 30개 설정 (vendorItemId ${vendorItemIds.join(',')})`)
  }
  await sleep(500)
}
console.log('=== 완료 ===')
