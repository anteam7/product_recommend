/**
 * upickb2b 카탈로그 → 쿠팡 임시저장 등록.
 *   단건:  node scripts/upickb2b-register.mjs --no=<product_no> [--price=N] [--request] [--dry]
 *   배치:  node scripts/upickb2b-register.mjs [--limit=N] [--request] [--dry]
 *
 * 대상(배치): jimscanner_upickb2b_products 중 all_markets_ok=true(모든마켓 판매가능)·status='active'·
 *             jimscanner_coupang_listings 미등록. (싼 매입가 순)
 * 가격: listPrice = max(최저판매가, 마진하한) — 🛑 최저판매가 절대 준수. 자율판매는 마진하한.
 *       dome(매입원가)=member_price_krw(부가세포함). 위탁 dropship → 출고배송 3000만.
 * 흐름: 쿠팡 카테고리 예측 → 메타 → 고시(가공식품/건강기능식품)+속성+이미지 →
 *       POST seller-products(requested=false 임시저장) → jimscanner_coupang_listings INSERT(source='upickb2b').
 *   (coupang-register-batch-v2 / domeggook-register-one 패턴 재사용)
 * ⚠️ 브랜드는 현재 상품명 첫 단어(naive). 실제 승인요청(--request) 대량 전 브랜드/GTIN 보강 필요(2026 쿠팡 정책).
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

// 운영 상수 (domeggook/batch-v2와 동일 출고/반품지)
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717, RETURN_CENTER_CODE = '1002609354', RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000, RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8', RETURN_ADDRESS_DETAIL = '301', RETURN_ZIP_CODE = '08703', CONTACT = '010-4164-3802'
const SOURCE_SHIP = 0, OUTBOUND_SHIP = 3000, FEE_RATE = 0.106
const TARGET_NET = 0.10  // 자율판매(MSP 없음) 목표 순마진
const STABLE_CATEGORY_CODES = new Set([73137, 58927])  // 안정 등록되는 식품 카테고리 (그 외는 73137 폴백)

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const NO = arg('no'); const PRICE_OVERRIDE = parseInt(arg('price') || '0') || 0; const LIMIT = parseInt(arg('limit') || '0') || 0
const REQUESTED = process.argv.includes('--request'); const DRY = process.argv.includes('--dry')
const MIN_MARGIN = parseFloat(arg('min-margin') || '0') || 0  // 배치 시 이 순마진% 미만 상품 제외
const CLEAR = process.argv.includes('--clear')  // upickb2b 임시저장 draft 전체 삭제(재등록 전 정리)

function sign(m, p) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SK).update(dt + m + p).digest('hex') } }
async function cp(m, p, b) { const { dt, sig } = sign(m, p); const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t } } }
const metaDir = path.join(__dirname, '..', '_tmp_meta_cache'); if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true })
async function getMeta(code) { const p = path.join(metaDir, `${code}_raw.json`); if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); const r = await cp('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${code}`); if (r.s !== 200 || !r.b?.data) throw new Error('meta ' + code + ' ' + r.s); writeFileSync(p, JSON.stringify(r.b.data, null, 2), 'utf8'); return r.b.data }
function pickUnit(units, prefs) { if (!units || !units.length) return ''; for (const x of prefs) if (units.includes(x)) return x; return units[0] }
async function downloadable(u) { try { const r = await fetch(u); return r.status === 200 && /image\//.test(r.headers.get('content-type') || '') } catch { return false } }

function parseAttrs(title) {
  const out = {}; const t = (title || '').replace(/[,()]/g, ' ').replace(/\s+/g, ' ')
  const mw = t.match(/(\d+(?:\.\d+)?)\s*(mg|g|kg)\b/i); if (mw) { let v = parseFloat(mw[1]); const u = mw[2].toLowerCase(); if (u === 'kg') v *= 1000; else if (u === 'mg') v /= 1000; out.개당중량 = v }
  const mv = t.match(/(\d+(?:\.\d+)?)\s*(ml|L)\b/i); if (mv) { let v = parseFloat(mv[1]); if (mv[2].toLowerCase() === 'l') v *= 1000; out.개당용량 = v }
  const bm = [...t.matchAll(/[xX×*]\s*(\d+)\s*(병|정|캡슐|포|개입|회분)/g)]; let bundle = null
  if (bm.length) { const last = bm[bm.length - 1]; bundle = { value: parseInt(last[1]), unit: last[2] } } else { const m = t.match(/\b(\d+)\s*(정|캡슐|포|병|개입|회분)\b/); if (m) bundle = { value: parseInt(m[1]), unit: m[2] } }
  if (bundle) out.개당캡슐정 = bundle.value
  out.수량 = 1; return out
}
function pickNoticeCategory(ncs) { if (!ncs || !ncs.length) return null; for (const p of ['가공식품', '건강기능식품']) { const f = ncs.find((n) => n.noticeCategoryName === p); if (f) return f } return ncs[0] }
function buildNotices(nc, title) {
  if (!nc) return []; const name = nc.noticeCategoryName; const isImport = /직수입|수입/.test(title)
  const valueFor = (dn) => {
    if (/제품명|품명|품목/.test(dn)) return title
    if (/포장단위|용량.*중량|중량.*용량/.test(dn)) return title
    if (/주의|안전/.test(dn)) return '직사광선을 피하고 서늘한 곳에 보관하시기 바랍니다. 알레르기 체질·특이체질은 원재료를 확인 후 섭취하시기 바랍니다. 본 제품은 질병의 예방·치료를 위한 의약품이 아닙니다.'
    if (/유전자변형|GMO/.test(dn)) return '해당없음'
    if (/수입.*문구|수입.*여부/.test(dn)) return isImport ? '수입식품에 해당하며 한글표시사항을 별도 부착함' : '해당없음'
    if (/상담.*전화|전화번호/.test(dn)) return CONTACT
    if (/원산지/.test(dn)) return isImport ? '수입산' : '국산'
    return '상세설명 참조'
  }
  const mandatory = (nc.noticeCategoryDetailNames ?? []).filter((d) => d.required === 'MANDATORY')
  return mandatory.map((d) => ({ noticeCategoryName: name, noticeCategoryDetailName: d.noticeCategoryDetailName, content: valueFor(d.noticeCategoryDetailName) }))
}
function buildItemAttributes(catAttrs, parsed) {
  const isLiquid = parsed.개당용량 != null && parsed.개당용량 > 0
  const hasSuryang = catAttrs.some((a) => a.attributeTypeName === '수량'); const fallbackName = hasSuryang ? '수량' : '총 수량'
  return catAttrs.map((a) => {
    const nm = a.attributeTypeName
    if (nm === fallbackName || nm === '수량' || nm === '총 수량') { const u = pickUnit(a.usableUnits, ['박스', '세트', '개', '팩']); return { attributeTypeName: nm, attributeValueName: `1 ${u}`, exposed: 'EXPOSED' } }
    if (nm === '개당 캡슐/정' && a.required === 'MANDATORY') { const u = pickUnit(a.usableUnits, ['회분', '정']); const v = parsed.개당캡슐정 || 30; return { attributeTypeName: nm, attributeValueName: `${v} ${u}`, exposed: 'NONE' } }
    if (nm === '개당 중량' && a.required === 'MANDATORY') { const u = pickUnit(a.usableUnits, ['g', 'kg']); const v = parsed.개당중량 != null && parsed.개당중량 > 0 ? parsed.개당중량 : (isLiquid ? 1 : 0); return { attributeTypeName: nm, attributeValueName: `${v} ${u}`, exposed: 'NONE' } }
    if (nm === '개당 용량' && a.required === 'MANDATORY') { const u = pickUnit(a.usableUnits, ['ml', 'L']); const v = parsed.개당용량 != null && parsed.개당용량 > 0 ? parsed.개당용량 : 0; return { attributeTypeName: nm, attributeValueName: `${v} ${u}`, exposed: 'NONE' } }
    return { attributeTypeName: nm, attributeValueName: '', exposed: 'NONE' }
  })
}

// 가격 산정 (카테고리 예측 불필요 — 배치 사전 필터에도 사용)
function computePrice(row) {
  const dome = row.member_price_krw || 0
  const msp = row.min_sell_price_krw ?? 0
  const realCost = dome + SOURCE_SHIP + OUTBOUND_SHIP
  // 목표 순마진(m) 가격: sale = 0.9091*원가 / (0.8031 - m)  (수수료 10.6% + 순VAT. 매입가 부가세포함 → 입력VAT 공제)
  const priceForNet = (cost, m) => Math.ceil((0.9091 * cost / (0.8031 - m)) / 100) * 100
  const breakeven = priceForNet(realCost, 0)  // 순마진 0 손익분기
  // 정책: 최저판매가(MSP)에 등록 — 공급사 floor이자 가장 경쟁력 있는 합법가. MSP가 손익분기 미만이면 breakeven까지만 상향.
  //       자율판매(MSP 없음)는 목표 순마진(TARGET_NET).
  let listPrice
  if (PRICE_OVERRIDE) listPrice = PRICE_OVERRIDE
  else if (msp > 0) listPrice = Math.max(msp, breakeven)
  else listPrice = priceForNet(realCost, TARGET_NET)
  listPrice = Math.ceil(listPrice / 100) * 100
  const fee = Math.round(listPrice * FEE_RATE)
  const grossSpread = listPrice - realCost
  const netVat = Math.max(0, Math.round(grossSpread / 11))  // 순VAT = (판매-매입-배송)/11 (입력VAT 공제 반영)
  const margin = grossSpread - fee - netVat
  const marginPct = +(margin / listPrice * 100).toFixed(2)
  return { dome, msp, realCost, listPrice, fee, margin, marginPct, belowBreakeven: msp > 0 && msp < breakeven }
}

async function buildPayload(row) {
  const { dome, msp, listPrice, fee, margin, marginPct } = computePrice(row)

  // 카테고리 예측 → 비안정 카테고리는 73137(기타영양제) 폴백 → 메타
  const pr = await cp('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', { productName: row.title })
  const cat = pr.b?.data
  if (!cat?.predictedCategoryId) throw new Error('카테고리 예측 실패')
  let displayCategoryCode = parseInt(cat.predictedCategoryId)
  const categoryNameOrig = cat.predictedCategoryName
  const isFallback = !STABLE_CATEGORY_CODES.has(displayCategoryCode)
  if (isFallback) displayCategoryCode = 73137
  const meta = await getMeta(displayCategoryCode)
  const noticeNames = (meta.noticeCategories ?? []).map((n) => n.noticeCategoryName)
  if (!(noticeNames.includes('가공식품') || noticeNames.includes('건강기능식품'))) throw new Error(`비식품 카테고리(${noticeNames.join(',')}) — 건강식품만 등록`)

  const parsed = parseAttrs(row.title)
  const notices = buildNotices(pickNoticeCategory(meta.noticeCategories), row.title)
  const itemAttributes = buildItemAttributes(meta.attributes ?? [], parsed)

  // 이미지: 대표=image_thumb, 상세 contents=images(다운로드 가능분, 최대 10)
  const thumb = row.image_thumb
  const imgs = Array.isArray(row.images) ? row.images : []
  const contentImgs = []
  for (const u of imgs.slice(0, 14)) { if (await downloadable(u)) contentImgs.push(u); if (contentImgs.length >= 10) break }
  const items_images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: thumb }]
  const contents = contentImgs.map((u) => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] }))

  let itemName = '1박스'
  if (parsed.개당캡슐정) { const ca = (meta.attributes ?? []).find((a) => a.attributeTypeName === '개당 캡슐/정'); const u = ca ? pickUnit(ca.usableUnits, ['정', '회분']) : '정'; itemName = `${parsed.개당캡슐정}${u} 1박스` }
  const originalPrice = Math.max(listPrice, Math.ceil(listPrice * 1.2 / 100) * 100)

  const payload = {
    vendorId: VENDOR_ID, sellerProductName: row.title, displayProductName: row.title, displayCategoryCode,
    brand: (row.title || '').split(/\s+/)[0], generalProductName: row.title, productGroup: (row.title || '').split(/\s+/).slice(0, 3).join(' '), manufacture: '상세설명 참조',
    saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: 'CJGLS', deliveryChargeType: 'FREE', deliveryCharge: 0, freeShipOverAmount: 0, deliveryChargeOnReturn: 3000,
    remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY',
    returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: CONTACT, returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL, returnCharge: RETURN_CHARGE,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE, vendorUserId: 'anteam7', requested: REQUESTED,
    items: [{
      itemName, originalPrice, salePrice: listPrice, maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1, outboundShippingTimeDay: 2, unitCount: 1,
      adultOnly: 'EVERYONE', taxType: 'TAX', parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
      externalVendorSku: String(row.self_code || row.product_no), images: items_images, notices, attributes: itemAttributes, contents, offerCondition: 'NEW',
    }],
    notices: [], requiredDocuments: [],
  }
  return { payload, dome, msp, listPrice, fee, margin, marginPct, displayCategoryCode, categoryName: isFallback ? `기타영양제(원본:${categoryNameOrig})` : categoryNameOrig, contentImgCount: contentImgs.length, repOk: !!thumb }
}

// ── --clear: upickb2b 임시저장 draft 전체 삭제 (재등록 전 정리) ──
if (CLEAR) {
  const { data: all } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id, status').eq('source', 'upickb2b')
  console.log(`upickb2b listings ${all?.length || 0}건 삭제 시작...`)
  let del = 0, drafts = 0
  for (const p of (all || [])) {
    if (p.seller_product_id && ['TEMPORARY_SAVE', 'FAILED'].includes(p.status)) { const d = await cp('DELETE', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.seller_product_id}`); if (d.s === 200) drafts++; await new Promise(r => setTimeout(r, 300)) }
    await sb.from('jimscanner_coupang_listings').delete().eq('id', p.id)
    del++; if (del % 50 === 0) console.log(`  ${del}건...`)
  }
  console.log(`완료: listings ${del}건 삭제 (쿠팡 draft ${drafts}건 삭제)`)
  process.exit(0)
}

// ── 대상 선정 ──
let rows = []
if (NO) {
  const { data } = await sb.from('jimscanner_upickb2b_products').select('*').eq('product_no', String(NO)).limit(1)
  rows = data || []
  if (!rows.length) { console.error(`product_no=${NO} 없음`); process.exit(1) }
  const r0 = rows[0]
  if (!r0.coupang_allowed) { console.error(`🚫 ${NO} 쿠팡 금지/폐쇄몰 — 등록 불가 (${r0.sellable_platforms})`); process.exit(2) }
  if (!r0.all_markets_ok) console.warn(`⚠️ ${NO} '모든마켓 판매가능' 아님 (${r0.sellable_platforms}) — 단건 테스트로만 진행`)
  // 재등록: 기존 임시저장 draft + listings row 정리 (중복 방지)
  if (!DRY) {
    const { data: prev } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id, status').eq('source', 'upickb2b').eq('source_goods_no', String(NO))
    for (const p of (prev || [])) {
      if (p.seller_product_id && ['TEMPORARY_SAVE', 'FAILED'].includes(p.status)) { const d = await cp('DELETE', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.seller_product_id}`); console.log(`기존 draft ${p.seller_product_id} 삭제: HTTP ${d.s}`) }
      await sb.from('jimscanner_coupang_listings').delete().eq('id', p.id)
    }
  }
} else {
  const { data: cand } = await sb.from('jimscanner_upickb2b_products').select('*').eq('all_markets_ok', true).eq('status', 'active').order('member_price_krw', { ascending: false })
  const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no').eq('source', 'upickb2b')
  const ex = new Set((existing || []).map((r) => r.source_goods_no))
  const EXCLUDE = /사은품|증정|샘플|체험단|판촉/
  let pool = (cand || []).filter((r) => !ex.has(r.product_no) && !EXCLUDE.test(r.title || ''))
  const before = pool.length
  if (MIN_MARGIN > 0) pool = pool.filter((r) => computePrice(r).marginPct >= MIN_MARGIN)
  console.log(`후보 ${before}건 → 마진 ${MIN_MARGIN}%+ 통과 ${pool.length}건 (사은품/샘플 + 박한마진 제외)`)
  rows = pool
  if (LIMIT) rows = rows.slice(0, LIMIT)
}

console.log(`=== upickb2b→쿠팡 ${NO ? '단건' : '배치'} 등록 ${DRY ? '[DRY]' : ''} | 대상 ${rows.length}건 | requested=${REQUESTED} ===\n`)
const summary = { ok: 0, fail: 0, errors: [] }
for (let i = 0; i < rows.length; i++) {
  const row = rows[i]; const idx = `[${i + 1}/${rows.length}]`
  try {
    const built = await buildPayload(row)
    if (DRY) {
      console.log(`${idx} ▷ ${row.product_no} ${(row.title || '').slice(0, 34).padEnd(34)} | cat ${built.displayCategoryCode}(${built.categoryName}) | 회원가 ${built.dome}→판매 ${built.listPrice} (MSP ${built.msp || '-'}, ${built.marginPct}%) | 고시${built.payload.items[0].notices.length} 속성${built.payload.items[0].attributes.length} 대표${built.repOk ? 'O' : 'X'}/상세${built.contentImgCount}`)
      summary.ok++; await new Promise((r) => setTimeout(r, 300)); continue
    }
    const res = await cp('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    const success = res.s === 200 && res.b?.code === 'SUCCESS'
    const spid = typeof res.b?.data === 'number' ? res.b.data : (String(res.b?.data || '').match(/^\d+$/) ? parseInt(res.b.data) : null)
    writeFileSync(path.join(metaDir, `..`, `_tmp_upick_register_${row.product_no}.json`), JSON.stringify({ payload: built.payload, response: res.b }, null, 2), 'utf8')
    await sb.from('jimscanner_coupang_listings').insert({
      seller_product_id: spid, vendor_id: VENDOR_ID, source: 'upickb2b', source_goods_no: row.product_no, source_detail_url: row.detail_url,
      registered_title: row.title, display_category_code: built.displayCategoryCode, display_category_name: built.categoryName, brand: built.payload.brand,
      dome_price_krw: built.dome, source_shipping_fee_krw: SOURCE_SHIP, outbound_shipping_fee_krw: OUTBOUND_SHIP, msp_price_krw: built.msp,
      list_price_krw: built.listPrice, estimated_fee_krw: built.fee, estimated_margin_krw: built.margin, estimated_margin_pct: built.marginPct,
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false, rejection_reason: success ? null : (res.b?.message ?? String(res.b).slice(0, 500)),
      request_payload: built.payload, last_response: res.b, registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    })
    if (success) { summary.ok++; console.log(`${idx} ✓ ${row.product_no} ${(row.title || '').slice(0, 36).padEnd(36)} | ${built.listPrice.toLocaleString().padStart(8)} (${built.marginPct}%) | sellerPID=${spid}`) }
    else { summary.fail++; const reason = (res.b?.message ?? JSON.stringify(res.b)).slice(0, 160); summary.errors.push({ no: row.product_no, reason }); console.log(`${idx} ✗ ${row.product_no} [${built.displayCategoryCode}] ${(row.title || '').slice(0, 32)} | ${reason}`) }
  } catch (e) { summary.fail++; summary.errors.push({ no: row.product_no, reason: e.message }); console.log(`${idx} ✗ ${row.product_no} ERROR: ${e.message}`) }
  await new Promise((r) => setTimeout(r, 500))
}
console.log(`\n=== 완료: 성공 ${summary.ok} / 실패 ${summary.fail} ===`)
if (summary.errors.length) summary.errors.slice(0, 25).forEach((e) => console.log(`  - ${e.no}: ${e.reason}`))
