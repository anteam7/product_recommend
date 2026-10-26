/**
 * 쿠팡 전체 vendor-items 중 판매중지(onSale=false) 인 것을 모두 sales/resume 호출
 * 또한 재고가 0이면 5개로 채움
 *
 * 사용자 정책 변경: 노출 OFF → 노출 ON (재고 5개 + 정상 판매중)
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
const VENDOR_ID = env.COUPANG_VENDOR_ID
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST

function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + (query || '')).digest('hex') }
}
async function api(method, urlPath, query = '') {
  const { datetime, signature } = sign(method, urlPath, query)
  const res = await fetch(`${HOST}${urlPath}${query ? '?' + query : ''}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}

// 1. 전체 셀러 상품 페이징
console.log('[1] 셀러 상품 전체 스캔')
let nextToken = ''
const products = []
while (true) {
  const query = `vendorId=${VENDOR_ID}&maxPerPage=100${nextToken ? `&nextToken=${nextToken}` : ''}`
  const r = await api('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', query)
  if (r.status !== 200) break
  const list = r.body?.data ?? []
  products.push(...list)
  nextToken = r.body?.nextToken
  if (!nextToken || list.length === 0) break
  await new Promise((s) => setTimeout(s, 200))
}
console.log(`    총 ${products.length}건`)

// 2. 승인완료 상품의 vendorItem 추출
const approved = products.filter((p) => p.statusName === '승인완료')
console.log(`\n[2] 승인완료 ${approved.length}건의 vendorItem 추출`)
const vendorItems = []
for (const p of approved) {
  const d = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.sellerProductId}`)
  for (const it of (d.body?.data?.items ?? [])) {
    if (it.vendorItemId) vendorItems.push({ sellerProductId: p.sellerProductId, productName: p.sellerProductName, vendorItemId: it.vendorItemId, itemName: it.itemName })
  }
  await new Promise((s) => setTimeout(s, 100))
}
console.log(`    vendor-items ${vendorItems.length}건`)

// 3. inventory 조회 → 판매중지(onSale=false)/재고0 분류
console.log('\n[3] inventory 상태 조회')
const stopped = [], zeroStock = []
for (const v of vendorItems) {
  const r = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${v.vendorItemId}/inventories`)
  const data = r.body?.data
  if (!data) continue
  if (data.onSale === false) stopped.push({ ...v, inv: data })
  if (data.amountInStock === 0) zeroStock.push({ ...v, inv: data })
  await new Promise((s) => setTimeout(s, 100))
}
console.log(`    판매중지(onSale=false): ${stopped.length}건`)
console.log(`    재고0: ${zeroStock.length}건`)

// 사람이 내린 판매중지(DB status=STOPPED · auto_paused=false — 판매 종료·중복 정리)는 되살리지 않는다
// (2026-10-08 상어연골 판매 종료 — 반복 클레임으로 사용자가 영구 중지)
// auto_paused 가 NULL 인 옛 행도 사람이 내린 것으로 본다(재고 크론과 같은 기준: !auto_paused)
const { data: stoppedRows, error: msErr } = await sb.from('jimscanner_coupang_listings').select('seller_product_id, auto_paused').eq('status', 'STOPPED').range(0, 4999)
if (msErr) { console.error(`수동 판매중지 목록 조회 실패 — 중단(전부 되살릴 위험): ${msErr.message}`); process.exit(1) }
if ((stoppedRows ?? []).length >= 1000) { console.error(`STOPPED ${stoppedRows.length}행 — 조회 상한에 걸렸을 수 있어 중단(일부를 되살릴 위험)`); process.exit(1) }
const keepStopped = new Set((stoppedRows ?? []).filter((r) => !r.auto_paused).map((r) => String(r.seller_product_id)))
// 옵션만 판매 종료한 것(jimscanner_listing_items status=REMOVED — _coupang-stop-one.mjs --vitem)도 되살리지 않는다
const { data: removedRows, error: rmErr } = await sb.from('jimscanner_listing_items').select('market_item_id').eq('market', 'coupang').eq('status', 'REMOVED').not('market_item_id', 'is', null).range(0, 4999)
if (rmErr) { console.error(`옵션 판매 종료 목록 조회 실패 — 중단(되살릴 위험): ${rmErr.message}`); process.exit(1) }
if ((removedRows ?? []).length >= 1000) { console.error(`옵션 판매 종료 ${removedRows.length}행 — 조회 상한에 걸렸을 수 있어 중단(일부를 되살릴 위험)`); process.exit(1) }
const removedVids = new Set((removedRows ?? []).map((r) => String(r.market_item_id)))
const skipManual = (v) => keepStopped.has(String(v.sellerProductId)) || removedVids.has(String(v.vendorItemId))
console.log(`    수동 판매중지 유지: ${stopped.filter(skipManual).length}건 제외`)

// 4. 판매중지된 것 → sales/resume
console.log('\n[4] 판매중지 → 판매재개')
let resumed = 0, failR = 0
for (const v of stopped.filter((x) => !skipManual(x))) {
  const r = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${v.vendorItemId}/sales/resume`)
  if (r.status === 200 && (r.body?.code === 'SUCCESS' || r.body?.code === 200)) {
    resumed++
    console.log(`  ✓ ${v.vendorItemId} ${v.productName.slice(0, 45)}`)
  } else {
    failR++
    console.log(`  ✗ ${v.vendorItemId} | ${JSON.stringify(r.body).slice(0, 150)}`)
  }
  await new Promise((s) => setTimeout(s, 200))
}

// 5. 재고0 → 5개 (resume 후 다시 체크)
console.log('\n[5] 재고0 → 5개')
let qtyOk = 0, failQ = 0
for (const v of zeroStock.filter((x) => !skipManual(x))) {
  const r = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${v.vendorItemId}/quantities/5`)
  if (r.status === 200 && (r.body?.code === 'SUCCESS' || r.body?.code === 200)) {
    qtyOk++
  } else {
    failQ++
    console.log(`  ✗ ${v.vendorItemId} | ${JSON.stringify(r.body).slice(0, 100)}`)
  }
  await new Promise((s) => setTimeout(s, 200))
}
console.log(`    재고 5개 변경: ${qtyOk}`)

// 6. DB sync — 우리 listings의 판매상태/노출 업데이트
await sb.from('jimscanner_coupang_listings').update({
  auto_paused: false,
  coupang_sale_stopped_at: null,
  displayable: true,
  stock_status: 'in_stock',
  last_synced_at: new Date().toISOString(),
}).eq('status', 'APPROVED')

console.log(`\n=== 완료 ===  판매재개: ${resumed}/${stopped.length}, 재고변경: ${qtyOk}/${zeroStock.length}`)
