/**
 * 웰루트B2B → 쿠팡 Open API 등록 (jimscanner_wellroot_products → jimscanner_coupang_listings, source='wellroot')
 *   node scripts/wellroot-register.mjs [--limit=N] [--only=751,602] [--dry] [--no-approval] [--min-margin=0.10] [--skip-hgsik]
 *
 * bio77-register.mjs(최신 검증 등록 공식)를 기준으로 하되, 웰루트 전용 차이:
 *   - 대상: coupang_eligible=true (재판매 가능 · 판매중 · 폐쇄몰 아님 · 등록제외 아님 · 유효 MSP 있음)
 *   - 카테고리: 웰루트는 쿠팡 카테고리코드를 주지 않음 → categorization/predict 로 예측 후 DB 캐시
 *     (73137/58927 구 폴백은 현재 isAllowSingleItem=false 라 쓰지 않는다 — bio77-register.mjs 주석 참고)
 *   - 가격: MSP는 "하한"이지 지정가가 아님 → listPrice = max(MSP, 목표순마진가). upickb2b-register.mjs computePrice 공식.
 *   - 원가: 공급가(VAT 포함) + 웰루트 배송비(1건, shipping_fee_krw). 웰루트가 고객에게 직배송하므로 배송비는 1회만 계산.
 *   - 속성값(attributes)은 bio77 공식 그대로 — "숫자+단위 공백 없음"(예 200g). 수치는 옵션표가 아니라 상품명에서 파싱.
 *   - 이미지: thumb_url/images_main(대표) + detail_images(상세). MSP 안내표 이미지는 수집기가 이미 제외했고 여기서 재확인.
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
const TABLE = 'jimscanner_wellroot_products'

// 반품지/출고지/수수료율 이중관리 지점 — docs/coupang-integration-guide.md §9-7 (bio77-register.mjs와 동일값)
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717
const RETURN_CENTER_CODE = '1002609354'
const RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8'
const RETURN_ADDRESS_DETAIL = '301'
const RETURN_ZIP_CODE = '08703'
const COMPANY_CONTACT = '010-4164-3802'
const DEFAULT_SOURCE_SHIP = 3000
const FEE_RATE = 0.106
const TARGET_NET = 0.10
const MAX_TITLE_LEN = 100

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const NO_APPROVAL = args.includes('--no-approval')
const SKIP_HGSIK = args.includes('--skip-hgsik')
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const LIMIT = +(argOf('limit') || 0) || 0
const ONLY = (argOf('only') || '').split(',').map(s => s.trim()).filter(Boolean)
const MIN_MARGIN = +(argOf('min-margin') ?? 0.10)
// 묶음(옵션조합) 등록 — 쿠팡 "필수 구매옵션 의무화"(2026-02~)로 isAllowSingleItem=false 인 카테고리는
// items[] 에 변형이 2개 이상 있어야 등록된다. 웰루트는 수량별 MSP·수량 구간 배송비가 있어 "수량" 축이 자연스럽다.
//   --bundle=1,2,3  변형 수량(기본 1,2,3) · --force-bundle  단일등록이 가능한 카테고리도 묶음으로
const BUNDLE_QTYS = (argOf('bundle') || '1,2,3').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
const FORCE_BUNDLE = args.includes('--force-bundle')

const metaCacheDir = path.join(__dirname, '..', '_tmp_meta_cache')
if (!existsSync(metaCacheDir)) mkdirSync(metaCacheDir, { recursive: true })
const sleep = ms => new Promise(s => setTimeout(s, ms))

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
async function getCategoryMeta(code) {
  const cachePath = path.join(metaCacheDir, `${code}_raw.json`)
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'))
  const r = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${code}`)
  if (r.status !== 200 || !r.body?.data) throw new Error(`meta fetch failed ${code}: HTTP ${r.status}`)
  writeFileSync(cachePath, JSON.stringify(r.body.data, null, 2), 'utf8')
  return r.body.data
}
async function downloadable(u) {
  try { const r = await fetch(u); return r.status === 200 && /image\//.test(r.headers.get('content-type') || '') } catch { return false }
}

function pickUnit(usableUnits, preferences) {
  if (!usableUnits || usableUnits.length === 0) return ''
  for (const p of preferences) if (usableUnits.includes(p)) return p
  return usableUnits[0]
}
function pickNoticeCategory(noticeCategories) {
  if (!noticeCategories || noticeCategories.length === 0) return null
  // "건강기능식품" 고시는 MFDS 인증 기능정보/영양정보를 요구해 placeholder로 거절될 수 있음(2026-09-01 실측)
  // → "가공식품" 고시가 더 관대해 우선 사용. bio77-register.mjs와 동일 순서.
  const preferred = ['가공식품', '건강기능식품']
  for (const p of preferred) { const f = noticeCategories.find(n => n.noticeCategoryName === p); if (f) return f }
  return noticeCategories[0]
}
function buildNotices(noticeCategory, title) {
  if (!noticeCategory) return []
  const name = noticeCategory.noticeCategoryName
  const isImport = /직수입|수입/.test(title)
  const valueFor = (dn) => {
    if (/제품명|품명|품목/.test(dn)) return title
    if (/포장단위|용량.*중량|중량.*용량/.test(dn)) return title
    if (/주의|안전/.test(dn)) return '직사광선을 피하고 서늘한 곳에 보관하시기 바랍니다. 알레르기 체질·특이체질은 원재료를 확인 후 섭취하시기 바랍니다. 본 제품은 질병의 예방·치료를 위한 의약품이 아닙니다.'
    if (/유전자변형|GMO/.test(dn)) return '해당없음'
    if (/수입.*문구|수입.*여부/.test(dn)) return isImport ? '수입식품에 해당하며 한글표시사항을 별도 부착함' : '해당없음'
    if (/상담.*전화|전화번호/.test(dn)) return COMPANY_CONTACT
    if (/원산지/.test(dn)) return isImport ? '수입산' : '국산'
    return '상세설명 참조'
  }
  const mandatory = (noticeCategory.noticeCategoryDetailNames ?? []).filter(d => d.required === 'MANDATORY')
  return mandatory.map(d => ({ noticeCategoryName: name, noticeCategoryDetailName: d.noticeCategoryDetailName, content: valueFor(d.noticeCategoryDetailName) }))
}

// 웰루트 options 는 [["300g","500g"],...] 형태의 셀렉트 라벨 배열이라 bio77 XLSM의 {type,value} 와 다르다.
// 단일상품 등록에 필요한 수치(개당 중량/용량/캡슐)는 상품명에서 파싱해 bio77 공식이 기대하는 형태로 넘긴다.
// 단위는 g/ml 로 정규화한다(메타 usableUnits가 g/ml을 선호하므로 1kg→1000g 로 바꿔야 "1g"으로 잘못 표기되지 않는다).
function optionsFromTitle(title) {
  const out = []
  const t = String(title || '').replace(/[,()]/g, ' ').replace(/\s+/g, ' ')
  const mw = t.match(/(\d+(?:\.\d+)?)\s*(mg|g|kg)\b/i)
  if (mw) {
    let v = parseFloat(mw[1]); const u = mw[2].toLowerCase()
    if (u === 'kg') v *= 1000; else if (u === 'mg') v /= 1000
    out.push({ type: '개당 중량', value: `${+v.toFixed(2)}g` })
  }
  const mv = t.match(/(\d+(?:\.\d+)?)\s*(ml|L)\b/i)
  if (mv) {
    let v = parseFloat(mv[1])
    if (mv[2].toLowerCase() === 'l') v *= 1000
    out.push({ type: '개당 용량', value: `${+v.toFixed(2)}ml` })
  }
  const bm = [...t.matchAll(/[xX×*]\s*(\d+)\s*(정|캡슐|포|병|개입|회분)/g)]
  // 한글 뒤에서는 \b 가 동작하지 않는다(\w 에 한글이 없어 "90정" 끝에 경계가 생기지 않음) → 후행 부정탐색으로 대체.
  // 이걸 놓치면 캡슐/정 수량 파싱이 실패해 기본값 30정이 그대로 등록된다(2026-09-17 #317 양배추정 90정 실측).
  const single = t.match(/(\d+)\s*(정|캡슐|포|병|개입|회분)(?![가-힣])/)
  const bundle = bm.length ? { v: +bm[bm.length - 1][1], u: bm[bm.length - 1][2] } : (single ? { v: +single[1], u: single[2] } : null)
  if (bundle) out.push({ type: '개당 캡슐/정', value: `${bundle.v}${bundle.u}` })
  return out
}
function parseOptionNum(options, typeRe) {
  const opt = (options ?? []).find(o => typeRe.test(String(o?.type || '')))
  if (!opt) return null
  const m = /([\d.]+)\s*([a-zA-Z가-힣]+)/.exec(String(opt.value || ''))
  return m ? { value: parseFloat(m[1]), unit: m[2] } : null
}
// ★ bio77-register.mjs:114-159 의 검증된 공식 그대로 (2026-09-01 확정, "숫자+단위 공백 없음")
//   - isAllowSingleItem=false 카테고리는 호출 전에 SKIP 처리한다
//   - "수량"(또는 "총 수량") + 그룹 대표 필수속성만 EXPOSED, 나머지는 NONE
function buildItemAttributes(categoryAttrs, options, qty = 1) {
  const hasSuryang = categoryAttrs.some(a => a.attributeTypeName === '수량')
  const fallbackName = hasSuryang ? '수량' : '총 수량'
  const capsule = parseOptionNum(options, /캡슐|정|개입/)
  const weight = parseOptionNum(options, /중량|무게/)
  const volume = parseOptionNum(options, /용량/)
  const isLiquid = volume != null

  const buildValue = (a) => {
    const name = a.attributeTypeName
    if (name === fallbackName) return `${qty}${pickUnit(a.usableUnits, ['개', '박스', '세트', '팩'])}`
    if (name === '개당 캡슐/정') return `${capsule?.value ?? 30}${pickUnit(a.usableUnits, ['정', '회분'])}`
    if (name === '개당 중량') return `${weight?.value ?? (isLiquid ? 1 : 0)}${pickUnit(a.usableUnits, ['g', 'kg'])}`
    if (name === '개당 용량') return `${volume?.value ?? 0}${pickUnit(a.usableUnits, ['ml', 'L'])}`
    return '상세설명 참조'
  }
  const groups = new Map()
  const rest = []
  for (const a of categoryAttrs) {
    const name = a.attributeTypeName
    if ((name === '수량' || name === '총 수량') && name !== fallbackName) continue
    if (a.groupNumber && a.groupNumber !== 'NONE') {
      const cur = groups.get(a.groupNumber)
      const matched = (n) => (n === '개당 캡슐/정' && capsule) || (n === '개당 중량' && weight) || (n === '개당 용량' && volume)
      if (!cur || (matched(name) && !matched(cur.attributeTypeName))) groups.set(a.groupNumber, a)
    } else {
      rest.push(a)
    }
  }
  const selected = [...groups.values(), ...rest]
  const out = selected.map(a => {
    const isMandatoryNumeric = a.required === 'MANDATORY' && ['개당 캡슐/정', '개당 중량', '개당 용량'].includes(a.attributeTypeName)
    const isExposedCandidate = a.attributeTypeName === fallbackName || isMandatoryNumeric
    const value = isExposedCandidate ? buildValue(a) : ''
    return { attributeTypeName: a.attributeTypeName, attributeValueName: value, exposed: isExposedCandidate ? 'EXPOSED' : 'NONE' }
  })
  const itemName = out.filter(a => a.exposed === 'EXPOSED').map(a => a.attributeValueName).join(' ') || `${qty}개`
  return { attributes: out, itemName }
}

/**
 * 가격 정책 — MSP는 "이 밑으로 팔지 말 것"이라는 하한이지 지정가가 아니다.
 *   listPrice = max(MSP, 목표순마진(MIN_MARGIN) 달성가)
 * 이렇게 하면 MSP가 원가보다 낮은 상품(웰루트 한천가루 등)도 적자 등록되지 않는다.
 * 원가 = 공급가(VAT 포함) + 웰루트 배송비 1건. 웰루트가 고객에게 직배송하므로 배송비는 1회만 계산한다.
 */
/** N개 묶음 매입 배송비 — 웰루트는 수량 구간제(대개 1~12개 한 박스 3,000원)라 묶음일수록 개당 배송비가 싸진다. */
function shipFor(row, n) {
  const tiers = Array.isArray(row.shipping_tiers) ? row.shipping_tiers : []
  const hit = tiers.find(t => n >= (t.min ?? 1) && n <= (t.max ?? 9999))
  return hit?.fee ?? row.shipping_fee_krw ?? DEFAULT_SOURCE_SHIP
}
/**
 * N개 묶음의 MSP 하한. 공급사 수량별 MSP(tiered_msp)가 있으면 그 값을 쓰고,
 * 없으면 1개 MSP × N 으로 잡는다 — 하한을 높게 잡는 건 위반이 아니라 안전한 쪽이다.
 */
function mspFloor(row, n) {
  const t = row.tiered_msp && typeof row.tiered_msp === 'object' ? row.tiered_msp : null
  const exact = t?.[String(n)]
  if (typeof exact === 'number' && exact > 0) return exact
  return (row.msp_price_krw ?? 0) * n
}
/**
 * 가격 정책 — MSP는 "이 밑으로 팔지 말 것"이라는 하한이지 지정가가 아니다.
 *   listPrice = max(MSP 하한, 목표순마진(MIN_MARGIN) 달성가)
 * 묶음(N개)에 특히 중요하다: 공급사 수량별 MSP는 볼륨 할인이라 그대로 팔면 마진율이 단품보다 낮아진다.
 * 원가 = N × 공급가(VAT 포함) + 배송비 1회(웰루트가 고객에게 직배송하므로 묶음이어도 배송은 1건).
 */
/**
 * 실제로 만들 변형 수량. 공급사가 수량별 MSP를 명시한 구간만 쓴다.
 * (예: tiered_msp={1:30000,2:50000} 인데 3개 변형을 만들면 하한이 3×30,000=90,000 으로 잡혀
 *  2개 50,000원보다 터무니없이 비싸진다 — 하한을 높게 잡는 건 안전하지만 팔리지 않는 가격이 된다.)
 * 수량별 MSP가 아예 없는 상품은 쿠팡 변형 요건(2개 이상)만 채우도록 1·2개로 만든다(2개 하한 = 2×1개 MSP).
 */
function variantQtys(row, requested) {
  const t = row.tiered_msp && typeof row.tiered_msp === 'object' ? row.tiered_msp : null
  if (!t) return requested.slice(0, 2)
  const have = requested.filter(n => n === 1 || (typeof t[String(n)] === 'number' && t[String(n)] > 0))
  return have.length >= 2 ? have : requested.slice(0, 2)
}
function computePriceFor(row, n = 1) {
  const dome = (row.supply_price_krw || 0) * n
  const ship = shipFor(row, n)
  const msp = mspFloor(row, n)
  const realCost = dome + ship
  // 목표 순마진(m) 가격: sale = 0.9091*원가 / (0.8031 - m)   (수수료 10.6% + 순VAT, 매입 입력VAT 공제 반영)
  const priceForNet = (cost, m) => Math.ceil((0.9091 * cost / (0.8031 - m)) / 100) * 100
  const breakeven = priceForNet(realCost, 0)
  const listPrice = Math.ceil(Math.max(msp, priceForNet(realCost, MIN_MARGIN)) / 100) * 100
  const fee = Math.round(listPrice * FEE_RATE)
  const grossSpread = listPrice - realCost
  const netVat = Math.max(0, Math.round(grossSpread / 11))
  const margin = grossSpread - fee - netVat
  return {
    qty: n, dome, ship, msp, realCost, breakeven, listPrice, fee, margin,
    marginPct: +(margin / listPrice * 100).toFixed(2),
    abovePriceFloor: listPrice > msp,   // MSP보다 높게 매긴 경우(원가 때문) — 경쟁력 확인 필요
  }
}
const computePrice = row => computePriceFor(row, 1)

/** 공급사 내부 안내문(최저가 제한·폐쇄몰 등)이 상품명에 섞여 나가지 않도록 방어 — docs 메모 supplier_note_contamination */
function cleanTitle(row) {
  let t = String(row.title_clean || row.title || '')
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/최저가\s*제한[^|]*/g, ' ')
    .replace(/폐쇄몰[^|]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim()
  return t
}
/**
 * 브랜드 — 쿠팡은 등록되지 않은/타사 상표 브랜드명을 보내면
 * "브랜드 ID가 필요합니다. WING 브랜드 관리에서 등록해 주세요"로 거절한다(2026-09-17 실측, #216 보령프로바이오틱스).
 * 상품명 첫 토큰으로 브랜드를 유추하면(다른 등록 스크립트들의 관행) "(간유산균)보령프로바이오틱스" 같은
 * 쓰레기 값이나 타사 상표가 그대로 나가므로, **공급처가 명시한 brand 컬럼이 있을 때만** 보낸다.
 * 생략하면 쿠팡이 '기타' 취급한다 — 확실할 때만 보내는 쪽이 안전하다.
 */
function pickBrand(row) {
  const b = String(row.brand ?? '').trim()
  return b.length >= 2 ? b : null
}
async function buildPayload(row, meta, categoryCode, categoryName, qtys = [1]) {
  const prices = qtys.map(n => computePriceFor(row, n))
  const price = prices[0]
  const title = cleanTitle(row)
  const noticeCategory = pickNoticeCategory(meta.noticeCategories)
  const notices = buildNotices(noticeCategory, title)

  // 이미지 — 대표 1장 + 상세 최대 10장. MSP 안내표(data:/docs.google 스크린샷)는 수집기가 제외했으나 한 번 더 거른다.
  const mains = Array.isArray(row.images_main) ? row.images_main : []
  const rep = row.thumb_url || mains[0]
  if (!rep) throw new Error('대표 이미지 없음')
  const detail = (Array.isArray(row.detail_images) ? row.detail_images : [])
    .filter(u => typeof u === 'string' && !u.startsWith('data:') && !/docs\.google\.com/i.test(u))
  const contentImgs = []
  for (const u of detail.slice(0, 14)) {
    if (await downloadable(u)) contentImgs.push(u)
    if (contentImgs.length >= 10) break
  }
  const items_images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: rep }]
  const contents = contentImgs.map(u => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] }))

  // 변형(items[]) — 수량 축. 쿠팡은 isAllowSingleItem=false 카테고리에서 변형이 2개 이상이어야 등록을 받는다.
  // 각 변형은 구매옵션 값(수량)이 서로 달라야 하고 externalVendorSku 도 달라야 한다.
  const opts = optionsFromTitle(title)
  const items = qtys.map((n, i) => {
    const p = prices[i]
    const { attributes, itemName } = buildItemAttributes(meta.attributes ?? [], opts, n)
    return {
      itemName,
      originalPrice: Math.ceil(p.listPrice * 1.2 / 100) * 100,
      salePrice: p.listPrice,
      maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: 2, unitCount: n, adultOnly: 'EVERYONE', taxType: 'TAX',
      parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
      externalVendorSku: qtys.length > 1 ? `${row.product_no}-${n}` : row.product_no,
      images: items_images, notices, attributes, contents, offerCondition: 'NEW',
    }
  })
  const payload = {
    vendorId: VENDOR_ID, sellerProductName: title, displayProductName: title,
    displayCategoryCode: categoryCode, ...(pickBrand(row) ? { brand: pickBrand(row) } : {}),
    generalProductName: title, productGroup: title.split(/\s+/).slice(0, 3).join(' '),
    manufacture: '상세설명 참조', saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: 'CJGLS', deliveryChargeType: 'FREE', deliveryCharge: 0,
    freeShipOverAmount: 0, deliveryChargeOnReturn: 3000, remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY',
    returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: COMPANY_CONTACT,
    returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL,
    returnCharge: RETURN_CHARGE, outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE, vendorUserId: 'anteam7',
    requested: false, items, notices: [], requiredDocuments: [],
  }
  return { payload, price, prices, qtys, title, categoryName, contentCount: contentImgs.length }
}

/** 카테고리 예측 (결과는 DB 캐시 — 매 실행 호출하지 않는다) */
async function resolveCategory(row, title) {
  if (row.coupang_category_code) return { code: row.coupang_category_code, name: row.coupang_category_name, cached: true }
  const pr = await api('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', { productName: title })
  const cat = pr.body?.data
  if (!cat?.predictedCategoryId) throw new Error(`카테고리 예측 실패: ${JSON.stringify(pr.body).slice(0, 120)}`)
  const code = parseInt(cat.predictedCategoryId)
  const name = cat.predictedCategoryName ?? null
  if (!DRY) {
    await sb.from(TABLE).update({ coupang_category_code: code, coupang_category_name: name, coupang_category_predicted_at: new Date().toISOString() }).eq('product_no', row.product_no)
  }
  return { code, name, cached: false }
}

// ── 대상 선정 ────────────────────────────────────────────────────
const baseSel = sb.from(TABLE).select('*')
const { data: rows, error: qErr } = ONLY.length
  ? await baseSel.in('product_no', ONLY)
  : await baseSel.eq('coupang_eligible', true)
if (qErr) { console.error('대상 조회 실패:', qErr.message); process.exit(1) }

const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no, status').eq('source', 'wellroot')
// FAILED 는 재시도 가능해야 하므로 기등록으로 치지 않는다(SKIPPED 는 카테고리 제약이라 계속 막는다)
const existingSet = new Set((existing ?? []).filter(r => r.status !== 'FAILED').map(r => r.source_goods_no))

const skipped = []
const candidates = (rows ?? [])
  .filter(r => {
    if (existingSet.has(r.product_no)) { skipped.push([r.product_no, '이미 등록됨']); return false }
    if (!r.coupang_eligible) { skipped.push([r.product_no, '등록 대상 아님(MSP 없음·판매중 아님·등록제외)']); return false }
    if (r.has_option) { skipped.push([r.product_no, '옵션상품 — 옵션조합 등록 미구현']); return false }
    if (SKIP_HGSIK && r.is_health_functional) { skipped.push([r.product_no, '건기식 제외(--skip-hgsik)']); return false }
    return true
  })
  .map(r => ({ ...r, _p: computePrice(r) }))
  .sort((a, b) => b._p.marginPct - a._p.marginPct)
const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates

console.log(`=== 웰루트 → 쿠팡 등록 ${DRY ? '[DRY]' : ''} ===`)
console.log(`대상 ${targets.length}건 (후보 ${candidates.length} · 제외 ${skipped.length} · 기등록 ${existingSet.size} · 최소마진 ${(MIN_MARGIN * 100).toFixed(0)}%)`)
if (skipped.length) {
  const grouped = skipped.reduce((m, [no, why]) => { (m[why] ??= []).push(no); return m }, {})
  for (const [why, nos] of Object.entries(grouped)) console.log(`  · ${why}: ${nos.length}건 (${nos.slice(0, 8).join(',')}${nos.length > 8 ? '…' : ''})`)
}
console.log('')
const summary = { success: 0, fail: 0, approved: 0, skip: 0, errors: [] }

for (let i = 0; i < targets.length; i++) {
  const row = targets[i]
  const idx = `[${i + 1}/${targets.length}]`
  try {
    const title = cleanTitle(row)
    const cat = await resolveCategory(row, title)
    const meta = await getCategoryMeta(cat.code)

    // 쿠팡 "필수 구매옵션 입력 의무화"(2026-02-02~) — isAllowSingleItem=false 카테고리는 변형(items[]) 2개 이상 필요.
    // 웰루트는 수량별 MSP·수량 구간 배송비가 있어 "수량" 묶음이 자연스러운 변형 축이다(1개/2개/3개).
    const needBundle = meta.isAllowSingleItem === false || FORCE_BUNDLE
    const qtys = needBundle ? variantQtys(row, BUNDLE_QTYS) : [1]
    if (needBundle && qtys.length < 2) {
      console.log(`${idx} ⏭ ${row.product_no} [${cat.code}] ${title.slice(0, 32).padEnd(32)} | 변형 2개 이상 필요(--bundle) — SKIP`)
      summary.skip++; await sleep(300); continue
    }
    const noticeNames = (meta.noticeCategories ?? []).map(n => n.noticeCategoryName)
    if (!(noticeNames.includes('가공식품') || noticeNames.includes('건강기능식품'))) {
      throw new Error(`비식품 카테고리(${noticeNames.join(',') || '고시없음'}) — 건강식품만 등록`)
    }

    const built = await buildPayload(row, meta, cat.code, cat.name, qtys)
    if (DRY) {
      const variants = built.prices.map(p => `${p.qty}개 ${p.listPrice.toLocaleString()}원(MSP하한 ${p.msp.toLocaleString()}${p.abovePriceFloor ? "↑" : "="}, 마진 ${p.margin.toLocaleString()} ${p.marginPct}%)`).join(" · ")
      console.log(`${idx} (dry) ${String(row.product_no).padStart(4)} ${built.title.slice(0, 26).padEnd(26)} | 공급 ${String(row.supply_price_krw).padStart(6)} [${cat.code}${cat.cached ? "" : "*"}${needBundle ? " 묶음" : ""}] 상세 ${built.contentCount}장`)
      console.log(`        ${variants}`)
      continue
    }

    const r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    const success = r.status === 200 && r.body?.code === 'SUCCESS'
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null
    writeFileSync(path.join(__dirname, '..', `_tmp_wellroot_register_${row.product_no}.json`), JSON.stringify({ payload: built.payload, response: r.body }, null, 2), 'utf8')

    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: 'wellroot',
      source_goods_no: row.product_no, source_detail_url: row.detail_url, registered_title: built.title,
      display_category_code: cat.code, display_category_name: cat.name, brand: built.payload.brand,
      dome_price_krw: row.supply_price_krw, source_shipping_fee_krw: built.price.ship, outbound_shipping_fee_krw: 0,
      msp_price_krw: row.msp_price_krw, list_price_krw: built.price.listPrice,
      estimated_fee_krw: built.price.fee, estimated_margin_krw: built.price.margin, estimated_margin_pct: built.price.marginPct,
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false,
      rejection_reason: success ? null : (r.body?.message ?? String(r.body).slice(0, 500)),
      request_payload: built.payload, last_response: r.body,
      registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    }
    const { data: inserted, error: insertErr } = await sb.from('jimscanner_coupang_listings').insert(listingRow).select('id').single()
    if (insertErr) {
      // 쿠팡 등록은 됐는데 DB 기록이 실패하면 추적 불가 상태가 되므로 승인요청으로 진행하지 않는다(bio77 공식).
      summary.fail++
      summary.errors.push({ no: row.product_no, title: built.title.slice(0, 36), reason: `listings insert 실패: ${insertErr.message}` })
      console.log(`${idx} ⚠ ${row.product_no} 등록 success=${success} 이나 DB insert 실패: ${insertErr.message}`)
      await sleep(500); continue
    }
    if (!success) {
      summary.fail++
      const reason = String(r.body?.message ?? JSON.stringify(r.body)).slice(0, 150)
      summary.errors.push({ no: row.product_no, title: built.title.slice(0, 36), cat: cat.code, reason })
      console.log(`${idx} ✗ ${row.product_no} [${cat.code}] ${built.title.slice(0, 30).padEnd(30)} | ${reason}`)
      await sleep(500); continue
    }
    summary.success++
    console.log(`${idx} ✓ ${row.product_no} ${built.title.slice(0, 30).padEnd(30)} | ${built.qtys.length > 1 ? built.qtys.length + "변형 " : ""}${built.price.listPrice.toLocaleString()}원~ (${built.price.marginPct}%) sellerPID=${sellerProductId}`)

    if (!NO_APPROVAL && sellerProductId) {
      // 등록 직후 바로 승인요청하면 쿠팡 전파 지연으로 "임시저장 상태만 승인 가능" 오류가 날 수 있어 재시도
      let appr
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(1500)
        appr = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`)
        if (appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)) break
        if (!/임시저장.*상태.*상품만/.test(appr.body?.message ?? '')) break
      }
      const apprOk = appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)
      if (apprOk) {
        await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', last_synced_at: new Date().toISOString() }).eq('id', inserted.id)
        summary.approved++
        console.log(`      → 승인요청 완료 (PENDING_APPROVAL)`)
        await sleep(1500)
        const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)
        const vendorItemIds = (detail.body?.data?.items ?? []).map(it => it.vendorItemId).filter(Boolean)
        if (vendorItemIds.length) {
          const qty = Math.max(1, Math.min(row.stock_qty ?? 30, 30))
          for (const vid of vendorItemIds) { await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/quantities/${qty}`); await sleep(300) }
          console.log(`      → 재고 ${qty}개 설정`)
        } else {
          console.log(`      → vendorItemId 미부여 (쿠팡 검수 대기, 수시간~1-2일)`)
        }
      } else {
        console.log(`      → 승인요청 실패: ${JSON.stringify(appr.body).slice(0, 150)}`)
        await sb.from('jimscanner_coupang_listings').update({ rejection_reason: `승인요청 실패: ${JSON.stringify(appr.body).slice(0, 300)}`, last_synced_at: new Date().toISOString() }).eq('id', inserted.id)
      }
    }
  } catch (e) {
    summary.fail++
    summary.errors.push({ no: row.product_no, title: String(row.title || '').slice(0, 36), reason: e.message })
    console.log(`${idx} ✗ ${row.product_no} ERROR: ${e.message}`)
  }
  await sleep(500)
}

console.log('\n=== 완료 ===')
console.log(`성공 ${summary.success} / 승인요청 ${summary.approved} / 실패 ${summary.fail} / 보류 ${summary.skip}`)
if (summary.errors.length) {
  console.log('\n실패 사유:')
  summary.errors.forEach(e => console.log(`  - ${e.no} [${e.cat ?? '?'}] ${e.title}: ${e.reason}`))
}
