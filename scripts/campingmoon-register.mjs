#!/usr/bin/env node
/**
 * 캠핑문 → 쿠팡 등록 — **옵션(색상/사이즈) 1개 = item 1개**, 묶음(pack) 전략 포함. docs/plan-campingmoon.md §3·P2 (2026-10-14)
 *   node scripts/campingmoon-register.mjs --dry [--only=4385,4472] [--limit=N] [--allow-kc] [--allow-nomatch] [--no-approval] [--show-payload]
 *
 *  - 대상: jimscanner_campingmoon_products active·판매가능·register_excluded=false·시세 조회됨(market_checked_at) — 시세 미조회는 --allow-nomatch 로만.
 *  - 가격: lib/campingmoon-price.mjs decide(옵션가, 시세 최저) → 1개가 STRUCTURAL 이면 OK 인 가장 작은 묶음 n(2·3)으로 등록(배송비 1회라 단가 개선). 전부 STRUCTURAL 이면 보류.
 *  - 카테고리: categorization/predict(캐시) → category-related-metas. MANDATORY 속성을 item 마다 채운다: 캠핑문 옵션 축(색상/사이즈)은 옵션값, 수량 = n개,
 *    그 외 NUMBER(가로길이 등)는 제목에서 못 읽으면 등록 보류(허위값 금지). EXPOSED 는 메타의 exposed 를 따른다. isAllowSingleItem=false 인데 item 이 1개뿐이면 수량 축으로 1·2개 변형.
 *  - 고시: '기타 재화' → '스포츠용품' → 비전기 고시 순(domeggook 패턴). 전기/KC 고시만 있는 카테고리는 보류. kc_suspect(버너·토치·충전식·LED…)는 --allow-kc 없이는 제외.
 *  - 이미지: 대표 = big_url(옵션 이미지가 있으면 item 별), 상세 = detail_image_src(외부 호스트, 핫링크 허용 실측). 상세 0장이면 보류.
 *  - 기록: jimscanner_coupang_listings 1행(source campingmoon, source_goods_no product_no) + jimscanner_listing_items item 별 행(external_sku = campingmoon:{no}:{item_code}:{n}).
 *    vendorItemId 는 승인 후 coupang-followup-approvals 가 채운다(P5). SKU 에 하이픈이 없어 기존 번들 파서(coupangBundleSize)가 건드리지 않는다 — 묶음 수는 listing_items.pack_qty.
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { decide, pickPack, costFor, COUPANG_FEE, DISCOUNT_BASE, netProfit } from './lib/campingmoon-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID, ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const TABLE = 'jimscanner_campingmoon_products', ITEMS = 'jimscanner_campingmoon_items', SOURCE = 'campingmoon'
// 출고지·반품지 — 기존 매입처와 동일(kwholesale-register.mjs 와 이중관리 지점)
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717, RETURN_CENTER_CODE = '1002609354', RETURN_CHARGE_NAME = '신사로 반품', RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8', RETURN_ADDRESS_DETAIL = '301', RETURN_ZIP_CODE = '08703', COMPANY_CONTACT = '010-4164-3802'
const DELIVERY_COMPANY = 'HANJIN' // 캠핑문 출고 택배사(공지 2022-07 CJ→한진)
const MAX_TITLE_LEN = 100
const MANUFACTURER = '(주)소리 (Campingmoon 한국 총판)'
const PRIVACY_NOTICE = '[개인정보 처리 위탁 안내] 이 상품은 공급사 (주)소리(캠핑문)에서 직접 발송됩니다. 배송을 위해 주문 시 입력하신 수령인 정보(이름·연락처·주소)가 공급사에 전달됩니다. 제주·도서산간 지역은 배송이 제한될 수 있습니다.'

const args = process.argv.slice(2)
const DRY = args.includes('--dry'), NO_APPROVAL = args.includes('--no-approval'), ALLOW_KC = args.includes('--allow-kc'), ALLOW_NOMATCH = args.includes('--allow-nomatch')
const argOf = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const LIMIT = +(argOf('limit') || 0) || 0
const ONLY = (argOf('only') || '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,7}$/.test(s))
const metaCacheDir = path.join(__dirname, '..', '_tmp_meta_cache'); if (!existsSync(metaCacheDir)) mkdirSync(metaCacheDir, { recursive: true })
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

function sign(method, urlPath, query = '') { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + query).digest('hex') } }
async function api(method, urlPath, body = null, retried = false) {
  const { datetime, signature } = sign(method, urlPath, '')
  const res = await fetch(`${HOST}${urlPath}`, { method, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90_000) })
  if (res.status === 429 && !retried) { console.log('      ⏳ 429 — 10초 대기 후 재시도'); await sleep(10000); return api(method, urlPath, body, true) }
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
async function downloadable(u) { try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) }); return r.status === 200 && /image\//.test(r.headers.get('content-type') || '') } catch { return false } }

// ── 상품명 검사(coupang-name-audit RULES 요약) ──
const NAME_RULES = [
  { sev: 'block', key: '광고성', re: /(최저가|초특가|특가|핫딜|세일|할인|사은품|무료\s*증정|1\s*\+\s*1|당일\s*발송|당일\s*배송|무료\s*배송|품절\s*임박|한정\s*수량|이벤트|행사)/ },
  { sev: 'block', key: '금지특수문자', re: /[※☆★♥♡▶◀◆■□【】〈〉「」『』]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
  { sev: 'block', key: 'URL/연락처', re: /(https?:\/\/|www\.|\.com|\.co\.kr|01[016-9][- ]?\d{3,4}[- ]?\d{4})/i },
  { sev: 'block', key: '타플랫폼', re: /(네이버|스마트\s*스토어|11번가|지마켓|g마켓|옥션|위메프|티몬|인터파크|아마존)/i },
]
const auditName = (name) => { const hits = NAME_RULES.map((r) => { const m = name.match(r.re); return m ? { ...r, hit: m[0].trim() } : null }).filter(Boolean); if ([...name].length > MAX_TITLE_LEN) hits.push({ sev: 'block', key: '길이초과', hit: `${[...name].length}자` }); return hits }
function cleanTitle(row) {
  let t = String(row.name_clean || row.name_raw || '').replace(/\s+/g, ' ').trim()
  if (!/캠핑문|campingmoon/i.test(t)) t = `캠핑문 ${t}` // 브랜드 총판 상품 — 검색·매칭을 위해 브랜드를 앞에
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim()
  return t
}

// ── 고시 ──
const ELEC = /전자|전기|어린이|살생물|화학/
function pickNoticeCategory(ncs) {
  if (!ncs?.length) return null
  return ncs.find((n) => n.noticeCategoryName === '기타 재화') || ncs.find((n) => n.noticeCategoryName === '스포츠용품') || ncs.find((n) => !ELEC.test(n.noticeCategoryName)) || null
}
function fillNotice(dn, title, row) {
  if (/품명|제품명|모델/.test(dn)) return row.model_code ? `${title} (${row.model_code})` : title
  if (/인증|허가|KC/.test(dn)) return '안전기준 비대상 생활용품 (해당없음)'
  if (/전화|연락|상담|A\/?S|책임자/.test(dn)) return COMPANY_CONTACT
  if (/제조국|원산지/.test(dn)) return '상세설명 참조'
  if (/제조자|수입자|제조사/.test(dn)) return MANUFACTURER
  if (/품질보증|보증기준/.test(dn)) return '관련 법 및 소비자분쟁해결기준에 따름'
  if (/색상/.test(dn)) return row._colors || '상세설명 참조'
  return '상세설명 참조'
}
const buildNotices = (nc, title, row) => (nc?.noticeCategoryDetailNames ?? []).filter((d) => d.required === 'MANDATORY').map((d) => ({ noticeCategoryName: nc.noticeCategoryName, noticeCategoryDetailName: d.noticeCategoryDetailName, content: fillNotice(d.noticeCategoryDetailName, title, row) }))

// ── 속성: 캠핑문 옵션 축 → 쿠팡 MANDATORY 속성 ──
const pickUnit = (units, prefs) => { if (!units?.length) return ''; for (const x of prefs) if (units.includes(x)) return x; return units[0] }
/** 옵션 축 이름("색상-사이즈")과 값("블랙-M")을 쿠팡 속성명(색상/사이즈)별 값으로 */
function optionAxes(optTitle, optValue) {
  const axes = String(optTitle || '').split(/[-/·,및]+|\s*및\s*/).map((s) => s.trim()).filter(Boolean)
  const vals = String(optValue || '').split(/\s*[-/]\s*/).map((s) => s.trim()).filter(Boolean)
  const out = {}
  if (axes.length >= 2 && vals.length === axes.length) axes.forEach((a, i) => { out[a] = vals[i] })
  else if (axes.length) out[axes[0]] = String(optValue || '').trim()
  const get = (re) => { const k = Object.keys(out).find((a) => re.test(a)); return k ? out[k] : null }
  return { color: get(/색상|컬러|색/), size: get(/사이즈|크기|길이|단수|용량|규격/), raw: String(optValue || '').trim() }
}
/** item 속성 — MANDATORY 전부 채움. 못 채우는 NUMBER 속성은 {error} */
function buildAttributes(meta, row, item, n, title) {
  const ax = optionAxes(row.option_title, item.option_value)
  const out = []
  for (const a of meta.attributes ?? []) {
    if (a.required !== 'MANDATORY') continue
    const nm = a.attributeTypeName, exposed = a.exposed === 'EXPOSED' ? 'EXPOSED' : 'NONE'
    if (/수량/.test(nm)) { out.push({ attributeTypeName: nm, attributeValueName: `${n}${pickUnit(a.usableUnits, ['개', '개입', '세트', '팩'])}`, exposed }); continue }
    if (/색상|컬러/.test(nm)) { out.push({ attributeTypeName: nm, attributeValueName: (ax.color || (row.has_option && !ax.size ? ax.raw : null) || '단일색상').slice(0, 30), exposed }); continue }
    if (/사이즈|크기/.test(nm) && a.dataType !== 'NUMBER') { out.push({ attributeTypeName: nm, attributeValueName: (ax.size || (row.has_option && !ax.color ? ax.raw : null) || 'FREE').slice(0, 30), exposed }); continue }
    if (a.dataType === 'NUMBER' && a.usableUnits?.length) {
      const unitAlt = a.usableUnits.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      const m = `${item.option_value || ''} ${title}`.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitAlt})(?![a-z가-힣])`, 'i'))
      if (!m) return { error: `필수 수치 속성 '${nm}'(${a.usableUnits.join('/')}) 값을 제목/옵션에서 못 읽음` }
      out.push({ attributeTypeName: nm, attributeValueName: `${m[1]}${a.usableUnits.find((u) => u.toLowerCase() === m[2].toLowerCase()) || m[2]}`, exposed })
      continue
    }
    if (a.dataType === 'STRING') { out.push({ attributeTypeName: nm, attributeValueName: (row.has_option ? ax.raw : null) || '상세설명 참조', exposed }); continue }
    return { error: `필수 속성 '${nm}'(${a.dataType}) 처리 규칙 없음` }
  }
  return { attributes: out }
}

async function buildPayload(row, items, meta, cat) {
  const title = cleanTitle(row)
  const nc = pickNoticeCategory(meta.noticeCategories)
  if (!nc) throw new Error(`전기/KC 고시만 있는 카테고리(${(meta.noticeCategories ?? []).map((n) => n.noticeCategoryName).join(',')}) — 보류`)
  row._colors = [...new Set(items.map((it) => optionAxes(row.option_title, it.option_value).color).filter(Boolean))].join(', ')
  const notices = buildNotices(nc, title, row)
  const rep = row.big_url || row.thumb_url
  if (!rep) throw new Error('대표 이미지 없음')
  if (!(await downloadable(rep))) throw new Error(`대표 이미지 다운로드 실패: ${rep}`)
  const contentImgs = []
  for (const u of (row.detail_image_src || []).slice(0, 10)) if (await downloadable(u)) contentImgs.push(u)
  if (!contentImgs.length) throw new Error('상세 이미지 없음/다운로드 실패 — 보류')
  const contents = [...contentImgs.map((u) => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] })), { contentsType: 'TEXT', contentDetails: [{ content: PRIVACY_NOTICE, detailType: 'TEXT' }] }]
  const built = []
  for (const it of items) {
    const price = it._price
    const attr = buildAttributes(meta, row, it, it._n, title)
    if (attr.error) throw new Error(attr.error)
    const label = [it.option_value, it._n > 1 ? `${it._n}개` : null].filter(Boolean).join(', ') || (it._n > 1 ? `${it._n}개` : '단품')
    const itemImg = it.item_image && (await downloadable(it.item_image)) ? it.item_image : rep
    built.push({
      itemName: label.slice(0, 100), originalPrice: price, salePrice: price,
      maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1, outboundShippingTimeDay: 2, unitCount: it._n,
      adultOnly: 'EVERYONE', taxType: 'TAX', parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
      externalVendorSku: `${SOURCE}:${row.product_no}:${it.item_code}:${it._n}`, emptyBarcode: true, emptyBarcodeReason: '바코드 없음',
      images: [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: itemImg }], notices, attributes: attr.attributes, contents, offerCondition: 'NEW',
    })
  }
  // EXPOSED 속성 조합 유일성(쿠팡은 같은 조합의 item 을 거절)
  const combos = built.map((b) => JSON.stringify(b.attributes.filter((a) => a.exposed === 'EXPOSED').map((a) => [a.attributeTypeName, a.attributeValueName])))
  if (new Set(combos).size !== combos.length) throw new Error('옵션 조합 중복(EXPOSED 속성이 같은 item 2개) — 옵션 축이 쿠팡 속성에 없음')
  const payload = {
    vendorId: VENDOR_ID, sellerProductName: title, displayProductName: title, displayCategoryCode: cat.code, brand: '캠핑문',
    generalProductName: title, productGroup: title.split(/\s+/).slice(0, 3).join(' '), manufacture: MANUFACTURER,
    saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: DELIVERY_COMPANY, deliveryChargeType: 'FREE', deliveryCharge: 0, freeShipOverAmount: 0, deliveryChargeOnReturn: RETURN_CHARGE,
    remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY', returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: COMPANY_CONTACT,
    returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL, returnCharge: RETURN_CHARGE, outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
    vendorUserId: 'anteam7', requested: false, items: built, notices: [], requiredDocuments: [],
  }
  return { payload, title, contentCount: contentImgs.length, noticeName: nc.noticeCategoryName }
}

async function resolveCategory(row, title) {
  if (row.coupang_category_code) return { code: Number(row.coupang_category_code), name: row.coupang_category_name, cached: true }
  const pr = await api('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', { productName: title })
  const cat = pr.body?.data
  if (!cat?.predictedCategoryId) throw new Error(`카테고리 예측 실패: ${JSON.stringify(pr.body).slice(0, 120)}`)
  const code = parseInt(cat.predictedCategoryId), name = cat.predictedCategoryName ?? null
  if (!DRY) await sb.from(TABLE).update({ coupang_category_code: String(code), coupang_category_name: name, updated_at: new Date().toISOString() }).eq('product_no', row.product_no)
  return { code, name, cached: false }
}

// ── 대상 ──
async function fetchAll(build) { const PAGE = 1000, out = []; for (let from = 0; ; from += PAGE) { const { data, error } = await build().range(from, from + PAGE - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < PAGE) return out } }
let rows = await fetchAll(() => sb.from(TABLE).select('*').eq('status', 'active').order('product_no'))
if (ONLY.length) rows = rows.filter((r) => ONLY.includes(r.product_no))
const allItems = await fetchAll(() => sb.from(ITEMS).select('*').eq('status', 'active').order('item_code'))
const itemsBy = new Map(); for (const it of allItems) { if (!itemsBy.has(it.product_no)) itemsBy.set(it.product_no, []); itemsBy.get(it.product_no).push(it) }
const { data: existing, error: exErr } = await sb.from('jimscanner_coupang_listings').select('source_goods_no, status').eq('source', SOURCE)
if (exErr) { console.error('기등록 조회 실패:', exErr.message); process.exit(1) }
const existingSet = new Set((existing ?? []).filter((r) => r.status !== 'FAILED').map((r) => r.source_goods_no))
const skipped = []
const candidates = rows.filter((r) => {
  if (existingSet.has(r.product_no)) { skipped.push([r.product_no, '이미 등록됨']); return false }
  if (r.soldout) { skipped.push([r.product_no, '품절']); return false }
  if (r.register_excluded) { skipped.push([r.product_no, `제외(${r.exclude_reason || ''})`]); return false }
  if (r.kc_suspect && !ALLOW_KC) { skipped.push([r.product_no, 'KC 의심(전기·가스·충전식) — --allow-kc']); return false }
  if (!r.market_checked_at && !ALLOW_NOMATCH) { skipped.push([r.product_no, '시세 미조회 — campingmoon-market.mjs 먼저(--allow-nomatch 로 강행)']); return false }
  if (!(itemsBy.get(r.product_no) || []).some((i) => i.is_selling)) { skipped.push([r.product_no, '판매중 옵션 없음']); return false }
  const block = auditName(cleanTitle(r)).find((h) => h.sev === 'block')
  if (block) { skipped.push([r.product_no, `상품명 🚫 ${block.key}("${block.hit}")`]); return false }
  return true
})
const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates
console.log(`=== 캠핑문 → 쿠팡 등록 ${DRY ? '[DRY]' : ''}${NO_APPROVAL ? ' [승인요청 안 함]' : ''} · 할인기준 ${DISCOUNT_BASE} · 수수료 ${(COUPANG_FEE * 100).toFixed(1)}% ===`)
console.log(`대상 ${targets.length}건 (후보 ${candidates.length} · 제외 ${skipped.length} · 기등록 ${existingSet.size})`)
if (skipped.length) { const g = skipped.reduce((m, [no, why]) => { const k = why.replace(/\("[^"]*"\)|\(.*\)$/g, ''); (m[k] ??= []).push(no); return m }, {}); for (const [why, nos] of Object.entries(g)) console.log(`  · ${why}: ${nos.length}건 (${nos.slice(0, 8).join(',')}${nos.length > 8 ? '…' : ''})`) }
console.log('')

const summary = { success: 0, fail: 0, approved: 0, skip: 0, errors: [] }
const logDir = path.join(__dirname, '..', '_tmp_campingmoon_register'); if (!DRY && !existsSync(logDir)) mkdirSync(logDir, { recursive: true })
for (let i = 0; i < targets.length; i++) {
  const row = targets[i]; const idx = `[${i + 1}/${targets.length}]`
  try {
    const title = cleanTitle(row)
    const cat = await resolveCategory(row, title)
    const meta = await getCategoryMeta(cat.code)
    // 옵션별 가격·묶음 결정: 상품 단위로 묶음 n 을 고르고(최저 옵션가 기준), 옵션마다 그 n 의 가격. STRUCTURAL 옵션은 뺀다
    const selling = (itemsBy.get(row.product_no) || []).filter((it) => it.is_selling)
    const priceOf = (it) => it.option_price || (row.sale_price + (it.add_price || 0))
    const pick = pickPack(decide(Math.min(...selling.map(priceOf)), row.market_low))
    if (!pick) { console.log(`${idx} ⏭ ${row.product_no} ${title.slice(0, 30)} | 1·2·3개 전부 시세(${row.market_low}) < 하한 — STRUCTURAL 보류`); summary.skip++; continue }
    let n = pick.n
    let items = selling.map((it) => { const d = decide(priceOf(it), row.market_low)[n - 1]; return d && d.price ? { ...it, _n: n, _price: d.price, _cost: d.cost, _net: d.net } : null }).filter(Boolean)
    const hasQtyAxis = (meta.attributes ?? []).some((a) => a.required === 'MANDATORY' && /수량/.test(a.attributeTypeName))
    if (meta.isAllowSingleItem === false && items.length < 2) {
      if (!hasQtyAxis) { console.log(`${idx} ⏭ ${row.product_no} ${title.slice(0, 30)} | 옵션 필수 카테고리(${cat.code})인데 변형 1개·수량 축 없음 — 보류`); summary.skip++; continue }
      const extra = selling.map((it) => { const d = decide(priceOf(it), row.market_low)[n] /* n+1 */; return d && d.price ? { ...it, _n: n + 1, _price: d.price, _cost: d.cost, _net: d.net } : null }).filter(Boolean)
      items = [...items, ...extra]
      if (items.length < 2) { console.log(`${idx} ⏭ ${row.product_no} | 수량 변형도 못 만듦(묶음가 STRUCTURAL) — 보류`); summary.skip++; continue }
    }
    if (!items.length) { console.log(`${idx} ⏭ ${row.product_no} | 가격 가능한 옵션 없음`); summary.skip++; continue }
    const built = await buildPayload(row, items, meta, cat)
    if (DRY && args.includes('--show-payload')) writeFileSync(path.join(process.env.TEMP || __dirname, `campingmoon-payload-${row.product_no}.json`), JSON.stringify(built.payload, null, 2))
    const first = items[0]
    if (DRY) {
      console.log(`${idx} (dry) ${row.product_no} ${built.title.slice(0, 34).padEnd(34)} [${cat.code}${cat.cached ? '' : '*'} ${String(cat.name ?? '').slice(0, 14)}] 고시 ${built.noticeName} 상세 ${built.contentCount}장 | 시세 ${row.market_low ?? '-'}(${row.market_count ?? 0}) ${pick.verdict}${n > 1 ? ` 묶음 ${n}개` : ''}`)
      for (const it of items) console.log(`        ${it.item_code} ${(it.option_value || '단품').padEnd(12)} x${it._n} 캠핑문 ${priceOf(it)} → 원가 ${it._cost} 판매 ${it._price} 순이익 ${it._net} (${(it._net / it._price * 100).toFixed(1)}%) | ${built.payload.items.find((b) => b.externalVendorSku.endsWith(`:${it.item_code}:${it._n}`))?.attributes.map((a) => `${a.attributeTypeName}=${a.attributeValueName}${a.exposed === 'EXPOSED' ? '*' : ''}`).join(' ')}`)
      continue
    }
    let r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    if (built.payload.brand && r.body?.code !== 'SUCCESS' && /브랜드/.test(String(r.body?.message || ''))) { console.log(`      ↻ 브랜드 "${built.payload.brand}" 거절(${String(r.body?.message).slice(0, 60)}) — 브랜드 없이 재시도`); delete built.payload.brand; await sleep(500); r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload) }
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null
    const success = r.status === 200 && r.body?.code === 'SUCCESS' && sellerProductId != null // id 없는 SUCCESS 는 추적 불가 → 실패로 기록
    writeFileSync(path.join(logDir, `${row.product_no}.json`), JSON.stringify({ payload: built.payload, response: r.body }, null, 2), 'utf8')
    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: SOURCE, source_goods_no: row.product_no, source_detail_url: row.detail_url, registered_title: built.title,
      display_category_code: cat.code, display_category_name: cat.name, brand: built.payload.brand ?? null,
      // msp_price_krw(NOT NULL) = 우리 하한가(floor) — 캠핑문엔 공급사 MSP 가 없으니 리프라이스·pricewatch 가 이 아래로 못 내리게 하는 값
      dome_price_krw: costFor(priceOf(first), first._n), source_shipping_fee_krw: 3000, outbound_shipping_fee_krw: 0, msp_price_krw: decide(priceOf(first), row.market_low)[first._n - 1].floor, list_price_krw: first._price,
      estimated_fee_krw: Math.round(first._price * COUPANG_FEE), estimated_margin_krw: first._net, estimated_margin_pct: +(first._net / first._price * 100).toFixed(2),
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false, rejection_reason: success ? null : (r.body?.message ?? String(r.body).slice(0, 500)),
      request_payload: built.payload, last_response: r.body, registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    }
    const { data: inserted, error: insertErr } = await sb.from('jimscanner_coupang_listings').insert(listingRow).select('id').single()
    if (insertErr) { summary.fail++; summary.errors.push({ no: row.product_no, title: built.title.slice(0, 36), reason: `listings insert 실패: ${insertErr.message}` }); console.log(`${idx} ⚠ ${row.product_no} 등록 success=${success} 이나 DB insert 실패: ${insertErr.message}`); await sleep(500); continue }
    if (!success) { summary.fail++; const reason = String(r.body?.message ?? JSON.stringify(r.body)).slice(0, 160); summary.errors.push({ no: row.product_no, title: built.title.slice(0, 36), cat: cat.code, reason }); console.log(`${idx} ✗ ${row.product_no} [${cat.code}] ${built.title.slice(0, 30)} | ${reason}`); await sleep(500); continue }
    // 옵션 매핑 행(vendorItemId 는 승인 후 followup 이 채움)
    const liRows = items.map((it) => ({ market: 'coupang', listing_key: String(sellerProductId), external_sku: `${SOURCE}:${row.product_no}:${it.item_code}:${it._n}`, source: SOURCE, goods_no: row.product_no, item_code: it.item_code, option_value: it.option_value, pack_qty: it._n, sale_price: it._price, cost_price: it._cost, status: 'ACTIVE' }))
    const { error: liErr } = await sb.from('jimscanner_listing_items').upsert(liRows, { onConflict: 'market,listing_key,external_sku' })
    if (liErr) console.log(`      ⚠ listing_items 기록 실패: ${liErr.message}`)
    summary.success++
    console.log(`${idx} ✓ ${row.product_no} ${built.title.slice(0, 30).padEnd(30)} | ${items.length}옵션 ${first._price.toLocaleString()}원~ sellerPID ${sellerProductId}`)
    if (!NO_APPROVAL && sellerProductId) {
      let appr
      for (let attempt = 0; attempt < 3; attempt++) { await sleep(1500); appr = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`); if (appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)) break; if (!/임시저장.*상태.*상품만/.test(appr.body?.message ?? '')) break }
      const apprOk = appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)
      if (apprOk) { await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', last_synced_at: new Date().toISOString() }).eq('id', inserted.id); summary.approved++; console.log('      → 승인요청 완료 (PENDING_APPROVAL)') }
      else {
        await sleep(3000)
        const cur = (await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)).body?.data?.statusName ?? ''
        if (cur && !/임시저장/.test(cur)) { await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', approval_status_name: cur, last_synced_at: new Date().toISOString() }).eq('id', inserted.id); summary.approved++; console.log(`      → 승인요청 응답은 오류지만 쿠팡 상태 '${cur}' → PENDING_APPROVAL`) }
        else { console.log(`      → 승인요청 실패: ${JSON.stringify(appr.body).slice(0, 150)}`); await sb.from('jimscanner_coupang_listings').update({ rejection_reason: `승인요청 실패: ${JSON.stringify(appr.body).slice(0, 300)}`, last_synced_at: new Date().toISOString() }).eq('id', inserted.id) }
      }
    }
  } catch (e) { summary.fail++; summary.errors.push({ no: row.product_no, title: String(row.name_clean || '').slice(0, 36), reason: e.message }); console.log(`${idx} ✗ ${row.product_no} ERROR: ${e.message}`) }
  await sleep(400)
}
console.log('\n=== 완료 ===')
console.log(`성공 ${summary.success} / 승인요청 ${summary.approved} / 실패 ${summary.fail} / 보류 ${summary.skip}`)
if (summary.errors.length) { console.log('\n실패 사유:'); summary.errors.forEach((e) => console.log(`  - ${e.no} [${e.cat ?? '?'}] ${e.title}: ${e.reason}`)) }
void netProfit
