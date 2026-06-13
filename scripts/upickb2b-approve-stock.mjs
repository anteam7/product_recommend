/**
 * upickb2b 임시저장 상품 → 판매가능(승인요청) + 재고 5개 일괄.
 *   node scripts/upickb2b-approve-stock.mjs --limit=3   # 시범
 *   node scripts/upickb2b-approve-stock.mjs --apply     # 전체
 *
 * 흐름: /approvals 승인요청 → GET vendorItemId → /vendor-items/{id}/quantities/5 → DB sync.
 * ⚠️ 쿠팡 검수는 수시간~1-2일. 검수 중이면 vendorItem 미발급 → PENDING_APPROVAL 로 두고,
 *    승인 후 이 스크립트 재실행(또는 stock-sync 크론)이 재고 5 적용.
 * ※ 판매중지 안 함 — 승인되면 바로 판매(노출). (coupang-bulk-approve-stock 의 유픽 전용·비중지판)
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const AK = env.COUPANG_ACCESS_KEY, SK = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const NEW_QTY = 5

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const APPLY = process.argv.includes('--apply')
const LIMIT = parseInt(arg('limit', APPLY ? '9999' : '3'))
const MIN_PROFIT = parseInt(arg('min-profit', '2000'))  // 순마진 금액(원) 하한 — 이 이상만 판매상태(승인요청)

function sign(m, p) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SK).update(dt + m + p).digest('hex') } }
async function api(m, p) { const { dt, sig } = sign(m, p); const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' } }); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t } } }
const ok = (r) => r.s === 200 && (r.b?.code === 'SUCCESS' || r.b?.code === 200)
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

const { data: listings } = await sb.from('jimscanner_coupang_listings')
  .select('id, seller_product_id, registered_title, estimated_margin_krw')
  .eq('source', 'upickb2b').eq('status', 'TEMPORARY_SAVE').not('seller_product_id', 'is', null)
  .gte('estimated_margin_krw', MIN_PROFIT)
  .order('estimated_margin_krw', { ascending: false }).limit(LIMIT)

console.log(`=== upickb2b 판매가능 처리 | 순마진 ≥ ${MIN_PROFIT.toLocaleString()}원 | 대상 ${listings?.length || 0}건 (임시저장) ${APPLY ? '[APPLY]' : '[시범]'} ===\n`)
let appr = 0, qty = 0, pending = 0, fail = 0
for (let i = 0; i < (listings?.length || 0); i++) {
  const r = listings[i]; const idx = `[${i + 1}/${listings.length}]`
  try {
    // 1) 승인요청
    const a = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${r.seller_product_id}/approvals`)
    if (!ok(a)) {
      // 이미 승인요청/승인된 경우도 있으니 GET 으로 상태 확인 후 진행
      const dd = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${r.seller_product_id}`)
      if (!dd.b?.data) { fail++; console.log(`${idx} ✗ ${r.seller_product_id} 승인요청 실패: ${JSON.stringify(a.b).slice(0, 140)}`); continue }
    } else appr++
    // 2) vendorItemId
    await sleep(1500)
    const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${r.seller_product_id}`)
    const d = detail.b?.data
    const items = (d?.items ?? []).filter((it) => it.vendorItemId)
    if (!items.length) {
      pending++
      await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', approval_status_name: d?.statusName, last_synced_at: new Date().toISOString() }).eq('id', r.id)
      console.log(`${idx} ⏳ ${r.seller_product_id} ${(r.registered_title || '').slice(0, 32)} | ${d?.statusName} — vendorItem 미발급(검수 대기), 재고는 승인 후`)
      continue
    }
    // 3) 재고 5 (판매중지 안 함)
    for (const it of items) { const q = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/${NEW_QTY}`); if (ok(q)) qty++; await sleep(200) }
    // 4) DB — 승인완료면 판매가능(displayable), 아니면 검수 대기
    const isApproved = d?.statusName === '승인완료'
    await sb.from('jimscanner_coupang_listings').update({
      status: isApproved ? 'APPROVED' : 'PENDING_APPROVAL', approval_status_name: d?.statusName,
      displayable: isApproved, stock_status: 'in_stock', approved_at: isApproved ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    }).eq('id', r.id)
    console.log(`${idx} ✓ ${r.seller_product_id} ${(r.registered_title || '').slice(0, 34).padEnd(34)} | ${d?.statusName} | vendorItem ${items.length} 재고=${NEW_QTY}`)
  } catch (e) { fail++; console.log(`${idx} ✗ ${r.seller_product_id} ERROR: ${e.message}`) }
  await sleep(300)
}
console.log(`\n=== 완료 === 승인요청 ${appr} · 재고적용 ${qty} · 검수대기 ${pending} · 실패 ${fail}`)
