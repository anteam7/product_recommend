/**
 * v2: 카테고리 메타 동적 사용 + 단위 호환성 + notice 카테고리 동적
 *
 * 핵심 개선:
 *   1) 카테고리 메타의 attributes만 그대로 보냄 (없는 attribute는 안 보냄)
 *   2) 단위는 attribute.usableUnits에서 호환되는 것 선택
 *      - 수량: ['박스','세트','개','팩'] 우선순위
 *      - 개당 캡슐/정: ['회분','정'] 우선순위
 *   3) notice는 메타 noticeCategories 중 "가공식품" 우선, 없으면 "건강기능식품", 없으면 첫 번째
 *   4) 모든 mandatory detail name을 정확히 사용 (메타에서 가져옴)
 *
 * 사용: node scripts/coupang-register-batch-v2.mjs [--retry-failed]
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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

const OUTBOUND_SHIPPING_PLACE_CODE = 24724717
const RETURN_CENTER_CODE = '1002609354'
const RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8'
const RETURN_ADDRESS_DETAIL = '301'
const RETURN_ZIP_CODE = '08703'
const COMPANY_CONTACT = '010-4164-3802'
// 위탁(dropship): ggsan이 고객에게 직접 출고 → 실 배송비는 1회분(고객 출고)만 발생.
// 기존엔 매입배송 3000 + 발송배송 3000 = 6000을 원가에 넣어 판매가가 과다하게 부풀려졌음(2026-05-29 수정).
const SOURCE_SHIP = 0       // (구 3000) 매입배송 — dropship에서 중복이라 제거
const OUTBOUND_SHIP = 3000  // 고객 출고 배송비 (실비, 무료배송이라 셀러 흡수)
const COUPANG_FEE_RATE = 0.106  // 기타 영양제(73137) 판매수수료 10.6% (결제비 포함) — src/lib/coupang/price.ts FEE_RATE와 반드시 동일

const args = process.argv.slice(2)
const retryFailed = args.includes('--retry-failed')

const metaCacheDir = path.join(__dirname, '..', '_tmp_meta_cache')
if (!existsSync(metaCacheDir)) mkdirSync(metaCacheDir, { recursive: true })

function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + query).digest('hex') }
}
async function api(method, urlPath, body = null) {
  const { datetime, signature } = sign(method, urlPath, '')
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}

// 메타 raw 통째로 캐시 (attributes + noticeCategories 둘 다 필요)
async function getCategoryMeta(displayCategoryCode) {
  const cachePath = path.join(metaCacheDir, `${displayCategoryCode}_raw.json`)
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8'))
  }
  const r = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${displayCategoryCode}`)
  if (r.status !== 200 || !r.body?.data) throw new Error(`meta fetch failed ${displayCategoryCode}`)
  writeFileSync(cachePath, JSON.stringify(r.body.data, null, 2), 'utf8')
  return r.body.data
}

// 단위 호환 선택
function pickUnit(usableUnits, preferences) {
  if (!usableUnits || usableUnits.length === 0) return null
  for (const p of preferences) if (usableUnits.includes(p)) return p
  return usableUnits[0]
}

function parseAttrs(title) {
  const out = {}
  const t = title.replace(/[,()]/g, ' ').replace(/\s+/g, ' ')
  const mw = t.match(/(\d+(?:\.\d+)?)\s*(mg|g|kg)\b/i)
  if (mw) {
    let v = parseFloat(mw[1]); let u = mw[2].toLowerCase()
    if (u === 'kg') v *= 1000; else if (u === 'mg') v /= 1000
    out.개당중량 = v
  }
  const mv = t.match(/(\d+(?:\.\d+)?)\s*(ml|L)\b/i)
  if (mv) {
    let v = parseFloat(mv[1])
    if (mv[2].toLowerCase() === 'l') v *= 1000
    out.개당용량 = v
  }
  const bundleMatches = [...t.matchAll(/[xX×*]\s*(\d+)\s*(병|정|캡슐|포|개입|회분)/g)]
  let bundle = null
  if (bundleMatches.length > 0) {
    const last = bundleMatches[bundleMatches.length - 1]
    bundle = { value: parseInt(last[1]), unit: last[2] }
  } else {
    const m = t.match(/\b(\d+)\s*(정|캡슐|포|병|개입|회분)\b/)
    if (m) bundle = { value: parseInt(m[1]), unit: m[2] }
  }
  if (bundle) out.개당캡슐정 = bundle.value
  out.수량 = 1
  return out
}

// notice 카테고리 선택: 가공식품 > 건강기능식품 > 첫 번째
function pickNoticeCategory(noticeCategories) {
  if (!noticeCategories || noticeCategories.length === 0) return null
  const preferred = ['가공식품', '건강기능식품']
  for (const p of preferred) {
    const f = noticeCategories.find((n) => n.noticeCategoryName === p)
    if (f) return f
  }
  return noticeCategories[0]
}

function buildNotices(noticeCategory, title) {
  if (!noticeCategory) return []
  const name = noticeCategory.noticeCategoryName
  const isImport = /직수입|수입/.test(title)
  // 라벨별 기본 값 매핑 — 정확한 라벨이 메타에서 옴
  const valueFor = (detailName) => {
    if (/제품명|품명|품목/.test(detailName)) return title
    if (/포장단위|용량.*중량|중량.*용량/.test(detailName)) return title
    if (/주의|안전/.test(detailName)) return '직사광선을 피하고 서늘한 곳에 보관하시기 바랍니다. 알레르기 체질 등 특이체질인 경우 원재료를 확인하신 후 섭취하시기 바랍니다.'
    if (/유전자변형|GMO/.test(detailName)) return '해당없음'
    if (/수입.*문구|수입.*여부/.test(detailName)) return isImport ? '수입식품에 해당하며 한글표시사항을 별도 부착함' : '해당없음'
    if (/상담.*전화|전화번호/.test(detailName)) return COMPANY_CONTACT
    if (/원산지/.test(detailName)) return isImport ? '수입산' : '국산'
    return '상세설명 참조'
  }
  const mandatory = (noticeCategory.noticeCategoryDetailNames ?? []).filter((dn) => dn.required === 'MANDATORY')
  return mandatory.map((dn) => ({
    noticeCategoryName: name,
    noticeCategoryDetailName: dn.noticeCategoryDetailName,
    content: valueFor(dn.noticeCategoryDetailName),
  }))
}

function buildItemAttributes(categoryAttrs, parsedAttrs) {
  // 모든 MANDATORY 값 채움 (노출제한 방지) — 검증된 룰
  //   - 수량 1 박스 (EXPOSED)
  //   - 개당 캡슐/정: 입수량 (있으면) or "30 회분" placeholder
  //   - 개당 중량: title에서 추출 (없으면 분말 0, 액상 placeholder)
  //   - 개당 용량: title에서 추출 (없으면 분말 0, 액상 placeholder)
  const isLiquid = parsedAttrs.개당용량 != null && parsedAttrs.개당용량 > 0
  const hasSuryang = categoryAttrs.some((a) => a.attributeTypeName === '수량')
  const fallbackName = hasSuryang ? '수량' : '총 수량'

  return categoryAttrs.map((a) => {
    const name = a.attributeTypeName
    if (name === fallbackName || name === '수량' || name === '총 수량') {
      const unit = pickUnit(a.usableUnits, ['박스', '세트', '개', '팩'])
      return { attributeTypeName: name, attributeValueName: `1 ${unit}`, exposed: 'EXPOSED' }
    }
    if (name === '개당 캡슐/정' && a.required === 'MANDATORY') {
      const unit = pickUnit(a.usableUnits, ['회분', '정'])
      const v = parsedAttrs.개당캡슐정 || 30
      return { attributeTypeName: name, attributeValueName: `${v} ${unit}`, exposed: 'NONE' }
    }
    if (name === '개당 중량' && a.required === 'MANDATORY') {
      const unit = pickUnit(a.usableUnits, ['g', 'kg'])
      const v = parsedAttrs.개당중량 != null && parsedAttrs.개당중량 > 0
        ? parsedAttrs.개당중량
        : (isLiquid ? 1 : 0)
      return { attributeTypeName: name, attributeValueName: `${v} ${unit}`, exposed: 'NONE' }
    }
    if (name === '개당 용량' && a.required === 'MANDATORY') {
      const unit = pickUnit(a.usableUnits, ['ml', 'L'])
      const v = parsedAttrs.개당용량 != null && parsedAttrs.개당용량 > 0 ? parsedAttrs.개당용량 : 0
      return { attributeTypeName: name, attributeValueName: `${v} ${unit}`, exposed: 'NONE' }
    }
    return { attributeTypeName: name, attributeValueName: '', exposed: 'NONE' }
  })
}

function buildPayload(row, meta) {
  const dome = row.price_krw
  const msp = row.min_sell_price_krw ?? 0
  const market = row.raw_payload?.market_price
  const marketMed = market?.median
  // 가격 공식 (playbook 6번):
  //   실원가 = 도매가 + 고객출고배송 3000  // 위탁(dropship): 배송 1회분만 (2026-05-29 구 6000→3000)
  //   하한 마진선 = realCost / 0.65 (35% 마진 확보)
  //   경쟁가 = market median × 0.95 (시세 -5%)
  //   등록가 = max(MSP, 경쟁가, 하한선) → 10원 단위 floor
  //   🛑 MSP가 절대 하한 (낮으면 절대 안 됨)
  const realCost = dome + SOURCE_SHIP + OUTBOUND_SHIP
  const minByMargin = Math.ceil(realCost / 0.65 / 100) * 100
  const competitorTarget = marketMed ? Math.floor(marketMed * 0.95) : 0
  let listPrice = Math.max(msp, competitorTarget, minByMargin)
  listPrice = Math.ceil(listPrice / 100) * 100  // 100원 단위 올림 (사용자 정책)
  if (msp > 0 && listPrice < msp) throw new Error(`MSP 위반: ${listPrice} < ${msp}`)
  const fee = Math.round(listPrice * COUPANG_FEE_RATE)
  const vat = Math.round(listPrice / 11)
  const realMargin = listPrice - realCost - fee - vat
  const marginPct = parseFloat(((realMargin / listPrice) * 100).toFixed(2))

  const imageThumb = row.raw_payload?.image_thumb
  // 상세설명: editor 긴 상세(images_content) 우선, 없으면 /detail/ 제품사진(images_detail). prep이 editor를 놓쳐 짧은 사진만 등록되던 버그 방지.
  const imagesDetail = (row.raw_payload?.images_content?.length ? row.raw_payload.images_content : row.raw_payload?.images_detail) ?? []
  const imagesMain = row.raw_payload?.images_main ?? []
  const items_images = [
    { imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: imageThumb },
    ...imagesMain.slice(0, 4).map((u, i) => ({ imageOrder: i + 1, imageType: 'DETAIL', vendorPath: u })),
  ]
  const contents = imagesDetail.slice(0, 10).map((u) => ({
    contentsType: 'IMAGE_NO_SPACE',
    contentDetails: [{ content: u, detailType: 'IMAGE' }],
  }))

  const category = row.raw_payload?.coupang_predicted_category
  let displayCategoryCode = parseInt(category?.id)
  // 폴백: 73137(기타영양제)/58927(글루코사민) 외 카테고리는 등록 거절되는 패턴이 확인됨.
  // 안정 등록을 위해 식품 카테고리는 73137로 통일하고, 등록 후 Wing 또는 수정 API로 정확한 카테고리로 옮긴다.
  const STABLE_CATEGORY_CODES = new Set([73137, 58927])
  const categoryName_orig = category?.name
  if (!STABLE_CATEGORY_CODES.has(displayCategoryCode)) {
    displayCategoryCode = 73137
  }

  const parsed = parseAttrs(row.title)
  const noticeCategory = pickNoticeCategory(meta.noticeCategories)
  const notices = buildNotices(noticeCategory, row.title)
  const itemAttributes = buildItemAttributes(meta.attributes ?? [], parsed)

  // itemName: 카테고리 메타 호환 단위만 사용 — "60정 1박스" / "30포 1박스" / "1박스"
  // "개입"/"캡슐" 같은 비호환 단위는 모두 "정" 또는 "회분"으로 정규화
  let itemName = '1박스'
  if (parsed.개당캡슐정) {
    const capsuleAttr = (meta.attributes ?? []).find((a) => a.attributeTypeName === '개당 캡슐/정')
    const u = capsuleAttr ? pickUnit(capsuleAttr.usableUnits, ['정', '회분']) : '정'
    itemName = `${parsed.개당캡슐정}${u} 1박스`
  }

  // originalPrice ≥ salePrice 보장 (정가-판매가 역전 = 노출제한 원인)
  const originalPrice = Math.max(row.list_price_krw ?? 0, Math.ceil(listPrice * 1.2 / 100) * 100)
  const items = [{
    itemName,
    originalPrice,
    salePrice: listPrice,
    maximumBuyCount: 0,
    maximumBuyForPerson: 0,
    maximumBuyForPersonPeriod: 1,
    outboundShippingTimeDay: 2,
    unitCount: 1,
    adultOnly: 'EVERYONE',
    taxType: 'TAX',
    parallelImported: 'NOT_PARALLEL_IMPORTED',
    overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
    pccNeeded: false,
    externalVendorSku: row.goods_no,
    images: items_images,
    notices,
    attributes: itemAttributes,
    contents,
    offerCondition: 'NEW',
  }]

  const payload = {
    vendorId: VENDOR_ID,
    sellerProductName: row.title,
    displayProductName: row.title,
    displayCategoryCode,
    brand: row.brand ?? row.title.split(/\s+/)[0],
    generalProductName: row.title,
    productGroup: row.title.split(/\s+/).slice(0, 3).join(' '),
    manufacture: '상세설명 참조',
    saleStartedAt: new Date().toISOString().slice(0, 19),
    saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL',
    deliveryCompanyCode: 'CJGLS',
    deliveryChargeType: 'FREE',
    deliveryCharge: 0,
    freeShipOverAmount: 0,
    deliveryChargeOnReturn: 3000,
    remoteAreaDeliverable: 'N',
    unionDeliveryType: 'NOT_UNION_DELIVERY',
    returnCenterCode: RETURN_CENTER_CODE,
    returnChargeName: RETURN_CHARGE_NAME,
    companyContactNumber: COMPANY_CONTACT,
    returnZipCode: RETURN_ZIP_CODE,
    returnAddress: RETURN_ADDRESS,
    returnAddressDetail: RETURN_ADDRESS_DETAIL,
    returnCharge: RETURN_CHARGE,
    outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    vendorUserId: 'anteam7',
    requested: false,
    items,
    notices: [],
    requiredDocuments: [],
  }
  const isFallback = !STABLE_CATEGORY_CODES.has(parseInt(category?.id))
  return { payload, dome, msp, listPrice, fee, realMargin, marginPct, displayCategoryCode, categoryName: isFallback ? '기타영양제' : categoryName_orig, categoryNameOrig: categoryName_orig, categoryFallback: isFallback, itemName }
}

// ─── 실패 row 삭제 후 재시도 ───
if (retryFailed) {
  await sb.from('jimscanner_coupang_listings').delete().eq('status', 'FAILED')
  console.log('이전 FAILED row 삭제 완료\n')
}

// 등록 대상: OK verdict + listings에 없는 것
// 시세 데이터가 있든 없든 raw_payload.coupang_predicted_category 가 있는 모든 후보 처리
// (3차 배치는 시세 조사 생략 — MSP 기준으로 등록가 산출)
const { data: candidates } = await sb
  .from('jimscanner_ggsan_products')
  .select('*')
  .not('raw_payload->coupang_predicted_category', 'is', null)
const filtered = (candidates ?? []).filter((r) => {
  const v = r.raw_payload?.market_price?.verdict
  return v == null || ['OK', 'BORDERLINE', 'NOT_COMPETITIVE'].includes(v)
})

const { data: existing } = await sb
  .from('jimscanner_coupang_listings')
  .select('source_goods_no')
  .eq('source', 'ggsan')
const existingSet = new Set((existing ?? []).map((r) => r.source_goods_no))
const targets = filtered.filter((r) => !existingSet.has(r.goods_no))

console.log(`=== v2 일괄 등록 시작 ===`)
console.log(`대상: ${targets.length}건 (이미 등록 ${existingSet.size}건 제외)\n`)

const summary = { success: 0, fail: 0, errors: [] }

for (let i = 0; i < targets.length; i++) {
  const row = targets[i]
  const idx = `[${i + 1}/${targets.length}]`
  try {
    const category = row.raw_payload?.coupang_predicted_category
    const displayCategoryCode = parseInt(category?.id)
    if (!displayCategoryCode) { console.log(`${idx} ${row.goods_no} — 카테고리 없음`); continue }

    const meta = await getCategoryMeta(displayCategoryCode)
    // 사용자 정책: 건강식품만 등록. noticeCategories에 가공식품/건강기능식품이 없으면 사전 SKIP
    const noticeNames = (meta.noticeCategories ?? []).map((n) => n.noticeCategoryName)
    const isFood = noticeNames.includes('가공식품') || noticeNames.includes('건강기능식품')
    if (!isFood) {
      // 폴백된 73137으로도 안되면 진짜 비식품 → SKIPPED
      console.log(`${idx} ⏭ ${row.goods_no} ${row.title.slice(0,38).padEnd(38)} | 비식품 카테고리 (${noticeNames.join(',')}) — SKIPPED`)
      await sb.from('jimscanner_coupang_listings').insert({
        vendor_id: VENDOR_ID, source: 'ggsan', source_goods_no: row.goods_no,
        source_detail_url: row.detail_url, registered_title: row.title,
        display_category_code: displayCategoryCode, display_category_name: row.raw_payload?.coupang_predicted_category?.name,
        brand: row.brand, dome_price_krw: row.price_krw, msp_price_krw: row.min_sell_price_krw ?? 0,
        list_price_krw: row.min_sell_price_krw ?? 0,
        status: 'SKIPPED', displayable: false,
        rejection_reason: `비식품 카테고리 (${noticeNames.join(',')}) — 건강식품만 등록하는 사용자 정책`,
      })
      summary.fail++ // 통계상 처리됨
      continue
    }
    const built = buildPayload(row, meta)
    const r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    const success = r.status === 200 && r.body?.code === 'SUCCESS'
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null

    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: 'ggsan',
      source_goods_no: row.goods_no, source_detail_url: row.detail_url,
      registered_title: row.title, display_category_code: displayCategoryCode,
      display_category_name: built.categoryName + (built.categoryFallback ? ` (원본:${built.categoryNameOrig})` : ''), brand: built.payload.brand,
      dome_price_krw: built.dome, source_shipping_fee_krw: SOURCE_SHIP, outbound_shipping_fee_krw: OUTBOUND_SHIP,
      msp_price_krw: built.msp, list_price_krw: built.listPrice,
      estimated_fee_krw: built.fee, estimated_margin_krw: built.realMargin, estimated_margin_pct: built.marginPct,
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false,
      rejection_reason: success ? null : (r.body?.message ?? String(r.body).slice(0, 500)),
      request_payload: built.payload, last_response: r.body,
      registered_at: success ? new Date().toISOString() : null,
      last_synced_at: new Date().toISOString(),
    }
    await sb.from('jimscanner_coupang_listings').insert(listingRow)

    if (success) {
      summary.success++
      console.log(`${idx} ✓ ${row.goods_no} ${row.title.slice(0,40).padEnd(40)} | ${built.listPrice.toLocaleString().padStart(8)} (${built.marginPct}%) | sellerPID=${sellerProductId}`)
    } else {
      summary.fail++
      const reason = (r.body?.message ?? '').slice(0, 150)
      summary.errors.push({ goods_no: row.goods_no, title: row.title.slice(0, 40), cat: displayCategoryCode, reason })
      console.log(`${idx} ✗ ${row.goods_no} [${displayCategoryCode}] ${row.title.slice(0,38).padEnd(38)} | ${reason}`)
    }
  } catch (e) {
    summary.fail++
    summary.errors.push({ goods_no: row.goods_no, title: row.title.slice(0, 40), reason: e.message })
    console.log(`${idx} ✗ ${row.goods_no} ERROR: ${e.message}`)
  }
  await new Promise((r) => setTimeout(r, 500))
}

console.log('\n=== 완료 ===')
console.log(`성공: ${summary.success}건`)
console.log(`실패: ${summary.fail}건`)
if (summary.errors.length) {
  console.log('\n실패 사유:')
  summary.errors.forEach((e) => console.log(`  - ${e.goods_no} [${e.cat ?? '?'}] ${e.title}: ${e.reason}`))
}
