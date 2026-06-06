/**
 * 도매꾹 상품 1건 → 쿠팡 임시저장 등록 (일반 공산품 파이프라인).
 *   node scripts/domeggook-register-one.mjs --no=<도매꾹itemNo> --price=<쿠팡판매가> [--name="..."] [--request]
 *
 * 흐름: 도매꾹 getItemView → 쿠팡 카테고리 예측 → 카테고리 메타 →
 *       비전자 고시("기타 재화" 우선, KC요구 고시 회피) + 속성 + 이미지(상세 contents 포함)
 *       → POST 임시저장(requested=false) → jimscanner_coupang_listings INSERT(source='domeggook').
 * 주의: 전자제품(소형전자/가정용전기/어린이제품 고시만 있는 카테고리)은 KC인증 필요 → 등록 보류.
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID, AK = env.COUPANG_ACCESS_KEY, SK = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const DKEY = env.DOMEGGOOK_API_KEY, DBASE = 'https://domeggook.com/ssl/api/'

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const NO = arg('no'); const PRICE = parseInt(arg('price') || '0'); const NAME_OVERRIDE = arg('name'); const REQUESTED = process.argv.includes('--request')
if (!NO || !PRICE) { console.error('필수: --no=<itemNo> --price=<판매가>'); process.exit(1) }

// 운영 상수 (register-one과 동일 — 출고/반품지)
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717, RETURN_CENTER_CODE = '1002609354', RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000, RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8', RETURN_ADDRESS_DETAIL = '301', RETURN_ZIP_CODE = '08703', CONTACT = '010-4164-3802'
const OUTBOUND_SHIP = 3000, FEE_RATE = 0.106

function sign(m, p) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SK).update(dt + m + p).digest('hex') } }
async function cp(m, p, b) { const { dt, sig } = sign(m, p); const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t } } }
const metaDir = path.join(__dirname, '..', '_tmp_meta_cache'); if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true })
async function getMeta(code) { const p = path.join(metaDir, `${code}_raw.json`); if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); const r = await cp('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${code}`); if (r.s !== 200 || !r.b?.data) throw new Error('meta ' + code + ' ' + r.s); writeFileSync(p, JSON.stringify(r.b.data, null, 2), 'utf8'); return r.b.data }
function pickUnit(units, prefs) { if (!units || !units.length) return ''; for (const x of prefs) if (units.includes(x)) return x; return units[0] }

// 1) 도매꾹 상세
const vr = await fetch(`${DBASE}?ver=4.1&mode=getItemView&aid=${DKEY}&no=${NO}&om=json`)
const dgg = (JSON.parse(await vr.text())?.domeggook) || {}
if (!dgg.basis) { console.error('도매꾹 상품 조회 실패'); process.exit(1) }
const title = dgg.basis.title
// 무재고 위탁 실제 매입가 = 도매매(supply) 가격. 도매꾹(dome)은 직접매입가(더 쌈)이므로 위탁 원가로 쓰면 안 됨.
const domePrice = parseInt(dgg.price?.supply ?? dgg.price?.dome) || 0
const fromOversea = !!dgg.deli?.fromOversea
const rep = dgg.thumb?.original || dgg.thumb?.large
const contents = dgg.desc?.contents || ''
// 상세 이미지: 공급사 배송/반품 안내 boilerplate 제외 + 다운로드 가능(쿠팡이 못 받으면 승인반려)한 것만.
const BOILER = /배송|반품|교환|환불|인트로|문의|공지|delivery|return|exchange|notice|intro|구매안내|cs/i
async function downloadable(u) { try { const r = await fetch(u); return r.status === 200 && /image\//.test(r.headers.get('content-type') || '') } catch { return false } }
const rawImgs = [...new Set((contents.match(/https?:\/\/[^"'\s)]+\.(?:jpe?g|png|gif|webp)/gi) || []))]
const contentImgs = []
for (const u of rawImgs.slice(0, 20)) { if (BOILER.test(decodeURIComponent(u))) continue; if (await downloadable(u)) contentImgs.push(u); if (contentImgs.length >= 12) break }
const name = (NAME_OVERRIDE || title).slice(0, 100)

// 2) 쿠팡 카테고리 예측
const pr = await cp('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', { productName: name })
const cat = pr.b?.data
if (!cat?.predictedCategoryId) { console.error('카테고리 예측 실패:', JSON.stringify(pr.b).slice(0, 150)); process.exit(1) }
const displayCategoryCode = parseInt(cat.predictedCategoryId)
const meta = await getMeta(displayCategoryCode)

// 3) 고시 카테고리 선택 — 전자/KC 요구 고시 회피, "기타 재화"/비전자 우선
const ELEC = /전자|전기|어린이|살생물|화학/
const ncs = meta.noticeCategories || []
let nc = ncs.find((n) => n.noticeCategoryName === '기타 재화') || ncs.find((n) => !ELEC.test(n.noticeCategoryName)) || ncs[0]
if (!nc) { console.error('고시 카테고리 없음'); process.exit(1) }
const onlyElec = ncs.length > 0 && ncs.every((n) => ELEC.test(n.noticeCategoryName))
if (onlyElec) { console.error(`⚠️ 이 카테고리(${displayCategoryCode} ${cat.predictedCategoryName})는 전자/KC 고시만 존재 → KC인증 필요, 등록 보류`); process.exit(2) }

function fillNotice(detailName) {
  const n = detailName
  if (/품명|제품명|모델/.test(n)) return name
  if (/인증|허가|KC/.test(n)) return '안전기준 비대상 생활용품 (해당없음)'
  if (/전화|연락|상담|A\/?S|책임자/.test(n)) return CONTACT
  if (/제조국|원산지/.test(n)) return '상세설명 참조'
  if (/제조자|수입자|제조사/.test(n)) return '상세설명 참조'
  if (/품질보증|보증기준/.test(n)) return '관련 법 및 소비자분쟁해결기준에 따름'
  if (/출시|제조연월|년월/.test(n)) return '상세설명 참조'
  return '상세설명 참조'
}
const notices = (nc.noticeCategoryDetailNames || []).map((x) => ({ noticeCategoryName: nc.noticeCategoryName, noticeCategoryDetailName: x.noticeCategoryDetailName, content: fillNotice(x.noticeCategoryDetailName) }))

// 4) 속성 — 수량 EXPOSED, 사이즈/색상 등 MANDATORY는 placeholder, 나머지 빈값
const catAttrs = meta.attributes || []
const itemAttributes = catAttrs.map((a) => {
  const nm = a.attributeTypeName
  if (nm === '수량' || nm === '총 수량') { const u = pickUnit(a.usableUnits, ['개', '세트', '박스', '팩']); return { attributeTypeName: nm, attributeValueName: `1 ${u}`, exposed: 'EXPOSED' } }
  // 그 외(MANDATORY 포함)는 빈 값 — 단위 있는 속성에 비숫자 placeholder를 넣으면 "유효하지 않은 구매옵션 값/단위" 오류. 빈 값이면 "필수 미입력" 경고로 임시저장은 통과(승인 전 보완).
  return { attributeTypeName: nm, attributeValueName: '', exposed: 'NONE' }
})

// 5) 이미지 + 상세 contents
const items_images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: rep }]
const contentsArr = contentImgs.map((u) => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] }))

// 6) 가격/마진
const fee = Math.round(PRICE * FEE_RATE), vat = Math.round(PRICE / 11)
const realCost = domePrice + OUTBOUND_SHIP, margin = PRICE - realCost - fee - vat, marginPct = +(margin / PRICE * 100).toFixed(2)

const payload = {
  vendorId: VENDOR_ID, sellerProductName: name, displayProductName: name, displayCategoryCode,
  brand: name.split(/\s+/)[0], generalProductName: name, productGroup: name.split(/\s+/).slice(0, 3).join(' '), manufacture: '상세설명 참조',
  saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
  deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: 'CJGLS', deliveryChargeType: 'FREE', deliveryCharge: 0, freeShipOverAmount: 0, deliveryChargeOnReturn: 3000,
  remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY',
  returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: CONTACT, returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL, returnCharge: RETURN_CHARGE,
  outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE, vendorUserId: 'anteam7', requested: REQUESTED,
  items: [{
    itemName: '단품', originalPrice: Math.max(Math.ceil(PRICE * 1.2 / 100) * 100, PRICE), salePrice: PRICE,
    maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1, outboundShippingTimeDay: 3, unitCount: 1,
    adultOnly: 'EVERYONE', taxType: 'TAX', parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: fromOversea ? 'OVERSEAS_PURCHASED' : 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
    externalVendorSku: String(NO), images: items_images, notices, attributes: itemAttributes.filter((a) => a.attributeValueName !== ''), contents: contentsArr, offerCondition: 'NEW',
  }],
  notices: [], requiredDocuments: [],
}

console.log(`=== 도매꾹→쿠팡 임시저장 등록 ===`)
console.log(`도매꾹 ${NO} | ${title.slice(0, 50)}`)
console.log(`카테고리 ${displayCategoryCode}(${cat.predictedCategoryName}) | 고시 [${nc.noticeCategoryName}] | 상세img ${contentImgs.length} | 대표 ${rep ? 'O' : 'X'}`)
console.log(`도매 ${domePrice.toLocaleString()} + 배송 ${OUTBOUND_SHIP} → 판매가 ${PRICE.toLocaleString()} | 마진 ${margin.toLocaleString()}원 (${marginPct}%) | requested=${REQUESTED}`)

const res = await cp('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', payload)
console.log(`\nHTTP ${res.s} | ${JSON.stringify(res.b).slice(0, 400)}`)
const success = res.s === 200 && res.b?.code === 'SUCCESS'
const spid = res.b?.data?.toString().match(/^\d+$/) ? parseInt(res.b.data) : null
writeFileSync(path.join(__dirname, '..', `_tmp_dgg_register_${NO}.json`), JSON.stringify({ payload, response: res.b }, null, 2), 'utf8')

const { data: ins, error } = await sb.from('jimscanner_coupang_listings').insert({
  seller_product_id: spid, vendor_id: VENDOR_ID, source: 'domeggook', source_goods_no: String(NO), source_detail_url: `https://domeggook.com/${NO}`,
  registered_title: name, display_category_code: displayCategoryCode, display_category_name: cat.predictedCategoryName,
  brand: payload.brand, dome_price_krw: domePrice, source_shipping_fee_krw: 0, outbound_shipping_fee_krw: OUTBOUND_SHIP, msp_price_krw: 0,
  list_price_krw: PRICE, estimated_fee_krw: fee, estimated_margin_krw: margin, estimated_margin_pct: marginPct,
  status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false, rejection_reason: success ? null : JSON.stringify(res.b).slice(0, 500),
  request_payload: payload, last_response: res.b, registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
}).select('id').single()
console.log(error ? `DB insert 실패: ${error.message}` : `DB row ${ins.id} (${success ? 'TEMPORARY_SAVE' : 'FAILED'})`)
