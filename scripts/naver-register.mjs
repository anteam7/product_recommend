/**
 * upickb2b(쿠팡 등록분) → 네이버 스마트스토어 등록. 단건/배치.
 *   단건: node --env-file=.env.local scripts/naver-register.mjs --no=<product_no> [--status=SALE|SUSPENSION] [--dry]
 *   배치: node --env-file=.env.local scripts/naver-register.mjs [--status=SUSPENSION] [--limit=N]
 * 대상(배치): jimscanner_coupang_listings(source=upickb2b) 중 네이버 미등록. 가격은 쿠팡 list_price 동일.
 * 기본 status=SUSPENSION(비노출) — 검토 후 노출. SEO 셀러태그 자동 생성. jimscanner_naver_listings 추적.
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
const NO = arg('no'); const STATUS = arg('status', NO ? 'SALE' : 'SUSPENSION'); const LIMIT = parseInt(arg('limit') || '0') || 0; const DRY = process.argv.includes('--dry'); const CLEAR = process.argv.includes('--clear')

const SHIP_ADDR = 106028428, RETURN_ADDR = 200357454, BUNDLE_GROUP = 54006647, CONTACT = '010-4164-3802'
const CAT_RULES = [
  [/홍삼|홍삼정|6년근|흑삼|산삼|장뇌삼|인삼차|수삼|백삼/, '50001902'],
  [/비타민\s*c|비타민c/i, '50002428'], [/비타민\s*d|비타민d/i, '50007042'], [/멀티\s*비타민|종합비타민|멀티비타민/, '50002425'],
  [/오메가\s*3|오메가3|알티지|epa|dha/i, '50002447'], [/루테인|지아잔틴/, '50002608'],
  [/유산균|프로바이오|락토|바이오틱스|포스트바이오/, '50007030'], [/글루코사민|관절|콘드로이친|보스웰리아|msm/i, '50002446'],
  [/엽산/, '50002440'], [/아연/, '50002441'], [/철분|헤모|훼럼/, '50002442'], [/칼슘/, '50002443'], [/마그네슘/, '50002444'],
  [/프로폴리스/, '50002445'], [/쏘팔메토/, '50002610'], [/코큐텐|코엔자임|큐텐/, '50002617'], [/스피루리나/, '50002620'], [/클로렐라/, '50002621'], [/키토산/, '50002612'], [/감마리놀렌|달맞이|보라지/, '50002448'],
  [/진액|흑염소|장어|마가목|도라지|배도라지|개소주|즙|환$|환\s/, '50001899'], [/꿀|벌꿀|로얄제리/, '50001905'],
]
const DEFAULT_CAT = '50002615'
const mapCategory = (t) => { for (const [re, id] of CAT_RULES) if (re.test(t || '')) return id; return DEFAULT_CAT }
function seoName(title) { return (title || '').replace(/\s*-\s*(쿠팡|오픈마켓|토스몰)[^()]*$/g, '').replace(/[^0-9A-Za-z가-힣()\-·\[\]/&+,~.\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) }
function seoTags(title) {
  const stop = /^(\d|x$|mg|kg|ml|정|캡슐|포|개입|박스|병|슈퍼|프리미엄|골드|플러스|함유|x\d)/i
  const tags = new Set((title || '').replace(/[^0-9A-Za-z가-힣\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2 && !stop.test(t)).slice(0, 3))
  for (const [re, base] of [[/밀크씨슬|실리마린/, '밀크씨슬'], [/홍삼|인삼/, '홍삼'], [/비타민\s*c/i, '비타민C'], [/비타민\s*d/i, '비타민D'], [/오메가\s*3/i, '오메가3'], [/유산균|프로바이오/, '유산균'], [/루테인/, '루테인'], [/콜라겐/, '콜라겐'], [/엽산/, '엽산'], [/효소/, '효소'], [/글루코사민|관절/, '관절'], [/흑염소|장어|즙|진액/, '건강즙']]) {
    if (re.test(title)) { tags.add(base + '영양제'); tags.add(base + '추천') }
  }
  return [...tags].filter(Boolean).slice(0, 10).map((t) => ({ text: t.slice(0, 25) }))
}
async function uploadOne(url) {
  try { const r = await fetch(url); if (!r.ok) return null; const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 1000) return null
    const ct = r.headers.get('content-type') || 'image/jpeg'; const ext = /png/.test(ct) ? 'png' : /gif/.test(ct) ? 'gif' : 'jpg'
    const fd = new FormData(); fd.append('imageFiles', new Blob([buf], { type: ct }), `img.${ext}`)
    const up = await naverUpload('/v1/product-images/upload', fd); return up.status === 200 ? (up.body?.images?.[0]?.url ?? null) : null
  } catch { return null }
}
const dietFood = { returnCostReason: '0', noRefundReason: '0', qualityAssuranceStandard: '0', compensationProcedure: '0', troubleShootingContents: '0', productName: '상품상세참조', producer: '상품상세참조', location: '상품상세참조', expirationDateText: '상품상세참조', consumptionDateText: '상품상세참조', storageMethod: '상품상세참조', weight: '상품상세참조', amount: '상품상세참조', ingredients: '상품상세참조', nutritionFacts: '상품상세참조', specification: '상품상세참조', cautionAndSideEffect: '상품상세참조', nonMedicinalUsesMessage: '상품상세참조', geneticallyModified: false, importDeclarationCheck: false, consumerSafetyCaution: '상품상세참조', customerServicePhoneNumber: '상품상세참조' }

let BRAND_URL = null
async function uploadLocal(fp) { try { const buf = readFileSync(fp); const fd = new FormData(); fd.append('imageFiles', new Blob([buf], { type: 'image/jpeg' }), 'brand.jpg'); const up = await naverUpload('/v1/product-images/upload', fd); return up.status === 200 ? (up.body?.images?.[0]?.url ?? null) : null } catch { return null } }

async function processOne(row, price) {
  const repUrl = await uploadOne(row.image_thumb)
  const detailUrls = []
  for (const u of (row.images || []).slice(0, 5)) { const r = await uploadOne(u); if (r) detailUrls.push(r) }
  const finalRep = repUrl || detailUrls[0]
  if (!finalRep) return { ok: false, reason: '이미지 업로드 실패' }
  const LICENSE = '건강기능식품 영업신고번호 : 제2023-0107018호 · 판매업소 : 더모어커머스 · 본 제품은 식품의약품안전처가 인정한 건강기능식품/식품입니다. 질병의 예방·치료를 위한 의약품이 아닙니다.'
  const brandTop = BRAND_URL ? `<p><img src="${BRAND_URL}" alt="몸에조은가게 브랜드 소개"></p>\n` : ''
  const detailHtml = `<div>${brandTop}${(detailUrls.length ? detailUrls : [finalRep]).map((u) => `<p><img src="${u}" alt="상품 상세이미지"></p>`).join('\n')}<p style="margin-top:16px;padding:10px;font-size:12px;color:#888;line-height:1.6;border-top:1px solid #eee">${LICENSE}</p></div>`
  const brand = (row.title || '').split(/\s+/)[0]
  const payload = {
    originProduct: {
      statusType: STATUS === 'SUSPENSION' ? 'SALE' : STATUS, saleType: 'NEW', leafCategoryId: mapCategory(row.title), name: seoName(row.title), detailContent: detailHtml,
      images: { representativeImage: { url: finalRep }, optionalImages: detailUrls.slice(0, 9).map((u) => ({ url: u })) },
      salePrice: price, stockQuantity: 5,
      deliveryInfo: { deliveryType: 'DELIVERY', deliveryAttributeType: 'NORMAL', deliveryCompany: 'CJGLS', deliveryBundleGroupUsable: true, deliveryBundleGroupId: BUNDLE_GROUP, deliveryFee: { deliveryFeeType: 'FREE', baseFee: 0 }, claimDeliveryInfo: { returnDeliveryCompanyPriorityType: 'PRIMARY', returnDeliveryFee: 3000, exchangeDeliveryFee: 6000, shippingAddressId: SHIP_ADDR, returnAddressId: RETURN_ADDR, freeReturnInsuranceYn: false }, installationFee: false },
      detailAttribute: {
        naverShoppingSearchInfo: { manufacturerName: brand, brandName: brand, catalogMatchingYn: false },
        afterServiceInfo: { afterServiceTelephoneNumber: CONTACT, afterServiceGuideContent: '네이버 톡톡이나 문의 글 남겨주시면 빠르게 처리 도와드리겠습니다.' },
        originAreaInfo: { originAreaCode: '03', content: '상세설명에 표시', plural: false },
        optionInfo: { simpleOptionSortType: 'CREATE', optionSimple: [], optionCustom: [], optionCombinationSortType: 'CREATE', standardOptionGroups: [], optionStandards: [], useStockManagement: true, optionDeliveryAttributes: [] },
        purchaseReviewInfo: { purchaseReviewExposure: true }, taxType: 'TAX', certificationTargetExcludeContent: {}, sellerCommentUsable: false, minorPurchasable: true,
        productInfoProvidedNotice: { productInfoProvidedNoticeType: 'DIET_FOOD', dietFood }, itselfProductionProductYn: false,
      },
    },
    smartstoreChannelProduct: { storeKeepExclusiveProduct: false, naverShoppingRegistration: true, channelProductDisplayStatusType: STATUS === 'SUSPENSION' ? 'SUSPENSION' : 'ON' },
  }
  if (DRY) return { ok: true, dry: true, leaf: payload.originProduct.leafCategoryId, tags: payload.originProduct.detailAttribute.seoInfo.sellerTags.length }
  const res = await naverApi('POST', '/v2/products', payload)
  const ok = res.status === 200 && res.body?.originProductNo
  if (ok) await sb.from('jimscanner_naver_listings').upsert({ origin_product_no: res.body.originProductNo, channel_product_no: res.body.smartstoreChannelProductNo, source: 'upickb2b', source_goods_no: row.product_no, leaf_category_id: payload.originProduct.leafCategoryId, name: payload.originProduct.name, sale_price: price, status_type: STATUS, rep_image_url: finalRep, seller_tags: null, last_response: res.body, registered_at: new Date().toISOString() }, { onConflict: 'origin_product_no' })
  return { ok, originProductNo: res.body?.originProductNo, leaf: payload.originProduct.leafCategoryId, reason: ok ? null : JSON.stringify({ m: res.body?.message, inv: res.body?.invalidInputs }).slice(0, 600) }
}

// --clear: upickb2b 네이버 등록분 전체 삭제(재등록 전 정리)
if (CLEAR) {
  const { data: all } = await sb.from('jimscanner_naver_listings').select('origin_product_no').eq('source', 'upickb2b')
  console.log(`네이버 upickb2b 상품 ${all?.length || 0}건 삭제...`)
  let d = 0
  for (const p of (all || [])) { try { await naverApi('DELETE', `/v2/products/origin-products/${p.origin_product_no}`) } catch {} await sb.from('jimscanner_naver_listings').delete().eq('origin_product_no', p.origin_product_no); d++; if (d % 50 === 0) console.log(`  ${d}...`); await new Promise((s) => setTimeout(s, 250)) }
  console.log(`완료: ${d}건 삭제`); process.exit(0)
}

// 대상 선정
let rows = []
if (NO) {
  const { data } = await sb.from('jimscanner_upickb2b_products').select('*').eq('product_no', String(NO)).limit(1)
  rows = data || []
} else {
  const { data: cp } = await sb.from('jimscanner_coupang_listings').select('source_goods_no, list_price_krw').eq('source', 'upickb2b')
  const priceMap = new Map((cp || []).map((r) => [r.source_goods_no, r.list_price_krw]))
  const { data: already } = await sb.from('jimscanner_naver_listings').select('source_goods_no').eq('source', 'upickb2b')
  const done = new Set((already || []).map((r) => r.source_goods_no))
  const nos = [...new Set((cp || []).map((r) => r.source_goods_no))].filter((n) => !done.has(n))
  const { data: cat } = await sb.from('jimscanner_upickb2b_products').select('*').in('product_no', nos).eq('status', 'active')
  rows = (cat || []).map((r) => ({ ...r, _price: priceMap.get(r.product_no) }))
  if (LIMIT) rows = rows.slice(0, LIMIT)
}

console.log(`=== 네이버 ${NO ? '단건' : '배치'} 등록 ${DRY ? '[DRY]' : ''} | status=${STATUS} | 대상 ${rows.length}건 ===`)
if (!DRY && rows.length) { BRAND_URL = await uploadLocal(path.join(__dirname, '..', 'store-assets', 'brand-intro.jpg')); console.log(`brand-intro 업로드: ${BRAND_URL ? 'OK' : '실패(상세 상단 생략)'}\n`) }
let ok = 0, fail = 0
for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  const price = row._price || row.min_sell_price_krw || Math.ceil((row.member_price_krw || 0) * 1.8 / 100) * 100
  try {
    const r = await processOne(row, price)
    if (r.ok) { ok++; console.log(`[${i + 1}/${rows.length}] ✓ ${row.product_no} ${(row.title || '').slice(0, 30).padEnd(30)} | cat ${r.leaf} | ${price.toLocaleString()}원 ${r.dry ? `(tags ${r.tags})` : `| origin=${r.originProductNo}`}`) }
    else { fail++; console.log(`[${i + 1}/${rows.length}] ✗ ${row.product_no} ${(row.title || '').slice(0, 28)} | ${r.reason}`) }
  } catch (e) { fail++; console.log(`[${i + 1}/${rows.length}] ✗ ${row.product_no} ERROR ${e.message}`) }
  await new Promise((s) => setTimeout(s, 400))
}
console.log(`\n=== 완료: 성공 ${ok} / 실패 ${fail} ===`)
