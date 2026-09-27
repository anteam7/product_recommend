/**
 * K-홀세일 → 쿠팡 Open API 등록 (jimscanner_kwholesale_products → jimscanner_coupang_listings, source='kwholesale')
 *   node scripts/kwholesale-register.mjs [--limit=N] [--only=471,176] [--dry] [--no-approval] [--skip-hgsik] [--allow-claims]
 *                                        [--bundle=1,2,3] [--force-bundle]
 * 설계: docs/plan-kwholesale.md §4 · 기준 코드: wellroot-register.mjs(웰루트 실등록 검증 공식)
 *
 * 웰루트 등록기와 다른 점:
 *   - 판매가: 수집기(kwholesale-collect.mjs)가 계산해 둔 sale_prices[N] 를 그대로 쓴다
 *       = max(최저판매가 MSP, 순마진 10% 가격) — 사용자 결정 2026-09-27. 여기서 다시 계산하지 않고, MSP 미만이면 등록 중단(안전장치).
 *   - 정가(originalPrice) = 판매가. 웰루트식 '판매가×1.2 정가'는 K홀세일 소비자가 정책·허위할인 소지 때문에 쓰지 않는다.
 *   - 택배사 HANJIN(K홀세일 실제 출고 택배사). 출고지·반품지는 기존(항동로·신사로) 그대로 — 사용자 결정 2026-09-27.
 *   - 옵션 속성 수치: 제품리스트 시트 '규격'(예 '2g x 30포', '450mg*60캡슐') 우선, 없으면 상품명.
 *   - 고시: '가공식품' 우선(웰루트와 동일) + 제조사몰 텍스트 고시가 있으면 식품유형·제조원·원재료를 실제 값으로.
 *     나머지는 '상세설명 참조' — 상세에 '제품 상세 정보' 표 이미지가 들어 있다(수집기가 판매자용 공지·배너는 제외).
 *   - 상세 끝에 개인정보 처리 위탁 고지(TEXT) — 수령인 정보가 (주)다인내추럴·한진택배로 전달됨(K홀세일 공지 요구).
 *   - 상품명 검사: coupang-name-audit.mjs 규칙 — 🚫(광고성·금지문자·URL·타플랫폼·100자 초과)는 등록 안 함,
 *     효능·질병 표현(⚠)도 기본 건너뜀(--allow-claims 로 허용). K홀세일 상품명엔 '간에 좋은' 같은 효능 문구가 있다.
 *   - 판촉·시음용·매장전용·중복·유통기한 임박·사람 제외는 coupang_eligible 에서 이미 빠진다(여기서 재확인).
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { parseSpec, buildPurchaseOptions } from './lib/coupang-purchase-options.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST
const TABLE = 'jimscanner_kwholesale_products'
const SOURCE = 'kwholesale'

// 출고지·반품지 — 기존 매입처와 동일(사용자 결정 2026-09-27: 출고지 항동로 · 반품지 신사로). wellroot/bio77-register.mjs 와 이중관리 지점.
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717
const RETURN_CENTER_CODE = '1002609354'
const RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8'
const RETURN_ADDRESS_DETAIL = '301'
const RETURN_ZIP_CODE = '08703'
const COMPANY_CONTACT = '010-4164-3802'
const DELIVERY_COMPANY = 'HANJIN'           // K홀세일 출고 택배사(공지·주문서 실측)
const FEE_RATE = 0.106
const MAX_TITLE_LEN = 100
const PRIVACY_NOTICE = '[개인정보 처리 위탁 안내] 이 상품은 제조사 (주)다인내추럴에서 직접 발송됩니다. 배송을 위해 주문 시 입력하신 수령인 정보(이름·주소·연락처)가 (주)다인내추럴 및 한진택배에 제공되며, 배송 완료 후 관련 법령에 따라 처리됩니다.'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const NO_APPROVAL = args.includes('--no-approval')
const SKIP_HGSIK = args.includes('--skip-hgsik')
const ALLOW_CLAIMS = args.includes('--allow-claims')
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const LIMIT = +(argOf('limit') || 0) || 0
const ONLY = (argOf('only') || '').split(',').map(s => s.trim()).filter(s => /^\d{1,7}$/.test(s))
// 묶음(옵션조합) — 쿠팡 "필수 구매옵션 의무화"(2026-02~)로 isAllowSingleItem=false 카테고리는 변형 2개 이상 필요.
// K홀세일은 수량별 하한(tiered_msp 1·2·3개, 2개 5%·3개 10% 할인 허용)이 있어 수량 축이 자연스럽다.
const BUNDLE_QTYS = (argOf('bundle') || '1,2,3').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
const FORCE_BUNDLE = args.includes('--force-bundle')

const metaCacheDir = path.join(__dirname, '..', '_tmp_meta_cache')
if (!existsSync(metaCacheDir)) mkdirSync(metaCacheDir, { recursive: true })
const sleep = ms => new Promise(s => setTimeout(s, ms))

function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + query).digest('hex') }
}
// 429 → 10초 대기 후 1회 재시도(coupang-register-pipeline 스킬 규칙)
async function api(method, urlPath, body = null, retried = false) {
  const { datetime, signature } = sign(method, urlPath, '')
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
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
async function downloadable(u) {
  try { const r = await fetch(u); return r.status === 200 && /image\//.test(r.headers.get('content-type') || '') } catch { return false }
}

// ── 상품명 검사 — coupang-name-audit.mjs RULES(정본) + K홀세일 효능 문구 보강 ──
const NAME_RULES = [
  { sev: 'block', key: '광고성', re: /(최저가|초특가|특가|핫딜|세일|할인|사은품|무료\s*증정|1\s*\+\s*1|당일\s*발송|당일\s*배송|무료\s*배송|품절\s*임박|한정\s*수량|이벤트|행사|베스트|인기\s*상품|판매\s*1위|강력\s*추천|대박|％|\bsale\b|\bhot\b)/i },
  { sev: 'claim', key: '효능/질병', re: /(치료|치유|완치|예방|효능|효과|항암|항염|소염|진통|혈압|혈당|당뇨|관절염|통증|염증\s*완화|면역력|노화\s*방지|디톡스|체지방\s*감소|개선|회복)/ },
  { sev: 'claim', key: '효능 문구', re: /(에\s*좋은|도움을?\s*줄|에\s*도움|에\s*필요한|에는\s)/ },   // K홀세일 상품명 실측('간에 좋은', '도움을 줄수있는', '장에는')
  { sev: 'block', key: '금지특수문자', re: /[※☆★♥♡▶◀◆■□【】〈〉「」『』]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
  { sev: 'block', key: 'URL/연락처', re: /(https?:\/\/|www\.|\.com|\.co\.kr|01[016-9][- ]?\d{3,4}[- ]?\d{4})/i },
  { sev: 'block', key: '타플랫폼', re: /(네이버|스마트\s*스토어|11번가|지마켓|g마켓|옥션|위메프|티몬|인터파크|아마존)/i },
]
function auditName(name) {
  const hits = NAME_RULES.map(r => { const m = name.match(r.re); return m ? { ...r, hit: m[0].trim() } : null }).filter(Boolean)
  if ([...name].length > MAX_TITLE_LEN) hits.push({ sev: 'block', key: '길이초과', hit: `${[...name].length}자` })
  return hits
}

function pickNoticeCategory(noticeCategories) {
  if (!noticeCategories || noticeCategories.length === 0) return null
  // '건강기능식품' 고시는 MFDS 인증 기능정보를 요구해 임시값으로 반려될 수 있음(2026-09-01 실측) → '가공식품' 우선(웰루트·77바이오와 동일)
  const preferred = ['가공식품', '건강기능식품']
  for (const p of preferred) { const f = noticeCategories.find(n => n.noticeCategoryName === p); if (f) return f }
  return noticeCategories[0]
}
const pickNotice = (info, re) => { if (!info) return null; const k = Object.keys(info).find(x => re.test(x)); return k ? String(info[k]).slice(0, 500) : null }
function buildNotices(noticeCategory, title, row) {
  if (!noticeCategory) return []
  const name = noticeCategory.noticeCategoryName
  const info = row.notice_info && typeof row.notice_info === 'object' ? row.notice_info : null
  const isImport = /직수입|수입/.test(`${title} ${row.brand_group ?? ''}`)
  const valueFor = (dn) => {
    if (/제품명|품명|품목/.test(dn)) return title
    if (/식품의\s*유형|식품유형/.test(dn)) return pickNotice(info, /식품의\s*유형|식품유형/) ?? '상세설명 참조'
    if (/생산자|제조업소|제조원|소재지|수입자/.test(dn)) return pickNotice(info, /제조(사|원|업소)/) ?? '상세설명 참조'
    if (/포장단위|용량.*중량|중량.*용량|내용량/.test(dn)) return row.spec || pickNotice(info, /용량|내용량/) || title
    if (/원재료/.test(dn)) return pickNotice(info, /원재료/) ?? '상세설명 참조'
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

// ── 판매가: 수집기 sale_prices 사용 + 하한 안전장치 ──
function priceFor(row, n) {
  const p = row.sale_prices?.[String(n)] ?? row.sale_prices?.[n]
  if (!p?.price) throw new Error(`판매가 미계산(${n}개) — kwholesale-collect.mjs 재실행 필요`)
  const floor = row.tiered_msp?.[String(n)] ?? (row.msp_price_krw ?? 0) * n
  // 하한 위반 = K홀세일 영구탈퇴·출고정지 사유 → 어떤 경우에도 등록하지 않는다
  if (!floor || p.price < floor) throw new Error(`판매가 ${p.price} < 최저판매가 ${floor} (${n}개) — 등록 중단`)
  return { qty: n, listPrice: p.price, msp: floor, margin: p.margin, marginPct: p.pct, ship: p.ship, basis: p.basis, fee: Math.round(p.price * FEE_RATE) }
}
// 변형 수량 — 하한이 정해진 수량만(tiered_msp 1·2·3). 없으면 1·2
function variantQtys(row, requested) {
  const t = row.tiered_msp && typeof row.tiered_msp === 'object' ? row.tiered_msp : null
  if (!t) return requested.slice(0, 2)
  const have = requested.filter(n => n === 1 || (typeof t[String(n)] === 'number' && t[String(n)] > 0))
  return have.length >= 2 ? have : requested.slice(0, 2)
}

function cleanTitle(row) {
  let t = String(row.title_clean || row.title || '')
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/최저가\s*제한[^|]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim()
  return t
}
// 브랜드 — 확실할 때만(미등록·타사 상표는 쿠팡이 거절 → 아래에서 브랜드 없이 1회 재시도)
function pickBrand(row) {
  const t = `${row.title ?? ''}`
  // 상품명에 적힌 브랜드가 우선 — 시트 브랜드그룹(wellers 등)은 제품 라인 분류라 틀릴 수 있다(위드바이오 MBP 가 wellers 그룹, 실측)
  if (/위드바이오/.test(t)) return '위드바이오'
  if (/웰러스/.test(t)) return '웰러스'
  if (/보령|종근당/.test(t)) return null   // 타사 상표 — 등록 안 된 브랜드는 쿠팡이 거절
  if (row.brand_group === 'wellers') return '웰러스'
  if (row.brand_group === '위드바이오') return '위드바이오'
  return null
}
const manufacturerOf = (row) => { const v = pickNotice(row.notice_info, /제조(사|원|업소)/); return v ? v.split('/')[0].trim().slice(0, 60) : '상세설명 참조' }

async function buildPayload(row, meta, categoryCode, categoryName, qtys = [1]) {
  const prices = qtys.map(n => priceFor(row, n))
  const price = prices[0]
  const title = cleanTitle(row)
  const noticeCategory = pickNoticeCategory(meta.noticeCategories)
  const notices = buildNotices(noticeCategory, title, row)

  // 이미지 — 대표 1장 + 상세(수집기가 판매자용 공지·홍보 배너·관련상품 썸네일을 이미 제외)
  const mains = Array.isArray(row.images_main) ? row.images_main : []
  const rep = row.thumb_url || mains[0]
  if (!rep) throw new Error('대표 이미지 없음')
  if (!(await downloadable(rep))) throw new Error(`대표 이미지 다운로드 실패: ${rep}`)
  const contentImgs = []
  for (const u of (Array.isArray(row.detail_images) ? row.detail_images : []).slice(0, 14)) {
    if (await downloadable(u)) contentImgs.push(u)
    if (contentImgs.length >= 10) break
  }
  if (contentImgs.length === 0) throw new Error('상세 이미지 없음/다운로드 실패 — 쿠팡 승인반려 대상이라 등록 보류')
  const items_images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: rep }]
  const contents = [
    ...contentImgs.map(u => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] })),
    { contentsType: 'TEXT', contentDetails: [{ content: PRIVACY_NOTICE, detailType: 'TEXT' }] },
  ]

  // 구매옵션은 시트 규격 우선(상품명은 효능·구성 문구가 섞여 오탐) — 규격이 비어 있을 때만 상품명에서 읽는다
  const spec = parseSpec(row.spec) ?? parseSpec(title)
  const items = qtys.map((n, i) => {
    const p = prices[i]
    const opt = buildPurchaseOptions(meta.attributes ?? [], spec, n)
    if (opt.error) throw new Error(`구매옵션 — ${opt.error} (규격 "${row.spec ?? ''}")`)
    const { attributes, itemName } = opt
    return {
      itemName,
      originalPrice: p.listPrice,   // 정가 = 판매가(부풀린 정가·가짜 할인 없음)
      salePrice: p.listPrice,
      maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: 2, unitCount: n, adultOnly: 'EVERYONE', taxType: 'TAX',
      parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
      externalVendorSku: qtys.length > 1 ? `${row.product_no}-${n}` : row.product_no,
      // 바코드: 단품만 제품 바코드(시트). 묶음은 단품 바코드를 쓰면 안 되므로 비움
      ...(row.barcode && n === 1 ? { barcode: row.barcode } : { emptyBarcode: true, emptyBarcodeReason: n > 1 ? '묶음 상품' : '바코드 없음' }),
      images: items_images, notices, attributes, contents, offerCondition: 'NEW',
    }
  })
  const payload = {
    vendorId: VENDOR_ID, sellerProductName: title, displayProductName: title,
    displayCategoryCode: categoryCode, ...(pickBrand(row) ? { brand: pickBrand(row) } : {}),
    generalProductName: title, productGroup: title.split(/\s+/).slice(0, 3).join(' '),
    manufacture: manufacturerOf(row), saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: DELIVERY_COMPANY, deliveryChargeType: 'FREE', deliveryCharge: 0,
    freeShipOverAmount: 0, deliveryChargeOnReturn: RETURN_CHARGE, remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY',
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
  if (!DRY) await sb.from(TABLE).update({ coupang_category_code: code, coupang_category_name: name, coupang_category_predicted_at: new Date().toISOString() }).eq('product_no', row.product_no)
  return { code, name, cached: false }
}

// ── 대상 선정 ────────────────────────────────────────────────────
const baseSel = sb.from(TABLE).select('*')
const { data: rows, error: qErr } = ONLY.length ? await baseSel.in('product_no', ONLY) : await baseSel.eq('coupang_eligible', true)
if (qErr) { console.error('대상 조회 실패:', qErr.message); process.exit(1) }
const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no, status').eq('source', SOURCE)
// FAILED 는 재시도 가능(SKIPPED 는 카테고리 제약이라 계속 막는다) — 웰루트와 동일
const existingSet = new Set((existing ?? []).filter(r => r.status !== 'FAILED').map(r => r.source_goods_no))

const skipped = []
const candidates = (rows ?? []).filter(r => {
  if (existingSet.has(r.product_no)) { skipped.push([r.product_no, '이미 등록됨']); return false }
  if (!r.coupang_eligible) { skipped.push([r.product_no, `등록 대상 아님(${r.excluded_reason ?? r.register_excluded_reason ?? '판촉·품절·중복·임박·제외 등'})`]); return false }
  if (r.is_sample || r.is_shop_only) { skipped.push([r.product_no, '판촉/시음·매장전용 — 판매 불가']); return false }
  if (SKIP_HGSIK && r.is_health_functional) { skipped.push([r.product_no, '건기식 제외(--skip-hgsik)']); return false }
  const hits = auditName(cleanTitle(r))
  const block = hits.find(h => h.sev === 'block')
  if (block) { skipped.push([r.product_no, `상품명 🚫 ${block.key}("${block.hit}")`]); return false }
  const claim = hits.find(h => h.sev === 'claim')
  if (claim && !ALLOW_CLAIMS) { skipped.push([r.product_no, `상품명 효능표현 ⚠ ${claim.key}("${claim.hit}") — 상품명 정리 후 등록(--allow-claims)`]); return false }
  return true
}).sort((a, b) => (b.sale_margin_pct ?? 0) - (a.sale_margin_pct ?? 0))
const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates

console.log(`=== K홀세일 → 쿠팡 등록 ${DRY ? '[DRY]' : ''}${NO_APPROVAL ? ' [승인요청 안 함]' : ''} ===`)
console.log(`대상 ${targets.length}건 (후보 ${candidates.length} · 제외 ${skipped.length} · 기등록 ${existingSet.size})`)
if (skipped.length) {
  const grouped = skipped.reduce((m, [no, why]) => { const k = why.replace(/\("[^"]*"\)/, '').replace(/\(.*\)$/, ''); (m[k] ??= []).push(no); return m }, {})
  for (const [why, nos] of Object.entries(grouped)) console.log(`  · ${why}: ${nos.length}건 (${nos.slice(0, 10).join(',')}${nos.length > 10 ? '…' : ''})`)
}
console.log('')
const summary = { success: 0, fail: 0, approved: 0, skip: 0, errors: [] }
const logDir = path.join(__dirname, '..', '_tmp_kwholesale_register')
if (!DRY && !existsSync(logDir)) mkdirSync(logDir, { recursive: true })

for (let i = 0; i < targets.length; i++) {
  const row = targets[i]
  const idx = `[${i + 1}/${targets.length}]`
  try {
    const title = cleanTitle(row)
    const cat = await resolveCategory(row, title)
    const meta = await getCategoryMeta(cat.code)
    const needBundle = meta.isAllowSingleItem === false || FORCE_BUNDLE
    const qtys = needBundle ? variantQtys(row, BUNDLE_QTYS) : [1]
    if (needBundle && qtys.length < 2) { console.log(`${idx} ⏭ ${row.product_no} [${cat.code}] ${title.slice(0, 32)} | 변형 2개 이상 필요 — SKIP`); summary.skip++; await sleep(300); continue }
    const noticeNames = (meta.noticeCategories ?? []).map(n => n.noticeCategoryName)
    if (!(noticeNames.includes('가공식품') || noticeNames.includes('건강기능식품'))) throw new Error(`비식품 카테고리(${noticeNames.join(',') || '고시없음'}) — 건강식품만 등록`)

    const built = await buildPayload(row, meta, cat.code, cat.name, qtys)
    if (DRY && args.includes('--show-payload') && i === 0) writeFileSync(path.join(process.env.TEMP || __dirname, `kwholesale-payload-${row.product_no}.json`), JSON.stringify(built.payload, null, 2))
    if (DRY) {
      const variants = built.prices.map(p => `${p.qty}개 ${p.listPrice.toLocaleString()}원(${p.basis === 'msp' ? '최저판매가' : '마진가'}, 마진 ${p.margin.toLocaleString()} ${p.marginPct}%)`).join(' · ')
      console.log(`${idx} (dry) ${String(row.product_no).padStart(4)} ${built.title.slice(0, 28).padEnd(28)} | 도매 ${String(row.wholesale_price_krw).padStart(6)} [${cat.code}${cat.cached ? '' : '*'} ${String(cat.name ?? '').slice(0, 14)}${needBundle ? ' 묶음' : ''}] 상세 ${built.contentCount}장 · 브랜드 ${built.payload.brand ?? '-'} · 바코드 ${row.barcode ? 'Y' : '-'}`)
      console.log(`        ${variants}`)
      console.log(`        옵션 ${built.payload.items.map(it => it.itemName).join(' / ')}  ← 규격 "${row.spec ?? ''}"`)
      continue
    }

    let r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    if (built.payload.brand && /브랜드.{0,3}ID가 필요/.test(JSON.stringify(r.body))) {
      console.log(`      ↻ 브랜드 "${built.payload.brand}" 미등록 — 브랜드 없이 재시도`)
      delete built.payload.brand
      await sleep(500)
      r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    }
    const success = r.status === 200 && r.body?.code === 'SUCCESS'
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null
    writeFileSync(path.join(logDir, `${row.product_no}.json`), JSON.stringify({ payload: built.payload, response: r.body }, null, 2), 'utf8')

    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: SOURCE,
      source_goods_no: row.product_no, source_detail_url: row.detail_url, registered_title: built.title,
      display_category_code: cat.code, display_category_name: cat.name, brand: built.payload.brand,
      dome_price_krw: row.wholesale_price_krw, source_shipping_fee_krw: built.price.ship, outbound_shipping_fee_krw: 0,
      msp_price_krw: row.msp_price_krw, list_price_krw: built.price.listPrice,
      estimated_fee_krw: built.price.fee, estimated_margin_krw: built.price.margin, estimated_margin_pct: built.price.marginPct,
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false,
      rejection_reason: success ? null : (r.body?.message ?? String(r.body).slice(0, 500)),
      request_payload: built.payload, last_response: r.body,
      registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    }
    const { data: inserted, error: insertErr } = await sb.from('jimscanner_coupang_listings').insert(listingRow).select('id').single()
    if (insertErr) {
      // 쿠팡엔 등록됐는데 DB 기록이 실패하면 추적 불가 → 승인요청하지 않는다(bio77·웰루트 공식)
      summary.fail++
      summary.errors.push({ no: row.product_no, title: built.title.slice(0, 36), reason: `listings insert 실패: ${insertErr.message}` })
      console.log(`${idx} ⚠ ${row.product_no} 등록 success=${success} 이나 DB insert 실패: ${insertErr.message}`)
      await sleep(500); continue
    }
    if (!success) {
      summary.fail++
      const reason = String(r.body?.message ?? JSON.stringify(r.body)).slice(0, 150)
      summary.errors.push({ no: row.product_no, title: built.title.slice(0, 36), cat: cat.code, reason })
      console.log(`${idx} ✗ ${row.product_no} [${cat.code}] ${built.title.slice(0, 30)} | ${reason}`)
      await sleep(500); continue
    }
    summary.success++
    console.log(`${idx} ✓ ${row.product_no} ${built.title.slice(0, 30).padEnd(30)} | ${built.qtys.length > 1 ? built.qtys.length + '변형 ' : ''}${built.price.listPrice.toLocaleString()}원 (${built.price.marginPct}%) sellerPID=${sellerProductId}`)

    if (!NO_APPROVAL && sellerProductId) {
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
        console.log('      → 승인요청 완료 (PENDING_APPROVAL) — 승인 후 재고는 coupang-followup-approvals.mjs --source=kwholesale')
      } else {
        // 응답이 에러여도 쿠팡에선 이미 심사중·승인완료인 경우가 있다(타임아웃 504, "IN_REVIEW by seller gating").
        // TEMPORARY_SAVE 로 남기면 재고 크론(PENDING_APPROVAL 만 폴링)이 영영 안 봐서 승인돼도 재고 0으로 방치된다
        // → 실제 상태를 다시 읽어 임시저장이 아니면 요청된 것으로 기록한다(2026-09-27 첫 등록 411·230).
        await sleep(3000)
        const cur = (await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)).body?.data?.statusName ?? ''
        if (cur && !/임시저장/.test(cur)) {
          await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', approval_status_name: cur, last_synced_at: new Date().toISOString() }).eq('id', inserted.id)
          summary.approved++
          console.log(`      → 승인요청 응답은 오류지만 쿠팡 상태 '${cur}' → PENDING_APPROVAL 기록 (${JSON.stringify(appr.body).slice(0, 90)})`)
        } else {
          console.log(`      → 승인요청 실패: ${JSON.stringify(appr.body).slice(0, 150)}`)
          await sb.from('jimscanner_coupang_listings').update({ rejection_reason: `승인요청 실패: ${JSON.stringify(appr.body).slice(0, 300)}`, last_synced_at: new Date().toISOString() }).eq('id', inserted.id)
        }
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
