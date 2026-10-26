/**
 * 단건 판매중지(품절 처리): 지정 seller_product_id 의 vendor-item 전부 sales/stop
 * + DB status=STOPPED / auto_paused=true / stock_status=sold_out.
 * ⚠ 기본(auto_paused=true)은 "자동 품절"로 기록돼 재고 크론이 재입고 때 판매재개한다.
 * --permanent: 사람이 내린 판매 종료 — 수량 0 + DB auto_paused=false + rejection_reason 에 사유.
 *   재고 크론(STOPPED+auto_paused=false 제외)·coupang-sync-listings·coupang-resume-all 이 되살리지 않는다.
 * --permanent --vitem=<vendorItemId>: 옵션 하나만 판매 종료 — 그 옵션만 판매중지·수량 0, 상품 DB 는 그대로 두고
 *   jimscanner_listing_items 에 status=REMOVED 로 기록(재고 크론 재입고 재개·수량 보충과 coupang-resume-all 이 제외).
 * 되돌리기(재개)는 vendor-items/{id}/sales/resume 로 가능(옵션 모드는 listing_items 행도 ACTIVE 로 되돌릴 것).
 *   node scripts/_coupang-stop-one.mjs 16227353976            (dry-run)
 *   node scripts/_coupang-stop-one.mjs 16227353976 --apply
 *   node scripts/_coupang-stop-one.mjs 16227353976 --permanent --reason="매입처 수량 부족" --apply
 *   node scripts/_coupang-stop-one.mjs 16407211160 --permanent --vitem=96159424515 --apply
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const PERMANENT = process.argv.includes('--permanent')
const REASON = (process.argv.find((a) => a.startsWith('--reason=')) || '').split('=').slice(1).join('=').trim()
const VITEM_ARG = process.argv.find((a) => a.startsWith('--vitem'))
const VITEM = (VITEM_ARG || '').split('=')[1]?.trim() || ''
if (VITEM_ARG && !VITEM) { console.error('✗ --vitem 값이 비었습니다 — 상품 전체로 넘어가지 않게 중단'); process.exit(1) }
const SPID = (process.argv.find((a) => /^\d{6,20}$/.test(a)) || '').trim()
if (!SPID) { console.error('✗ seller_product_id(숫자)를 인자로 주세요'); process.exit(1) }
if (VITEM && (!PERMANENT || !/^\d{6,20}$/.test(VITEM))) { console.error('✗ --vitem=<vendorItemId 숫자> 는 --permanent 와 함께만 씁니다(옵션 판매 종료)'); process.exit(1) }
if (PERMANENT && !VITEM && !REASON) { console.error('✗ --permanent 는 --reason="사유" 가 필요합니다(DB rejection_reason 에 기록)'); process.exit(1) }

let envText
try { envText = readFileSync('C:/Web/jimscanner-personal/.env.local', 'utf8') } catch (e) { console.error(`✗ .env.local 읽기 실패: ${e.message}`); process.exit(1) }
const env = Object.fromEntries(envText.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_API_HOST']) {
  if (!env[k]) { console.error(`✗ ${k} 미설정 — .env.local 확인`); process.exit(1) }
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { COUPANG_ACCESS_KEY: ACCESS_KEY, COUPANG_SECRET_KEY: SECRET_KEY, COUPANG_API_HOST: HOST } = env

function sign(m, p, q = '') { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + m + p + (q || '')).digest('hex') } }
async function api(m, p, q = '') {
  const { dt, sig } = sign(m, p, q)
  const r = await fetch(`${HOST}${p}${q ? '?' + q : ''}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' } })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`=== ${APPLY ? 'APPLY' : 'DRY-RUN'} | 판매중지 대상 ${SPID}${VITEM ? ` 옵션 ${VITEM}만` : ''} | ${PERMANENT ? `판매 종료(영구${REASON ? `, 사유: ${REASON}` : ''})` : '자동 품절(재입고 시 재개)'} ===`)
const { data: listing, error: lErr } = await sb.from('jimscanner_coupang_listings')
  .select('id, registered_title, status, source, source_goods_no, list_price_krw, auto_paused, stock_status')
  .eq('seller_product_id', SPID).maybeSingle()
if (lErr) { console.error(`✗ DB 조회 실패: ${lErr.message}`); process.exit(1) }
if (!listing) console.log('⚠ DB 리스팅 없음 — 쿠팡 판매중지만 수행(있다면)')
else console.log(`DB: ${listing.registered_title} | status=${listing.status} | ${listing.source}/${listing.source_goods_no} | 판매가 ${listing.list_price_krw}`)

const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${SPID}`)
if (detail.status !== 200) { console.error(`✗ 쿠팡 상품조회 실패(status ${detail.status}): ${JSON.stringify(detail.body).slice(0, 300)}`); process.exit(2) }
const d = detail.body?.data
const allItems = ((d?.items ?? [])).filter((it) => it.vendorItemId)
console.log(`쿠팡: ${d?.sellerProductName ?? '(이름 없음)'} | statusName=${d?.statusName} | vendorItem ${allItems.length}개`)
for (const it of allItems) console.log(`  ${VITEM && String(it.vendorItemId) === VITEM ? '▶' : '-'} vItem ${it.vendorItemId} ${it.itemName ?? ''} | 업체코드 ${it.externalVendorSku ?? '-'} | ${it.salePrice ?? '?'}원`)
const items = VITEM ? allItems.filter((it) => String(it.vendorItemId) === VITEM) : allItems
if (!items.length) { console.error(VITEM ? `✗ 옵션 ${VITEM} 이 이 상품에 없음` : '✗ vendorItem 없음 — 중지 불가'); process.exit(2) }
if (VITEM && !listing) { console.error('✗ 옵션 판매 종료는 DB 리스팅이 있어야 기록할 수 있음(매입처·상품번호)'); process.exit(2) }
if (VITEM) console.log(`→ 옵션 ${VITEM} 만 판매중지·수량 0, 나머지 ${allItems.length - 1}개 옵션은 그대로. listing_items REMOVED 기록`)
if (!APPLY) { console.log('\n[dry-run] 실제 중지 안 함. 반영하려면 --apply'); process.exit(0) }

// HTTP 200 이어도 본문 code 가 ERROR 면 실패로 본다
const okRes = (r) => r.status === 200 && !(r.body?.code && r.body.code !== 'SUCCESS')
let allOk = true
const qtyFailed = []
for (const it of items) {
  const rp = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/sales/stop`)
  if (!okRes(rp)) { allOk = false; console.log(`  ✗ vItem ${it.vendorItemId} 중지 실패: ${JSON.stringify(rp.body).slice(0, 200)}`) }
  else console.log(`  ✓ vItem ${it.vendorItemId} 판매중지`)
  if (PERMANENT && okRes(rp)) {
    // 판매중지 반영이 늦어도 노출된 재고로 주문이 들어오지 않게 수량도 0(재고 크론 품절 처리와 같은 방식)
    const rq = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/0`)
    if (okRes(rq)) console.log(`  ✓ vItem ${it.vendorItemId} 수량 0`)
    else { qtyFailed.push(it.vendorItemId); console.log(`  ⚠ vItem ${it.vendorItemId} 수량 0 실패(판매중지는 됨): ${JSON.stringify(rq.body).slice(0, 200)}`) }
  }
  await sleep(250)
}
if (!allOk) { console.error('✗ 일부 vendorItem 중지 실패 — DB 상태 변경 안 함(재실행 필요)'); process.exit(3) }

if (VITEM) {
  // 옵션 판매 종료 — 옵션 매핑 행이 있으면(캠핑문 등) 상태만 바꾸고, 없으면 새로 만든다(묶음 수는 업체코드 "-N" 접미사)
  const it = items[0]
  const now = new Date().toISOString()
  const { data: upd, error: uErr } = await sb.from('jimscanner_listing_items').update({ status: 'REMOVED', updated_at: now }).eq('market', 'coupang').eq('market_item_id', VITEM).select('id')
  if (uErr) { console.error(`✗ listing_items 갱신 실패: ${uErr.message} — 쿠팡은 중지됨, 재고 크론이 재입고 때 되살릴 수 있으니 수동 기록 필요`); process.exit(4) }
  if (!upd?.length) {
    const pack = Number((String(it.externalVendorSku ?? '').match(/-(\d+)$/) || String(it.itemName ?? '').match(/(\d+)\s*개/) || [])[1]) || 1
    const { error: iErr } = await sb.from('jimscanner_listing_items').insert({
      market: 'coupang', listing_key: SPID, market_item_id: VITEM,
      external_sku: it.externalVendorSku || `${listing.source}:${listing.source_goods_no}:-:${pack}`,
      source: listing.source, goods_no: String(listing.source_goods_no), item_code: null,
      option_value: it.itemName ?? null, pack_qty: pack, sale_price: it.salePrice ?? null, status: 'REMOVED',
    })
    if (iErr) { console.error(`✗ listing_items 기록 실패: ${iErr.message} — 쿠팡은 중지됨, 재고 크론이 재입고 때 되살릴 수 있으니 수동 기록 필요`); process.exit(4) }
  }
  console.log(`✓ DB: listing_items 옵션 ${VITEM} status=REMOVED(${upd?.length ? '기존 행 갱신' : '새 행'}) — 상품 리스팅 상태는 그대로`)
} else if (listing) {
  const now = new Date().toISOString()
  const { error } = await sb.from('jimscanner_coupang_listings').update({
    status: 'STOPPED',
    auto_paused: !PERMANENT,
    stock_status: 'sold_out',
    stock_sold_out_at: now,
    coupang_sale_stopped_at: now,
    last_synced_at: now,
    updated_at: now,
    ...(PERMANENT ? { rejection_reason: `[판매 종료 ${now.slice(0, 10)}] ${REASON}` } : {}),
  }).eq('id', listing.id)
  if (error) { console.error(`✗ DB 갱신 실패: ${error.message} — 쿠팡은 중지됨, DB 수동 확인 필요`); process.exit(4) }
  console.log(`✓ DB: status=STOPPED / auto_paused=${!PERMANENT} / stock_status=sold_out${PERMANENT ? ' / rejection_reason 기록(재고 크론 영구 제외)' : ''}`)
} else if (PERMANENT) console.log('⚠ DB 리스팅 없음 — 영구 제외 표시 못 함(쿠팡 판매중지만 됨)')
if (qtyFailed.length) { console.error(`⚠ 수량 0 실패 vItem ${qtyFailed.join(', ')} — 판매중지는 됐으니 Wing 에서 수량 확인`); process.exit(5) }
console.log('=== 완료 ===')
