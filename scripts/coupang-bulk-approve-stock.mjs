/**
 * 임시저장 상품 일괄 처리:
 *   1) /approvals 호출 → 승인 요청
 *   2) vendorItemId 발급 확인
 *   3) /vendor-items/{id}/quantities/5 → 재고 5개 (판매중 유지)
 *   4) listings 테이블 status=APPROVED/PENDING_APPROVAL, displayable=true, auto_paused=false
 *
 * 사용:
 *   node scripts/coupang-bulk-approve-stock.mjs --limit=3   # 3건 시범
 *   node scripts/coupang-bulk-approve-stock.mjs --apply     # 전체
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST

const args = process.argv.slice(2)
const limitRaw = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '999')
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 999
const NEW_QTY = 5

function sign(method, urlPath) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath).digest('hex') }
}
async function api(method, urlPath) {
  const { datetime, signature } = sign(method, urlPath)
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}

const { data: listings, error: listingsErr } = await sb
  .from('jimscanner_coupang_listings')
  .select('id, seller_product_id, registered_title')
  .eq('status', 'TEMPORARY_SAVE')
  .not('seller_product_id', 'is', null)
  .order('created_at', { ascending: true })
  .limit(limit)

if (listingsErr) { console.error('DB 조회 실패:', listingsErr.message); process.exit(1) }
if (!listings || listings.length === 0) { console.log('임시저장 상품 없음'); process.exit(0) }

console.log(`대상 ${listings.length}건\n`)

let approved = 0, qtyOk = 0, fail = 0

for (let i = 0; i < listings.length; i++) {
  const r = listings[i]
  const idx = `[${i + 1}/${listings.length}]`
  const pid = encodeURIComponent(String(r.seller_product_id))
  try {
    // 1. /approvals 승인요청
    const apprResp = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${pid}/approvals`)
    const apprOk = apprResp.status === 200 && (apprResp.body?.code === 'SUCCESS' || apprResp.body?.code === 200)
    if (!apprOk) {
      fail++
      console.log(`${idx} ✗ ${r.seller_product_id} 승인요청 실패: ${JSON.stringify(apprResp.body).slice(0, 150)}`)
      continue
    }
    approved++

    // 2. GET → vendorItemId 추출
    await new Promise((s) => setTimeout(s, 1500))
    const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${pid}`)
    const d = detail.body?.data
    const items = (d?.items ?? []).filter((it) => it.vendorItemId)
    if (items.length === 0) {
      console.log(`${idx} ⏳ ${r.seller_product_id} vendorItemId 미부여 — 검수 대기 (1-2일)`)
      const { error: pendErr } = await sb.from('jimscanner_coupang_listings').update({
        status: 'PENDING_APPROVAL',
        approval_status_name: d?.statusName,
        last_synced_at: new Date().toISOString(),
      }).eq('id', r.id)
      if (pendErr) console.error(`  DB 업데이트 실패: ${pendErr.message}`)
      continue
    }

    // 3. 재고 5개 (판매중 유지)
    const vendorItemIds = []
    for (const it of items) {
      const vid = encodeURIComponent(String(it.vendorItemId))
      const qty = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/quantities/${NEW_QTY}`)
      if (qty.status === 200 && (qty.body?.code === 'SUCCESS' || qty.body?.code === 200)) qtyOk++
      vendorItemIds.push(it.vendorItemId)
      await new Promise((s) => setTimeout(s, 200))
    }

    // 4. DB sync
    const { error: dbErr } = await sb.from('jimscanner_coupang_listings').update({
      status: d?.statusName === '승인완료' ? 'APPROVED' : 'PENDING_APPROVAL',
      approval_status_name: d?.statusName,
      displayable: true,
      auto_paused: false,
      coupang_sale_stopped_at: null,
      approved_at: d?.statusName === '승인완료' ? new Date().toISOString() : null,
      last_synced_at: new Date().toISOString(),
    }).eq('id', r.id)
    if (dbErr) console.error(`  DB 업데이트 실패: ${dbErr.message}`)

    console.log(`${idx} ✓ ${r.seller_product_id} ${r.registered_title.slice(0, 38).padEnd(38)} | ${d?.statusName} | vendorItem ${vendorItemIds.length}건 qty=${NEW_QTY} 판매중`)
  } catch (e) {
    fail++
    console.log(`${idx} ✗ ${r.seller_product_id} ERROR: ${e.message}`)
  }
}

console.log(`\n=== 완료 ===  승인요청: ${approved}, 재고변경: ${qtyOk}, 실패: ${fail}`)
