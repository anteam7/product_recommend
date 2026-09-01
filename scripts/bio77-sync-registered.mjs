/**
 * 77bio → 쿠팡 Wing 수동(XLSM 대량등록) 업로드분을 찾아서 jimscanner_coupang_listings에 연결.
 *   node --env-file=.env.local scripts/bio77-sync-registered.mjs [--dry]
 *
 * 배경: bio77-register.mjs(Open API 직접 등록)가 쿠팡의 "필수 구매옵션 입력 의무화" 정책(2026-02-02)에
 * 막혀서, 사용자가 77bio 쿠팡용 XLSM을 직접 Wing "상품 일괄등록"에 업로드하는 방식으로 등록을 진행한다.
 * 이 스크립트는 그렇게 Wing으로 올라간 상품을 쿠팡 계정 전체 상품 목록에서 찾아
 * jimscanner_coupang_listings(source='bio77')에 연결해서, 이후 가격/재고 관리 도구들이 추적할 수 있게 한다.
 *
 * 매칭 방법:
 *   1) jimscanner_bio77_products.title과 쿠팡 sellerProductName 정확/포함 일치로 1차 후보 선정
 *   2) 후보의 상세(GET seller-products/{id})를 조회해 items[].externalVendorSku가 77bio goods_no와
 *      일치하는지로 확정(Wing 업로드 시 "업체상품코드" 컬럼이 그대로 externalVendorSku로 들어감 — 2026-09-01 가정,
 *      불일치 시 제목 매칭만으로 fallback 확정하되 로그에 명시)
 *
 * 연결 후 관리: 가격/재고 변경은 vendorItemId 기반 API라 등록 경로(Open API vs Wing)와 무관하게 그대로 동작한다.
 * 다만 재고 자동동기화(local-cron-stock-sync.mjs)는 현재 ggsan/upickb2b 전용이라 bio77은 별도 확장이 필요 —
 * 이 스크립트는 "연결"까지만 하고, 재고 크론 확장은 후속 작업.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST
const DRY = process.argv.includes('--dry')
const sleep = ms => new Promise(s => setTimeout(s, ms))

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

// ── 77bio 후보 (아직 연결 안 된 것만) ──
const { data: candidates } = await sb.from('jimscanner_bio77_products').select('goods_no, title, dome_price_krw, msp_price_krw, coupang_category_code').eq('coupang_sellable', true)
const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no').eq('source', 'bio77')
const linkedSet = new Set((existing ?? []).map(r => r.source_goods_no))
const unlinked = (candidates ?? []).filter(r => !linkedSet.has(r.goods_no))
console.log(`77bio 미연결 후보: ${unlinked.length}건 (전체 ${candidates?.length ?? 0}건 중 ${linkedSet.size}건 이미 연결됨)\n`)
if (unlinked.length === 0) { console.log('연결할 후보 없음 — 종료'); process.exit(0) }

// 정규화된 제목 → 77bio row 매핑(공백/괄호 제거해 느슨하게 비교)
const norm = s => String(s || '').replace(/[\s()[\]·,\-_/]/g, '').toLowerCase()
const titleMap = new Map(unlinked.map(r => [norm(r.title), r]))

// ── 쿠팡 전체 셀러 상품 페이징 스캔 ──
console.log('쿠팡 셀러 상품 전체 스캔 중...')
let nextToken = ''
let scanned = 0
const nameMatches = []
while (true) {
  const query = `vendorId=${VENDOR_ID}&maxPerPage=100${nextToken ? `&nextToken=${nextToken}` : ''}`
  const r = await api('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', query)
  if (r.status !== 200) { console.log('스캔 ERROR:', JSON.stringify(r.body).slice(0, 300)); break }
  const list = r.body?.data ?? []
  scanned += list.length
  for (const it of list) {
    const row = titleMap.get(norm(it.sellerProductName))
    if (row) nameMatches.push({ row, sellerProductId: it.sellerProductId, sellerProductName: it.sellerProductName, statusName: it.statusName })
  }
  nextToken = r.body?.nextToken
  if (!nextToken || list.length === 0) break
  await sleep(150)
}
console.log(`스캔 완료: 총 ${scanned}건 중 제목 매칭 ${nameMatches.length}건\n`)

// ── 상세 조회로 externalVendorSku 확정 + 연결 ──
let linked = 0, skuMismatch = 0
for (const m of nameMatches) {
  const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${m.sellerProductId}`)
  const items = detail.body?.data?.items ?? []
  const sku = items[0]?.externalVendorSku != null ? String(items[0].externalVendorSku) : null
  const skuOk = sku === String(m.row.goods_no)
  if (sku && !skuOk) {
    // externalVendorSku가 있는데 다른 상품번호면 오탐 — 연결하지 않음
    skuMismatch++
    console.log(`  ⚠ 제목매칭했으나 SKU 불일치 — SKIP: [${m.sellerProductId}] "${m.sellerProductName}" externalVendorSku=${sku} ≠ goods_no=${m.row.goods_no}`)
    await sleep(200); continue
  }
  console.log(`  ✓ [${m.sellerProductId}] ${m.sellerProductName} | status=${m.statusName} | goods_no=${m.row.goods_no} ${sku ? '(SKU확인)' : '(제목매칭만, SKU없음)'}`)
  if (!DRY) {
    const { error } = await sb.from('jimscanner_coupang_listings').insert({
      seller_product_id: m.sellerProductId, vendor_id: VENDOR_ID, source: 'bio77',
      source_goods_no: m.row.goods_no, registered_title: m.row.title,
      display_category_code: m.row.coupang_category_code,
      dome_price_krw: m.row.dome_price_krw, msp_price_krw: m.row.msp_price_krw, list_price_krw: m.row.msp_price_krw,
      status: m.statusName || 'APPROVED', displayable: /SELLING/i.test(m.statusName || ''),
      registered_at: new Date().toISOString(), last_synced_at: new Date().toISOString(),
    })
    if (error) { console.log(`     insert ERR: ${error.message}`); await sleep(200); continue }
  }
  linked++
  await sleep(200)
}

console.log(`\n=== 완료 ${DRY ? '[DRY]' : ''} ===`)
console.log(`연결: ${linked}건 / SKU불일치 제외: ${skuMismatch}건 / 미매칭(쿠팡에서 못 찾음): ${unlinked.length - nameMatches.length}건`)
