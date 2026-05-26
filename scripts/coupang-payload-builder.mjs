/**
 * 쿠팡 상품 생성 페이로드 빌더 (DRY-RUN, 실제 POST 안 함)
 *
 * 1건의 ggsan 상품 → 쿠팡 sellerProductCreate 페이로드 JSON 생성
 * - 노출 OFF로 등록 (사용자 명시: 검토 후 수동 ON)
 * - 카테고리 메타에서 MANDATORY attribute는 상품명에서 파싱
 * - 고시정보(notices)는 사용자 정책: "상세설명 참조" + 기본 표준 문구
 * - contents는 ggsan 디테일 이미지 URL을 그대로 사용
 *
 * 사용: node scripts/coupang-payload-builder.mjs <goods_no>
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
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

// 기존 승인 상품에서 추출한 운영 상수
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717
const RETURN_CENTER_CODE = '1002609354'
const RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8'
const RETURN_ADDRESS_DETAIL = '301'
const RETURN_ZIP_CODE = '08703'
const COMPANY_CONTACT = '010-4164-3802'

const goodsNo = process.argv[2] || '1000004724'

// ─── 후킹어구 옵션 ───
// --hook "역대급"     → 명시 어구로 등록 제목 prefix
// --hook auto         → jimscanner_hook_phrases 에서 카테고리 매칭 후 support 최상위 1건 자동 선택
// 없으면 후킹어구 미사용 (기존 동작)
const argv = process.argv.slice(3)
function getFlag(name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}
const hookFlag = getFlag('--hook')

async function pickHookPhrase(categoryHint) {
  if (!hookFlag) return null
  if (hookFlag !== 'auto') return hookFlag
  const cats = [categoryHint, 'all'].filter(Boolean)
  const { data } = await sb
    .from('jimscanner_hook_phrases')
    .select('phrase, support, category')
    .in('category', cats)
    .order('support', { ascending: false })
    .limit(1)
  return data?.[0]?.phrase ?? null
}

const { data: rows } = await sb
  .from('jimscanner_ggsan_products')
  .select('*')
  .eq('goods_no', goodsNo)
  .limit(1)
const row = rows?.[0]
if (!row) {
  console.error(`goods_no=${goodsNo} 없음`)
  process.exit(1)
}

// ─── 1. 상품명에서 attribute 추출 ───
// "x 30병" / "x 60정" / "x 90캡슐" 패턴 = 입수량 (개별 단위 개수)
// 박스 1개 SKU로 등록한다고 가정:
//   수량 = 1 박스
//   개당 캡슐/정 = 입수량 (단위: 정 또는 회분)
//   개당 용량/중량 = 개별 1개의 용량/중량
function parseAttrs(title) {
  const out = {}
  const t = title.replace(/[,()]/g, ' ').replace(/\s+/g, ' ')

  // 개별 단위 중량 (mg/g/kg) — 첫 번째 match
  const mw = t.match(/(\d+(?:\.\d+)?)\s*(mg|g|kg)\b/i)
  if (mw) {
    let v = parseFloat(mw[1]); let unit = mw[2].toLowerCase()
    if (unit === 'kg') { v = v * 1000; unit = 'g' }
    else if (unit === 'mg') { v = v / 1000; unit = 'g' }
    out.개당중량 = { value: v, unit: 'g', _orig: mw[0] }
  }

  // 개별 단위 용량 (ml/L)
  const mv = t.match(/(\d+(?:\.\d+)?)\s*(ml|L)\b/i)
  if (mv) {
    let v = parseFloat(mv[1]); let unit = mv[2].toLowerCase()
    if (unit === 'l') { v = v * 1000 }
    out.개당용량 = { value: v, unit: 'ml', _orig: mv[0] }
  }

  // 액상인데 중량 안 잡혔으면 ml → g 환산 (1ml≈1g placeholder)
  if (out.개당용량 && !out.개당중량) {
    out.개당중량 = { value: out.개당용량.value, unit: 'g', _approx: true }
  }
  // 분말/캡슐인데 용량 안 잡혔으면 0으로
  if (out.개당중량 && !out.개당용량) {
    out.개당용량 = { value: 0, unit: 'ml' }
  }
  if (!out.개당중량 && !out.개당용량) {
    out.개당중량 = { value: 0, unit: 'g' }
    out.개당용량 = { value: 0, unit: 'ml' }
  }

  // 입수량 패턴: "x 30병" / "x 60정" / "x 90캡슐" / "* 60포"
  // 가장 마지막 "x숫자단위" 우선 (예: 500mg x 60정 → 60정이 입수량)
  const bundleMatches = [...t.matchAll(/[x×*]\s*(\d+)\s*(병|정|캡슐|포|개입|회분)/g)]
  let bundle = null
  if (bundleMatches.length > 0) {
    const last = bundleMatches[bundleMatches.length - 1]
    bundle = { value: parseInt(last[1]), unit: last[2] }
  } else {
    // "60정" / "30포" 같이 prefix x 없는 경우
    const m = t.match(/\b(\d+)\s*(정|캡슐|포|병|개입|회분)\b/)
    if (m) bundle = { value: parseInt(m[1]), unit: m[2] }
  }

  // 개당 캡슐/정 = 입수량 (단위 "정" 또는 "회분")
  if (bundle) {
    // "병"/"포"는 회분으로, "정"/"캡슐"은 정으로
    const u = ['병', '포', '개입', '회분'].includes(bundle.unit) ? '회분' : '정'
    out.개당캡슐정 = { value: bundle.value, unit: u, _orig: `${bundle.value}${bundle.unit}` }
  } else {
    out.개당캡슐정 = { value: 1, unit: '정' }
  }

  // 수량: 박스 단위 SKU = 항상 1박스
  out.수량 = { value: 1, unit: '박스' }
  // 번들사이즈 = 입수량 (옵션 attribute로 등록)
  if (bundle) out.번들사이즈 = { value: bundle.value, unit: bundle.unit }

  return out
}

const attrs = parseAttrs(row.title)

// ─── 2. 등록가 결정 ───
const dome = row.price_krw
const msp = row.min_sell_price_krw ?? 0
const market = row.raw_payload?.market_price
const marketMed = market?.median
// 등록가 = max(MSP, 시세 median). 시세 데이터 없으면 MSP * 1.0
const listPrice = Math.max(msp, marketMed ?? msp)

// 추정 비용
const SOURCE_SHIP = 3000
const OUTBOUND_SHIP = 3000
const COUPANG_FEE_RATE = 0.1
const fee = Math.round(listPrice * COUPANG_FEE_RATE)
const realMargin = listPrice - dome - SOURCE_SHIP - OUTBOUND_SHIP - fee
const marginPct = parseFloat(((realMargin / listPrice) * 100).toFixed(2))

// ─── 3. 이미지 ───
const imageThumb = row.raw_payload?.image_thumb
const imagesDetail = (row.raw_payload?.images_detail ?? [])
const imagesMain = (row.raw_payload?.images_main ?? [])
// items[0].images: REPRESENTATION + DETAIL
const items_images = [
  { imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: imageThumb },
  ...imagesMain.slice(0, 4).map((u, i) => ({ imageOrder: i + 1, imageType: 'DETAIL', vendorPath: u })),
]

// items[0].contents: 상세설명 = ggsan 디테일 이미지들
const contents = imagesDetail.slice(0, 10).map((u) => ({
  contentsType: 'IMAGE_NO_SPACE',
  contentDetails: [{ content: u, detailType: 'IMAGE' }],
}))

// ─── 4. 카테고리 ───
const category = row.raw_payload?.coupang_predicted_category
const displayCategoryCode = parseInt(category?.id)

// ─── 4-b. 후킹어구 슬롯 주입 (옵션) ───
// 카테고리 힌트는 ggsan category_top → trend-radar 의 'health|living|digital' 매핑.
// raw_payload.category_top 이 있으면 사용, 없으면 title 휴리스틱.
function inferCatHint(t) {
  const s = (t || '').toLowerCase()
  if (/(영양제|비타민|콜라겐|프로바이오틱스|오메가|루테인|멜라토닌|효소|건강)/i.test(s)) return 'health'
  if (/(주방|수건|침구|화장지|식기|청소|세제|생활|리빙)/i.test(s)) return 'living'
  if (/(노트북|tv|모니터|냉장고|에어컨|폰|스마트워치|이어폰|마우스|키보드|ssd|gpu|cpu)/i.test(s)) return 'digital'
  return null
}
const catHint = row.raw_payload?.category_top ?? inferCatHint(row.title)
const hookPhrase = await pickHookPhrase(catHint)
const decoratedTitle = hookPhrase ? `[${hookPhrase}] ${row.title}` : row.title

// ─── 5. notices (가공식품 11개 필수 — "상세설명 참조" 표준 채움) ───
const notices = [
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '제품명', content: row.title },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '식품의 유형', content: '상세설명 참조' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '생산자 및 소재지', content: '상세설명 참조' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '제조연월일, 소비기한 또는 품질유지기한', content: '상세설명 또는 제품 별도 표기 참조' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '포장단위별 내용물의 용량(중량), 수량', content: row.title },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '원재료명 및 함량', content: '상세설명 참조' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '영양성분', content: '상세설명 참조' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '유전자변형식품에 해당하는 경우의 표시', content: '해당없음' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '소비자안전을 위한 주의사항', content: '직사광선을 피하고 서늘한 곳에 보관하시기 바랍니다. 알레르기 체질 등 특이체질인 경우 원재료를 확인하신 후 섭취하시기 바랍니다.' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '수입식품 문구', content: row.title.includes('직수입') || row.title.includes('수입') ? '수입식품에 해당하며 한글표시사항을 별도 부착함' : '해당없음' },
  { noticeCategoryName: '가공식품', noticeCategoryDetailName: '소비자상담관련 전화번호', content: COMPANY_CONTACT },
]

// ─── 6. attributes (카테고리 MANDATORY 4개 + 번들사이즈 OPTIONAL) ───
const itemAttributes = [
  { attributeTypeName: '개당 캡슐/정', attributeValueName: `${attrs.개당캡슐정.value} ${attrs.개당캡슐정.unit}`, exposed: 'EXPOSED' },
  { attributeTypeName: '개당 중량', attributeValueName: `${attrs.개당중량.value} g`, exposed: 'EXPOSED' },
  { attributeTypeName: '개당 용량', attributeValueName: `${attrs.개당용량.value} ml`, exposed: 'EXPOSED' },
  { attributeTypeName: '수량', attributeValueName: `${attrs.수량.value} ${attrs.수량.unit}`, exposed: 'EXPOSED' },
]
if (attrs.번들사이즈) {
  itemAttributes.push({ attributeTypeName: '번들사이즈', attributeValueName: `${attrs.번들사이즈.value} ${attrs.번들사이즈.unit}`, exposed: 'EXPOSED' })
}

// ─── 7. items 구성 (단일 옵션, 박스 단위 SKU) ───
// itemName: "25ml x 30병 1박스" 형태
const bundleStr = attrs.번들사이즈 ? `${attrs.번들사이즈.value}${attrs.번들사이즈.unit}` : ''
const sizeStr = attrs.개당용량?.value > 0 ? `${attrs.개당용량.value}ml` : (attrs.개당중량?.value > 0 ? `${attrs.개당중량.value}g` : '')
const itemName = [sizeStr && bundleStr ? `${sizeStr} x ${bundleStr}` : (sizeStr || bundleStr), `${attrs.수량.value}${attrs.수량.unit}`].filter(Boolean).join(' ')
const items = [
  {
    itemName,
    originalPrice: row.list_price_krw ?? listPrice,    // 정가
    salePrice: listPrice,                               // 판매가
    maximumBuyCount: 0,                                 // 무제한
    maximumBuyForPerson: 0,
    outboundShippingTimeDay: 2,
    unitCount: attrs.수량?.value ?? 1,
    adultOnly: 'EVERYONE',
    taxType: 'TAX',                                     // 과세
    parallelImported: 'NOT_PARALLEL_IMPORTED',
    overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
    pccNeeded: false,
    externalVendorSku: row.goods_no,                    // 매입처 식별자 보존
    images: items_images,
    notices,
    attributes: itemAttributes,
    contents,
    offerCondition: 'NEW',
  },
]

// ─── 8. 최상위 페이로드 ───
const today = new Date()
const saleStart = today.toISOString().slice(0, 19)
const saleEnd = '2099-12-31T00:00:00'

const payload = {
  // 노출 OFF 등록 정책 — Coupang은 displayable 직접 지정 불가, 등록 후 별도 selling API로 OFF 처리
  // 등록 자체는 sellerProductName/displayProductName 모두 동일하게
  vendorId: VENDOR_ID,
  sellerProductName: decoratedTitle,
  displayProductName: decoratedTitle,
  displayCategoryCode,
  brand: row.brand ?? row.title.split(/\s+/)[0],
  generalProductName: row.title,
  productGroup: row.title.split(/\s+/).slice(0, 3).join(' '),
  manufacture: '상세설명 참조',
  saleStartedAt: saleStart,
  saleEndedAt: saleEnd,
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
  requested: false, // ⭐ 핵심: false = 임시저장 (승인 요청 안 함, 노출 OFF). true 면 즉시 승인 요청
  items,
  notices: [],
  requiredDocuments: [],
}

// 검증·요약
console.log('=== 페이로드 DRY-RUN ===\n')
console.log(`상품         : ${row.title}`)
console.log(`매입처       : ggsan goods_no=${row.goods_no}`)
console.log(`도매가       : ${dome.toLocaleString()}원`)
console.log(`MSP          : ${msp.toLocaleString()}원`)
console.log(`시세 중앙값  : ${marketMed?.toLocaleString() ?? '—'}원`)
console.log(`등록가 (판매가) : ${listPrice.toLocaleString()}원`)
console.log(`정가         : ${(row.list_price_krw ?? listPrice).toLocaleString()}원`)
console.log(`추정 쿠팡 수수료 : ${fee.toLocaleString()}원`)
console.log(`실 마진      : ${realMargin.toLocaleString()}원 (${marginPct}%)`)
console.log(`\n쿠팡 카테고리: ${displayCategoryCode} (${category?.name})`)
console.log(`브랜드       : ${payload.brand}`)
console.log(`상품명에서 파싱한 attribute:`)
for (const k of Object.keys(attrs)) {
  console.log(`  ${k.padEnd(10)} : ${JSON.stringify(attrs[k])}`)
}
console.log(`\n이미지: REPRESENTATION 1장 + DETAIL ${items_images.length - 1}장 + 상세설명 ${contents.length}장`)
console.log(`고시정보(notices): ${notices.length}개 (가공식품)`)
console.log(`requested: ${payload.requested}  ← false = 임시저장 (노출 OFF, 검토 후 사용자가 수동 승인요청)`)
if (hookPhrase) console.log(`후킹어구 prefix : "${hookPhrase}"  (cat=${catHint ?? 'all'})`)

// 파일 저장
const outPath = path.join(__dirname, '..', `_tmp_coupang_payload_${row.goods_no}.json`)
writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8')
console.log(`\nsaved: ${outPath}`)
