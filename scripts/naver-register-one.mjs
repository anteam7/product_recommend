/**
 * upickb2b 카탈로그 → 네이버 스마트스토어 등록 (단건/테스트).
 *   node --env-file=.env.local scripts/naver-register-one.mjs --no=<product_no> [--price=N] [--dry]
 * 기존 라이브 상품(_tmp_naver_sample_product.json) 구조를 템플릿으로 복제.
 * 이미지: upickb2b → 네이버 업로드(외부 URL 거부) → 네이버 URL 사용.
 * 고시: DIET_FOOD(건강기능식품), 전부 "상품상세참조". 출고지/반품지/원산지는 스토어 기존값.
 */
import { naverApi, naverUpload } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const NO = arg('no'); const PRICE_OVERRIDE = parseInt(arg('price') || '0') || 0; const DRY = process.argv.includes('--dry')
if (!NO) { console.error('--no=<product_no> 필수'); process.exit(1) }

// 출고지/반품지/번들그룹 (스토어 기존값)
const SHIP_ADDR = 106028428, RETURN_ADDR = 200357454, BUNDLE_GROUP = 54006647, CONTACT = '010-4164-3802'

// 카테고리 매핑 (식품>건강식품 leaf). 기본 = 기타건강보조식품.
const CAT_RULES = [
  [/홍삼|홍삼정|6년근|흑삼|산삼|장뇌삼/, '50001902'],     // 인삼
  [/인삼차|수삼|백삼/, '50001902'],
  [/비타민\s*c|비타민c/i, '50002428'], [/비타민\s*d|비타민d/i, '50007042'],
  [/멀티\s*비타민|종합비타민|멀티비타민/, '50002425'],
  [/오메가\s*3|오메가3|알티지|epa|dha/i, '50002447'],
  [/루테인|지아잔틴/, '50002608'],
  [/유산균|프로바이오|락토|바이오틱스|포스트바이오/, '50007030'],
  [/글루코사민|관절|콘드로이친|보스웰리아|msm/i, '50002446'],
  [/엽산/, '50002440'], [/아연/, '50002441'], [/철분|헤모|훼럼/, '50002442'],
  [/칼슘/, '50002443'], [/마그네슘/, '50002444'], [/프로폴리스/, '50002445'],
  [/쏘팔메토/, '50002610'], [/코큐텐|코엔자임|큐텐/, '50002617'],
  [/스피루리나/, '50002620'], [/클로렐라/, '50002621'], [/키토산/, '50002612'],
  [/감마리놀렌|달맞이|보라지/, '50002448'],
  [/홍삼.*정|진액|흑염소|장어|마가목|도라지|배도라지|즙|환$|환\s|개소주/, '50001899'], // 건강환/정
  [/꿀|프로폴리스|벌꿀|로얄제리/, '50001905'],
]
const DEFAULT_CAT = '50002615' // 식품>건강식품>영양제>기타건강보조식품
const mapCategory = (t) => { for (const [re, id] of CAT_RULES) if (re.test(t || '')) return id; return DEFAULT_CAT }

// 상품명 SEO: 허용문자만, 100자, 공백정리. (셀러명·중복·수식어 정리는 추후 고도화)
function seoName(title) {
  return (title || '').replace(/\s*-\s*(쿠팡|오픈마켓|토스몰)[^()]*$/g, '').replace(/[^0-9A-Za-z가-힣()\-·\[\]/&+,~.\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

async function uploadOne(url) {
  try {
    const res = await fetch(url); if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer()); if (buf.length < 1000) return null
    const ct = res.headers.get('content-type') || 'image/jpeg'
    const ext = /png/.test(ct) ? 'png' : /gif/.test(ct) ? 'gif' : 'jpg'
    const fd = new FormData(); fd.append('imageFiles', new Blob([buf], { type: ct }), `img.${ext}`)
    const up = await naverUpload('/v1/product-images/upload', fd)
    return up.status === 200 ? (up.body?.images?.[0]?.url ?? null) : null
  } catch { return null }
}

const { data } = await sb.from('jimscanner_upickb2b_products').select('*').eq('product_no', String(NO)).limit(1)
const row = data?.[0]
if (!row) { console.error(`product_no=${NO} 카탈로그에 없음 (재수집 중일 수 있음)`); process.exit(1) }
if (!row.coupang_allowed) console.warn(`⚠️ ${NO} 쿠팡금지/폐쇄몰 표시 상품 (${row.sellable_platforms})`)

const leafCategoryId = mapCategory(row.title)
const price = PRICE_OVERRIDE || row.min_sell_price_krw || Math.ceil((row.member_price_krw || 0) * 1.8 / 100) * 100
const brand = (row.title || '').split(/\s+/)[0]

console.log(`[1] 이미지 업로드 (대표 + 상세 ${Math.min((row.images || []).length, 5)})`)
const repUrl = await uploadOne(row.image_thumb)
const detailUrls = []
for (const u of (row.images || []).slice(0, 5)) { const r = await uploadOne(u); if (r) detailUrls.push(r) }
const finalRep = repUrl || detailUrls[0]
if (!finalRep) { console.error('대표 이미지 업로드 실패 — 등록 불가'); process.exit(1) }
const detailHtml = `<div>${(detailUrls.length ? detailUrls : [finalRep]).map((u) => `<p><img src="${u}" alt="상품 상세이미지"></p>`).join('\n')}</div>`
console.log(`    대표=${finalRep ? 'O' : 'X'} 상세=${detailUrls.length}`)

const dietFood = { returnCostReason: '0', noRefundReason: '0', qualityAssuranceStandard: '0', compensationProcedure: '0', troubleShootingContents: '0', productName: '상품상세참조', producer: '상품상세참조', location: '상품상세참조', expirationDateText: '상품상세참조', consumptionDateText: '상품상세참조', storageMethod: '상품상세참조', weight: '상품상세참조', amount: '상품상세참조', ingredients: '상품상세참조', nutritionFacts: '상품상세참조', specification: '상품상세참조', cautionAndSideEffect: '상품상세참조', nonMedicinalUsesMessage: '상품상세참조', geneticallyModified: false, importDeclarationCheck: false, consumerSafetyCaution: '상품상세참조', customerServicePhoneNumber: '상품상세참조' }

const payload = {
  originProduct: {
    statusType: 'SALE', saleType: 'NEW', leafCategoryId, name: seoName(row.title), detailContent: detailHtml,
    images: { representativeImage: { url: finalRep }, optionalImages: detailUrls.slice(0, 9).map((u) => ({ url: u })) },
    salePrice: price, stockQuantity: 5,
    deliveryInfo: {
      deliveryType: 'DELIVERY', deliveryAttributeType: 'NORMAL', deliveryCompany: 'CJGLS',
      deliveryBundleGroupUsable: true, deliveryBundleGroupId: BUNDLE_GROUP,
      deliveryFee: { deliveryFeeType: 'FREE', baseFee: 0 },
      claimDeliveryInfo: { returnDeliveryCompanyPriorityType: 'PRIMARY', returnDeliveryFee: 3000, exchangeDeliveryFee: 6000, shippingAddressId: SHIP_ADDR, returnAddressId: RETURN_ADDR, freeReturnInsuranceYn: false },
      installationFee: false,
    },
    detailAttribute: {
      naverShoppingSearchInfo: { manufacturerName: brand, brandName: brand, catalogMatchingYn: false },
      afterServiceInfo: { afterServiceTelephoneNumber: CONTACT, afterServiceGuideContent: '네이버 톡톡이나 문의 글 남겨주시면 빠르게 처리 도와드리겠습니다.' },
      originAreaInfo: { originAreaCode: '03', content: '상세설명에 표시', plural: false },
      optionInfo: { simpleOptionSortType: 'CREATE', optionSimple: [], optionCustom: [], optionCombinationSortType: 'CREATE', standardOptionGroups: [], optionStandards: [], useStockManagement: true, optionDeliveryAttributes: [] },
      purchaseReviewInfo: { purchaseReviewExposure: true },
      taxType: 'TAX', certificationTargetExcludeContent: {}, sellerCommentUsable: false, minorPurchasable: true,
      productInfoProvidedNotice: { productInfoProvidedNoticeType: 'DIET_FOOD', dietFood },
      itselfProductionProductYn: false,
    },
  },
  smartstoreChannelProduct: { storeKeepExclusiveProduct: false, naverShoppingRegistration: true, channelProductDisplayStatusType: 'ON' },
}

console.log(`[2] 등록 ${NO} | ${seoName(row.title).slice(0, 40)} | cat ${leafCategoryId} | ${price.toLocaleString()}원`)
writeFileSync(path.join(__dirname, '..', `_tmp_naver_register_${NO}.json`), JSON.stringify({ payload }, null, 2), 'utf8')
if (DRY) { console.log('[DRY] payload 저장됨 — POST 안 함'); process.exit(0) }
const res = await naverApi('POST', '/v2/products', payload)
console.log(`    HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 600)}`)
writeFileSync(path.join(__dirname, '..', `_tmp_naver_register_${NO}.json`), JSON.stringify({ payload, response: res.body }, null, 2), 'utf8')
