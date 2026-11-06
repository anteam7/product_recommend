#!/usr/bin/env node
/**
 * 도매아토즈(삼일유통) → 쿠팡 등록 — 1 상품(idx) = 1 쿠팡 상품(단일 item). docs/plan-domeatoz.md P2 (2026-10-26)
 *   node scripts/domeatoz-register.mjs --dry [--only=3087174,2863414] [--limit=N] [--no-approval] [--show-payload] [--no-market]
 *
 *  - 대상: jimscanner_domeatoz_products active · 자동제외 없음 · register_excluded=false · 시세 조회됨 · 판정 OK
 *    (판정은 저장된 시세 요약으로 재현: 기준 = market_p25 ?? market_low → lib/domeatoz-price.mjs decide). STRUCTURAL·NO_MATCH 는 등록 안 함.
 *    시세 조회(domeatoz-market.mjs)가 뒤에서 돌며 OK 가 늘어나므로 register-drip.sh 로 회차마다 새 OK 를 이어 붙인다(사장님 2026-10-26 "확인된 것 먼저, 확인될 때마다 추가").
 *  - --no-market: 시세 미조회·NO_MATCH·STRUCTURAL 도 목표가(순마진 10%)로 등록(decideNoMarket, OK 는 시세가 그대로·먼저).
 *    사장님 2026-10-30 "시세조회하지말고 등록해" — 3분 1검색 시세 대조가 느려 등록이 멈추는 게 더 나쁘다.
 *  - 묶음 수 변형(… x 2개 / x 6개)은 도매아토즈에서 각각 다른 상품이라 쿠팡도 따로 올린다 — 하나로 묶으면 나중에 확인된 변형을 붙일 때
 *    판매중 상품 수정(임시저장 강등)이 필요하고, 주문↔매입 연결(listings.source_goods_no = idx)도 깨진다.
 *  - 가격: decide().price = clamp(목표 10%, 하한 7%·2,000원, 기준 시세 −1%). 원가 = 도매가 + 배송비(주문 1건당 3,000).
 *  - 카테고리: categorization/predict(DB 캐시) → 고시는 '가공식품' 우선(식품 아닌 카테고리면 보류). brand 는 기본 생략([[coupang_register_gotchas]] — 상품명 앞 브랜드로 충분), 브랜드 필수 카테고리 거절 때만 브랜드 사전 검색으로 채워 재시도.
 *  - 구매옵션: lib/domeatoz-spec.mjs purchaseSpecOf(상품명) → lib/coupang-purchase-options.mjs ("142g 5개" → 개당 중량 142g · 수량 5개). 용량 없는 이름은 보류.
 *  - 이미지: 대표 = thumb_url(500px 미만이면 패딩 후 site-assets), 상세 = detail_images(esmplus, 공통 배너는 수집기가 제외) — 원본 detail_html 은 쓰지 않는다.
 *  - 기록: jimscanner_coupang_listings 1행(source 'domeatoz', source_goods_no = idx). 승인 후 재고는 coupang-followup-approvals.mjs --source=domeatoz.
 *  - 일반 상품(2026-11-06, 식품 밖 — 다른 공급사 상품을 domeatoz-adopt.mjs 로 받은 것): 고시 = 분류별(의류·가방·자동차용품·주방용품) → '기타 재화',
 *    필수 속성 = 옵션 축(색상/사이즈)·상품명(수량 "10개"·길이 "80cm")·없으면 색상 '혼합색상'/사이즈 'FREE', 수치를 못 읽으면 보류.
 *    옵션 1개 = item 1개(판매 옵션만, 옵션별 추가금 반영) + jimscanner_listing_items 매핑. 판매 옵션 10개 초과는 제외(사장님 2026-11-06 "옵션이 많은 상품은 제외해").
 */
import crypto from 'node:crypto'
import sharp from 'sharp'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { decide, decideNoMarket, COUPANG_FEE } from './lib/domeatoz-price.mjs'
import { purchaseSpecOf, specOf } from './lib/domeatoz-spec.mjs'
import { buildPurchaseOptions } from './lib/coupang-purchase-options.mjs'
import { fillSearchTags } from './lib/search-tags.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID, ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const TABLE = 'jimscanner_domeatoz_products', SOURCE = 'domeatoz'
// 출고지·반품지 — 기존 매입처와 동일(campingmoon/kwholesale-register.mjs 와 이중관리 지점)
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717, RETURN_CENTER_CODE = '1002609354', RETURN_CHARGE_NAME = '신사로 반품', RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8', RETURN_ADDRESS_DETAIL = '301', RETURN_ZIP_CODE = '08703', COMPANY_CONTACT = '010-4164-3802'
const DELIVERY_COMPANY = 'CJGLS' // 기본 택배사 — 실제 송장 택배사는 송장 등록 때 따로 넘긴다
// 도매아토즈 위탁은 주문 → 도매아토즈 발주(적립금) → 공급사 출고라 하루가 더 걸린다(결제진행 자동화 P3 전에는 수동 발주)
const OUTBOUND_DAYS = 3
const MAX_TITLE_LEN = 100
const PRIVACY_NOTICE = '[개인정보 처리 위탁 안내] 이 상품은 공급사에서 직접 발송됩니다. 배송을 위해 주문 시 입력하신 수령인 정보(이름·연락처·주소)가 공급사에 전달됩니다. 제주·도서산간 지역은 배송이 제한될 수 있습니다.'

const args = process.argv.slice(2)
const DRY = args.includes('--dry'), NO_APPROVAL = args.includes('--no-approval'), NO_MARKET = args.includes('--no-market')
const argOf = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const LIMIT = +(argOf('limit') || 0) || 0
const ONLY = (argOf('only') || '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,9}$/.test(s))
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

// ── 상품명 검사(coupang-name-audit RULES 요약 — campingmoon-register.mjs 와 같은 규칙) ──
const NAME_RULES = [
  // '행사'는 판촉 문맥만(할인행사·행사상품·행사중) — "행사용 신발커버"·"PVC 행사 목걸이"처럼 용도를 말하는 이름이 막히던 것(2026-11-06)
  { key: '광고성', re: /(최저가|초특가|특가|핫딜|세일|할인|사은품|무료\s*증정|1\s*\+\s*1|당일\s*발송|당일\s*배송|무료\s*배송|품절\s*임박|한정\s*수량|이벤트|행사\s*(?:상품|중|가(?![a-z가-힣])|진행)|(?:특가|기획|감사|오픈)\s*행사)/ },
  { key: '금지특수문자', re: /[※☆★♥♡▶◀◆■□【】〈〉「」『』]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
  { key: 'URL/연락처', re: /(https?:\/\/|www\.|\.com|\.co\.kr|01[016-9][- ]?\d{3,4}[- ]?\d{4})/i },
  { key: '타플랫폼', re: /(네이버|스마트\s*스토어|11번가|지마켓|g마켓|옥션|위메프|티몬|인터파크|아마존)/i },
]
const nameBlock = (name) => { for (const r of NAME_RULES) { const m = name.match(r.re); if (m) return `${r.key}("${m[0].trim()}")` } return [...name].length > MAX_TITLE_LEN ? `길이초과(${[...name].length}자)` : null }
const cleanTitle = (row) => String(row.name_clean || row.name_raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN).trim()

// ── 고시: 식품 고시만(가공식품 우선). 건강기능식품 고시는 MFDS 인증 정보를 요구해 쓰지 않는다(wellroot-register.mjs 실측) ──
const FOOD_NOTICES = ['가공식품', '축산물', '농수산물', '농산물', '수산물']
const pickNoticeCategory = (ncs) => { for (const n of FOOD_NOTICES) { const f = (ncs ?? []).find((x) => x.noticeCategoryName === n); if (f) return f } return null }
const specText = (spec) => (!spec ? null : spec.mode === 'count' ? `${spec.pieces}개` : `${spec.weightG != null ? `${spec.weightG}g` : `${spec.volumeMl}ml`}${spec.mode === 'piece' ? ` x ${spec.pieces}개` : ''}`)
function fillNotice(dn, title, row, spec) {
  const imported = row.overseas === 'Y' || /^대상$|수입/.test(String(row.notice?.['수입품'] ?? '').replace(/대상아님/, ''))
  const maker = row.maker && row.maker !== '기타' ? row.maker : null
  if (/제품명|품명/.test(dn)) return title
  if (/포장단위|용량|중량|수량/.test(dn)) return specText(spec) || title
  if (/유전자변형|GMO/.test(dn)) return '해당없음'
  if (/수입/.test(dn)) return imported ? '수입식품에 해당하며 한글표시사항을 별도 부착함' : '해당없음'
  if (/상담|전화/.test(dn)) return COMPANY_CONTACT
  if (/생산자|제조자|제조업소|소재지/.test(dn)) return maker ? `${maker} (소재지는 상세설명 참조)` : '상세설명 참조'
  if (/주의|안전/.test(dn)) return '직사광선을 피하고 서늘한 곳에 보관하시기 바랍니다. 알레르기 체질은 원재료를 확인 후 섭취하시기 바랍니다.'
  return '상세설명 참조'
}
const buildNotices = (nc, title, row, spec) => (nc.noticeCategoryDetailNames ?? []).filter((d) => d.required === 'MANDATORY').map((d) => ({ noticeCategoryName: nc.noticeCategoryName, noticeCategoryDetailName: d.noticeCategoryDetailName, content: fillNotice(d.noticeCategoryDetailName, title, row, spec) }))

// ── 일반 상품(식품 밖, domeatoz-adopt.mjs 로 받은 다른 공급사 상품) ──
const MAX_OPTIONS = 10 // 판매 옵션 10개 초과 제외 — 사장님 2026-11-06 "옵션이 많은 상품은 제외해"(반팔티 색상×사이즈 44개)
const isFoodRow = (row) => row.group_1 === '식품'
// 고시: 도매아토즈 분류(중·소·세분류·상품명)로 맞는 고시 → '기타 재화' → 전기·어린이·화학 등이 아닌 첫 고시(campingmoon-register 와 같은 취지)
const GENERAL_NOTICE_PREF = [[/의류|티셔츠|셔츠|바지|점퍼|조끼|원피스|니트|코트|자켓|재킷/, '의류'], [/가방|백팩|크로스백|파우치|지갑/, '가방'], [/자동차/, '자동차용품'], [/주방|조리|식기/, '주방용품'], [/신발|운동화|구두/, '구두/신발'], [/스포츠|레저|캠핑|등산|낚시/, '스포츠용품']]
const NOT_GENERAL_NOTICE = /전기|전자|어린이|화학|살생물|의료|화장품|가공식품|건강기능|축산|농|수산|영상가전|사무용기기|가구/
function pickGeneralNotice(ncs, row) {
  const g = [row.group_2, row.group_3, row.group_4, row.name_clean].filter(Boolean).join(' ')
  for (const [re, name] of GENERAL_NOTICE_PREF) if (re.test(g)) { const f = (ncs ?? []).find((n) => n.noticeCategoryName.startsWith(name)); if (f) return f }
  return (ncs ?? []).find((n) => n.noticeCategoryName === '기타 재화') || (ncs ?? []).find((n) => !NOT_GENERAL_NOTICE.test(n.noticeCategoryName)) || null
}
// 도매아토즈 고시 항목 순서(가이드 noticeCategory.xlsx — 실측: 1 의류 · 3 가방). 그 밖 고시는 값을 쓰지 않는다(순서 미확인)
const DZ_NOTICE_KEYS = { 1: ['소재', '색상', '치수', '제조자', '세탁', '제조연월', '품질보증', 'AS'], 3: ['종류', '소재', '색상', '크기', '제조자', '취급', '품질보증', 'AS'] }
const NOTICE_PLACEHOLDER = /상세(정보|페이지|설명)|별도\s*표기|참조|^\s*$/
function dzNotice(row, key) {
  const keys = DZ_NOTICE_KEYS[row.notice?.code], i = keys ? keys.indexOf(key) : -1
  const v = i >= 0 ? String(row.notice?.items?.[i] ?? '').trim() : ''
  return v && !NOTICE_PLACEHOLDER.test(v) ? v.slice(0, 200) : null
}
/** 도매아토즈 원산지 표기("국외|아시아|중국"·"국내|강원|강릉시"·"국내산"·"MADE IN Malaysia") → 제조국 */
function originText(s) {
  const t = String(s ?? '').trim()
  if (!t || /국내외|상세/.test(t)) return '상세설명 참조'
  if (/^국내|국내산|대한민국|^한국/.test(t)) return '대한민국'
  const parts = t.split('|').map((x) => x.trim()).filter(Boolean)
  return (parts[parts.length - 1] || '').replace(/^made\s+in\s*/i, '') || '상세설명 참조'
}
const sizeFromTitle = (t) => { const m = String(t).match(/(\d+(?:\.\d+)?)\s*(mm|cm|m|인치)(?![a-z가-힣])/i); return m ? `${m[1]}${m[2]}` : null }
const setCountOf = (t) => { const m = String(t).match(/(\d{1,3})\s*(?:개|p|pcs|매|입|세트|팩)(?![a-z가-힣])/i); const n = m ? Number(m[1]) : 1; return n >= 1 && n <= 500 ? n : 1 }
// 색상 필수인데 옵션에 색상이 없을 때: 상품명 색상어 → 재질 추정 → '혼합색상'(쿠팡 표준값, '단일색상'은 거절 — campingmoon-register 실측 2026-10-14)
const COLOR_WORDS = [['블랙', /블랙|검정|검은/], ['화이트', /화이트|흰색|백색/], ['그레이', /그레이|회색/], ['실버', /실버|은색|스텐|스테인리스|알루미늄|메탈/], ['우드', /우드|원목/], ['브라운', /브라운|갈색/], ['베이지', /베이지/], ['네이비', /네이비|남색/], ['블루', /블루|파랑/], ['그린', /그린|초록/], ['레드', /레드|빨강/], ['핑크', /핑크|분홍/], ['옐로우', /옐로우|노랑/], ['골드', /골드|금색/], ['투명', /투명|클리어/]]
const colorFromTitle = (title) => (COLOR_WORDS.find(([, re]) => re.test(title || '')) || [])[0] || '혼합색상'
const pickUnit = (units, prefs) => { if (!units?.length) return ''; for (const x of prefs) if (units.includes(x)) return x; return units[0] }
function fillGeneralNotice(dn, title, row, ctx) {
  if (/품명|모델명|제품명/.test(dn)) return row.model_name ? `${title} (${row.model_name})` : title
  if (/종류/.test(dn)) return dzNotice(row, '종류') || row.group_3 || '상세설명 참조'
  if (/소재|재질/.test(dn)) return dzNotice(row, '소재') || '상세설명 참조'
  if (/색상/.test(dn)) return ctx.colors || dzNotice(row, '색상') || '상세설명 참조'
  if (/치수|크기|사이즈/.test(dn)) return ctx.sizes || dzNotice(row, '치수') || dzNotice(row, '크기') || sizeFromTitle(title) || '상세설명 참조'
  if (/제조국|원산지/.test(dn)) return originText(row.origin)
  if (/제조자|수입자|제조사/.test(dn)) return row.maker && row.maker !== '기타' ? row.maker : '상세설명 참조'
  if (/세탁|취급/.test(dn)) return dzNotice(row, '세탁') || dzNotice(row, '취급') || '상세설명 참조'
  if (/제조연월|출시/.test(dn)) return dzNotice(row, '제조연월') || '상세설명 참조'
  if (/품질보증/.test(dn)) return '관련 법 및 소비자분쟁해결기준에 따름'
  if (/A\/?S|전화|상담|책임자/.test(dn)) return COMPANY_CONTACT
  if (/수입.*(기구|용기)|식품위생/.test(dn)) return originText(row.origin) === '대한민국' ? '해당없음(국내 제조)' : '상세설명 참조'
  if (/인증|허가|KC/.test(dn)) return '해당사항 없음' // KC 의심 상품은 domeatoz-adopt.mjs 가 받지 않는다
  return '상세설명 참조'
}
/** 도매아토즈 옵션 한 줄(itemName [1차, 2차]) → {color, size, raw}. 색상·사이즈가 아닌 축('타입'·'종류'·'선택'·'수량'·'용량' 등)의 값은 raw 로 모아
 *  buildGeneralAttributes 가 수치 속성(수량·용량)에 먼저 쓰고, 남으면 사이즈 → 그 밖 노출 문자 속성 → 색상 순으로 넣는다(campingmoon-register 와 같은 취지, 2026-11-06 — 10건이 축 이름만으로 제외됐다) */
function optionAxesOf(row, o) {
  const names = row.options?.optionName ?? [], vals = o?.itemName ?? []
  const out = { color: null, size: null, raw: null }
  const rest = []
  for (let i = 0; i < names.length; i++) {
    const nm = String(names[i] || '').trim(), v = String(vals[i] || '').trim()
    if (!v) continue
    if (/색상|컬러|색/.test(nm)) out.color = v
    else if (/사이즈|크기|size/i.test(nm)) out.size = v
    else rest.push(v)
  }
  if (rest.length) out.raw = rest.join(' ').replace(/^\s*\d{1,2}\s*\)\s*|^\s*\d{1,2}\.\s+(?!\d)/, '').trim() || null // "01) A형" → "A형"
  return out
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 수치 속성 값 "{숫자}{단위}" 를 text 에서 — 단위는 쿠팡 허용 단위만(긴 것 먼저) */
function numberAttrFrom(text, units) {
  const unitAlt = [...units].sort((x, y) => y.length - x.length).map(escRe).join('|')
  const m = String(text || '').match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitAlt})(?![a-z가-힣])`, 'i'))
  return m ? `${m[1]}${units.find((u) => u.toLowerCase() === m[2].toLowerCase()) || m[2]}` : null
}
/** item 필수 속성 — 옵션 축·상품명에서 채우고, 수치를 못 읽으면 {error}(지어내지 않는다) */
function buildGeneralAttributes(meta, row, ax, title) {
  const mand = (meta.attributes ?? []).filter((a) => a.required === 'MANDATORY')
  const isSize = (a) => /사이즈|크기/.test(a.attributeTypeName) && a.dataType !== 'NUMBER'
  const isColor = (a) => /색상|컬러/.test(a.attributeTypeName)
  // 판매 단위 수 '수량'·'총 수량'만 — '개당 수량'(묶음 안 낱개 수, 단위 개입)은 일반 수치 속성으로 읽는다(못 읽으면 제외, 2026-11-06 '1개입' 지어내던 것)
  //   쿠팡 속성명 실측(메타 캐시 517개): 수량 455·총 수량 217·팩 수량·박스 수량 = 판매 단위 / 개당 수량 76·팩당 수량 53·총 캡슐/정 수량·박스 내 패키지 수량·서빙 수량 = 묶음 안
  const PER_UNIT_COUNT = /개당|팩당|박스\s*내|캡슐|서빙/
  const isCount = (a) => { const n = String(a.attributeTypeName ?? ''); return /수량/.test(n) && !PER_UNIT_COUNT.test(n) && a.dataType === 'NUMBER' }
  const hasPerPack = mand.some((a) => /(개당|팩당)\s*수량/.test(String(a.attributeTypeName ?? '')))
  // 일반 축 값(raw)이 수치 속성(수량 "16개"·용량 "500ml")으로 읽히면 그걸로 옵션이 구분된다. 아니면 넣을 속성을 하나 고른다
  let rawUsed = !ax.raw
  const fromRaw = new Map()
  if (ax.raw) for (const a of mand) {
    if (a.dataType !== 'NUMBER' || !a.usableUnits?.length) continue
    // 수량(판매 단위 수)은 옵션 값이 개수 그 자체("2개"·"3세트")일 때만 — "8롤(120매)+디스펜서" 의 120 은 한 묶음 안의 매수(개당 수량)다(2026-11-06 dry: 수량=120개 오기입)
    const v = isCount(a) ? (/^\s*\d{1,3}\s*(?:개|p|pcs|ea|세트|팩)\s*$/i.test(ax.raw) ? `${setCountOf(ax.raw.replace(/ea$/i, '개'))}${pickUnit(a.usableUnits, ['개', '세트', '팩', '박스'])}` : null) : numberAttrFrom(ax.raw, a.usableUnits)
    if (v) { fromRaw.set(a.attributeTypeName, v); rawUsed = true }
  }
  // 색 같은 값("색상랜덤"·"브라운")은 색상으로, 그 밖은 사이즈 → 노출 문자 속성(모델명·품번 제외 — "색상랜덤"이 모델명에 들어가던 것) → 색상
  const colorish = ax.raw && (/색상|컬러|랜덤/.test(ax.raw) || COLOR_WORDS.some(([, re]) => re.test(ax.raw)))
  // 사이즈 속성이 있으면 값 전체는 사이즈로("브라운38-39"), 색은 색상어만 색상으로 — 사이즈가 없을 때만 색 같은 값을 색상에
  const rawTarget = rawUsed ? null
    : ((colorish && !ax.color && !mand.some(isSize) ? mand.find(isColor) : null) ?? mand.find(isSize) ?? mand.find((a) => a.dataType === 'STRING' && a.exposed === 'EXPOSED' && !isColor(a) && !/모델|품번/.test(a.attributeTypeName)) ?? mand.find(isColor))?.attributeTypeName ?? null
  if (!rawUsed && !rawTarget) return { error: `옵션 값 '${ax.raw}'을 넣을 쿠팡 속성이 없음` }
  const out = []
  for (const a of mand) {
    const nm = a.attributeTypeName, exposed = a.exposed === 'EXPOSED' ? 'EXPOSED' : 'NONE'
    let v
    if (fromRaw.has(nm)) v = fromRaw.get(nm)
    else if (nm === rawTarget) v = ax.raw
    // 개당 수량이 따로 있으면 이름의 "10개입"은 그쪽 몫 — 판매 단위는 1(안 그러면 10개입 × 10개로 읽힌다)
    else if (isCount(a)) v = `${hasPerPack ? 1 : setCountOf(title)}${pickUnit(a.usableUnits, ['개', '세트', '팩', '박스'])}`
    else if (isColor(a)) v = ax.color || (ax.raw && COLOR_WORDS.some(([, re]) => re.test(ax.raw)) ? colorFromTitle(ax.raw) : colorFromTitle(title)) // "브라운38-39" → 브라운
    else if (isSize(a)) v = ax.size || sizeFromTitle(title) || 'FREE'
    else if (a.dataType === 'NUMBER' && a.usableUnits?.length) {
      v = numberAttrFrom(title, a.usableUnits)
      if (!v) return { error: `필수 수치 속성 '${nm}'(${a.usableUnits.join('/')}) 값을 상품명에서 못 읽음` }
    } else if (a.dataType === 'STRING') {
      const titleModel = String(title).match(/(?<![A-Za-z0-9])([A-Z]{1,5}-?\d{2,}[A-Z0-9-]*)(?![A-Za-z0-9])/)?.[1] // "엑토 노트북잠금장치 NBL-04" → NBL-04
      if (/모델|품번/.test(nm) && (row.model_name || titleModel)) v = row.model_name || titleModel
      // 노출 속성(구매옵션)에 '상세설명 참조'를 넣으면 쿠팡이 "허용되지 않는 구매옵션 값"으로 거절(2026-11-06 차종·적용모델 2건) — 지어내지 않고 제외
      else if (exposed === 'EXPOSED') return { error: `노출 속성 '${nm}' 값을 정할 수 없음` }
      else v = '상세설명 참조'
    } else return { error: `필수 속성 '${nm}'(${a.dataType}) 처리 규칙 없음` }
    // 선택형(SELECT) 속성은 쿠팡 허용값만 — 신발사이즈(218개 값)에 'FREE'·"38-39"를 넣으면 거절된다(2026-11-06 dry)
    if (a.inputType === 'SELECT' && a.inputValues?.length && !a.inputValues.includes(String(v))) return { error: `선택형 속성 '${nm}'에 '${String(v).slice(0, 20)}' 값 없음(쿠팡 허용값 ${a.inputValues.length}개)` }
    out.push({ attributeTypeName: nm, attributeValueName: String(v).slice(0, 30), exposed })
  }
  return { attributes: out }
}

const BUCKET = 'site-assets', IMG_MIN = 500, IMG_MAX = 5000
/** 쿠팡 대표 이미지 규격(최소 500x500·최대 5000x5000·10MB) 보정 — campingmoon-register.mjs 와 같은 규칙. DRY 는 업로드 없이 원본 URL */
async function ensureImageSpec(url, key) {
  let r
  try { r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) }) } catch (e) { throw new Error(`대표 이미지 다운로드 실패: ${url} (${e.message})`) }
  if (r.status !== 200 || !/image\//.test(r.headers.get('content-type') || '')) throw new Error(`대표 이미지 다운로드 실패: ${url} (${r.status})`)
  const buf = Buffer.from(await r.arrayBuffer())
  let m
  try { m = await sharp(buf).metadata() } catch { throw new Error(`대표 이미지 해석 실패: ${url}`) }
  if (m.width >= IMG_MIN && m.height >= IMG_MIN && m.width <= IMG_MAX && m.height <= IMG_MAX && buf.length <= 10 * 1024 * 1024) return url
  const small = m.width < IMG_MIN || m.height < IMG_MIN
  const out = await (small ? sharp(buf).resize(IMG_MIN, IMG_MIN, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }) : sharp(buf).resize(IMG_MAX, IMG_MAX, { fit: 'inside' })).jpeg({ quality: 92 }).toBuffer()
  console.log(`  ℹ 대표 이미지 ${m.width}x${m.height} → ${small ? '500x500 패딩' : '5000 이내 축소'} 후 site-assets 업로드${DRY ? ' (dry: 생략)' : ''}`)
  if (DRY) return url
  const up = await sb.storage.from(BUCKET).upload(`${key}.jpg`, out, { contentType: 'image/jpeg', upsert: true })
  if (up.error) throw new Error(`대표 이미지 업로드 실패: ${up.error.message}`)
  return sb.storage.from(BUCKET).getPublicUrl(`${key}.jpg`).data.publicUrl
}
// 브랜드 필수 카테고리(프로틴바 102553 등)는 brand 생략 시 "브랜드 정보가 필요합니다. 올바른 Brand ID와 Brand Name을 입력해 주세요"(2026-10-26 실측).
// 그 오류일 때만 상품명 첫 토큰을 브랜드 사전(POST /brands/search)에서 공백·대소문자 무시 완전일치로 찾아 brandId+이름, 없으면 이름만(coupang-reapprove-rejected.mjs resolveBrand 와 같은 규칙)
const BRAND_REQUIRED = /브랜드 정보가 필요|Brand ID와 Brand Name/
const normBrand = (s) => (s || '').replace(/\s+/g, '').toLowerCase()
const firstToken = (name) => (name || '').trim().split(/\s+/)[0] || ''
/**
 * 쿠팡 같은 상품 표기의 낱개 중량·용량 — 시세 조회가 남긴 규격 일치 상위 3건(market_top3 m:true) 중 같은 브랜드·같은 개수인 제목.
 * 서로 ±5% 안에서 맞는 값이 2건 이상일 때만 그 값(가장 많이 맞는 값, 동률이면 작은 값) — 판매자 오기("54.907kg")는 혼자라 빠진다.
 * 예 "남양 프렌치카페 카페믹스 50T, 1개, 50개입, 11g" · "… 11.1g" · "… 54.907kg" → 11g
 */
function unitMeasureFromMarket(row, pieces) {
  const brand = normBrand(firstToken(row.name_clean))
  const vals = (row.market_top3 || [])
    .filter((t) => t.m && brand && normBrand(t.title).includes(brand))
    .map((t) => specOf(t.title))
    .filter((s) => !s.set && s.vol && s.count === pieces)
    .map((s) => s.vol)
  if (vals.length < 2 || new Set(vals.map((x) => x.u)).size > 1) return null
  const nums = vals.map((x) => x.v)
  const near = (v) => nums.filter((w) => w >= v * 0.95 && w <= v * 1.05).length
  const ranked = nums.map((v) => [v, near(v)]).sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const [v, n] = ranked[0]
  // 다른 중량 묶음이 같은 건수로 맞서면(11g 2건 vs 22g 2건) 어느 쪽인지 모르므로 보류
  if (ranked.some(([w, m]) => m === n && (w < v * 0.95 || w > v * 1.05))) return null
  return n >= 2 ? { v, u: vals[0].u } : null
}
const brandCache = new Map()
async function resolveBrand(name) {
  const key = firstToken(name)
  if (!key) return null
  if (brandCache.has(key)) return brandCache.get(key)
  const r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/brands/search', { brandName: key, countPerPage: 10, page: 1 })
  const hit = (Array.isArray(r.body?.data?.items) ? r.body.data.items : []).find((it) => normBrand(it.brandName) === normBrand(key)) || null
  brandCache.set(key, hit)
  return hit
}
/** 승인반려 사유 — 쿠팡 셀러 시스템 코멘트는 상품 GET 에 없고 histories 에만 있다 */
async function rejectComment(spid) {
  try { const h = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}/histories`); return (h.body?.data ?? []).find((x) => /반려/.test(x.statusName || '') && x.comment)?.comment || null } catch { return null }
}

// 상세 이미지 표시사항에서 읽은 낱개 규격(domeatoz-spec-from-images.mjs — 이미지 글자·이름 개수로 검증된 것만, rejected 는 못 쓴 응답)
const UNIT_SPEC = (() => { try { return JSON.parse(readFileSync(path.join(__dirname, 'lib', 'domeatoz-unit-spec.json'), 'utf8')) } catch { return {} } })()
function imageSpecOf(idx) {
  const u = UNIT_SPEC[idx]
  if (!u || u.rejected || !(u.per > 0) || !(u.pieces >= 1) || !['g', 'ml'].includes(u.unit)) return null
  const weightG = u.unit === 'g' ? u.per : null, volumeMl = u.unit === 'ml' ? u.per : null
  return u.pieces > 1 ? { mode: 'piece', weightG, volumeMl, pieces: u.pieces, perPack: u.pieces, packs: 1 } : { mode: 'single', weightG, volumeMl, packs: 1 }
}

/** 대표 이미지(규격 보정) + 상세 이미지(내려받기 되는 것만, 없으면 추가 이미지 → 대표) — 식품·일반 공용 */
async function pickImages(row) {
  const imgs = Array.isArray(row.images) ? row.images.filter(Boolean) : []
  const repCands = [...new Set([row.thumb_url, ...imgs].filter(Boolean))].slice(0, 5)
  if (!repCands.length) throw new Error('대표 이미지 없음')
  // 404·410 = 공급사가 지운 이미지 → 다음 이미지로. 전부 지워졌으면 결정적 실패(제외) — 일시 장애로 세면 매 회차 같은 건에서 멈춘다(2026-10-30 858건 정지)
  let rep = null
  for (const u of repCands) {
    try { rep = await ensureImageSpec(u, `domeatoz/${row.idx}/rep`); break } catch (e) { if (!/\((404|410)\)$/.test(e.message)) throw e }
  }
  if (!rep) throw new Error(`대표 이미지 없음 — 공급사 이미지 ${repCands.length}장 모두 404`)
  const contentImgs = []
  for (const u of (Array.isArray(row.detail_images) ? row.detail_images : []).slice(0, 10)) if (typeof u === 'string' && await downloadable(u)) contentImgs.push(u)
  // 상세 이미지가 없으면 추가 이미지 → 대표 이미지 순으로 채운다 — 쿠팡은 상세 1장 이상 필수(없으면 승인반려)
  if (!contentImgs.length) for (const u of imgs.slice(1, 5)) if (await downloadable(u)) contentImgs.push(u)
  if (!contentImgs.length) { console.log('  ℹ 상세 이미지 없음 → 대표 이미지를 상세로 사용'); contentImgs.push(rep) }
  const contents = [...contentImgs.map((u) => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] })), { contentsType: 'TEXT', contentDetails: [{ content: PRIVACY_NOTICE, detailType: 'TEXT' }] }]
  return { rep, contentImgs, contents }
}
const itemBase = (row, rep, notices, contents) => ({
  maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1, outboundShippingTimeDay: OUTBOUND_DAYS, unitCount: 1,
  adultOnly: 'EVERYONE', taxType: row.tax_type === '면세' ? 'FREE' : 'TAX', parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
  emptyBarcode: true, emptyBarcodeReason: '바코드 없음', images: [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: rep }], notices, contents, offerCondition: 'NEW',
})
const productPayload = (row, title, cat, items) => ({
  vendorId: VENDOR_ID, sellerProductName: title, displayProductName: title, displayCategoryCode: cat.code,
  generalProductName: title, productGroup: title.split(/\s+/).slice(0, 3).join(' '), manufacture: row.maker && row.maker !== '기타' ? row.maker : '상세설명 참조',
  saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
  deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: DELIVERY_COMPANY, deliveryChargeType: 'FREE', deliveryCharge: 0, freeShipOverAmount: 0, deliveryChargeOnReturn: RETURN_CHARGE,
  remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY', returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: COMPANY_CONTACT,
  returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL, returnCharge: RETURN_CHARGE, outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE,
  vendorUserId: 'anteam7', requested: false, items, notices: [], requiredDocuments: [],
})

/** 일반 상품 payload — 판매 옵션마다 item(옵션별 추가금 반영 목표가), 옵션 없으면 단품 item 1개. 실패는 '일반 상품 —' 접두(결정적 → 자동 제외) */
async function buildGeneralPayload(row, meta, cat) {
  const title = cleanTitle(row)
  const nc = pickGeneralNotice(meta.noticeCategories, row)
  if (!nc) throw new Error(`일반 상품 — 쓸 수 있는 고시 없음(${(meta.noticeCategories ?? []).map((n) => n.noticeCategoryName).join(',') || '고시없음'})`)
  const hasOpt = row.option_type === 'Y'
  const opts = hasOpt ? (row.options?.items ?? []).map((o, i) => ({ ...o, _k: i + 1 })).filter((o) => o.isSoldOut === 'Y') : [null]
  if (hasOpt && !opts.length) throw new Error('일반 상품 — 판매 옵션 없음(전부 품절)')
  if (opts.length > MAX_OPTIONS) throw new Error(`일반 상품 — 옵션 많음(판매 옵션 ${opts.length}개 > ${MAX_OPTIONS})`)
  const lines = []
  for (const o of opts) {
    const ax = o ? optionAxesOf(row, o) : { color: null, size: null }
    if (ax.error) throw new Error(`일반 상품 — ${ax.error}`)
    const attr = buildGeneralAttributes(meta, row, ax, title)
    if (attr.error) throw new Error(`일반 상품 — ${attr.error}`)
    const d = decideNoMarket(row.wholesale_price + (Number(o?.addPrice) || 0), row.delivery_price, [])
    if (!d.price) throw new Error('일반 상품 — 가격 계산 불가(도매가 없음)')
    lines.push({ o, ax, attributes: attr.attributes, d, label: o ? (o.itemName ?? []).filter(Boolean).join(' ') : '단품', sku: o ? `${SOURCE}:${row.idx}:o${o._k}` : `${SOURCE}:${row.idx}` })
  }
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].join(', ')
  const notices = (nc.noticeCategoryDetailNames ?? []).filter((x) => x.required === 'MANDATORY').map((x) => ({ noticeCategoryName: nc.noticeCategoryName, noticeCategoryDetailName: x.noticeCategoryDetailName, content: fillGeneralNotice(x.noticeCategoryDetailName, title, row, { colors: uniq(lines.map((l) => l.ax.color)), sizes: uniq(lines.map((l) => l.ax.size)) }) }))
  const { rep, contentImgs, contents } = await pickImages(row)
  const items = lines.map((l) => ({ itemName: l.label.slice(0, 100), originalPrice: l.d.price, salePrice: l.d.price, ...itemBase(row, rep, notices, contents), externalVendorSku: l.sku, attributes: l.attributes }))
  // 노출 속성 조합이 같은 item 2개는 쿠팡이 거절 — 옵션 축이 속성에 안 맞는 것
  const combos = items.map((it) => JSON.stringify(it.attributes.filter((a) => a.exposed === 'EXPOSED').map((a) => [a.attributeTypeName, a.attributeValueName])))
  if (new Set(combos).size !== combos.length) throw new Error('일반 상품 — 옵션 조합 중복(노출 속성이 같은 item 2개)')
  const cheapest = lines.reduce((m, l) => (l.d.price < m.d.price ? l : m), lines[0])
  return { payload: productPayload(row, title, cat, items), title, contentCount: contentImgs.length, noticeName: nc.noticeCategoryName, lines: hasOpt ? lines : null, d: cheapest.d }
}

async function buildPayload(row, meta, cat, d) {
  if (!isFoodRow(row)) return buildGeneralPayload(row, meta, cat)
  const title = cleanTitle(row)
  const nc = pickNoticeCategory(meta.noticeCategories)
  if (!nc) throw new Error(`식품 고시 없는 카테고리(${(meta.noticeCategories ?? []).map((n) => n.noticeCategoryName).join(',') || '고시없음'})`)
  const img = imageSpecOf(row.idx)
  // 세트 이름("딸기 192g + 사과 192g 각2개") 등 이름으로 규격을 못 만들면 상세 이미지 표시사항의 낱개 규격(2026-11-01)
  let spec = purchaseSpecOf(title) ?? img
  if (!spec) throw new Error('구매옵션 — 상품명에 용량(g·ml)·개수 없음')
  let opt = buildPurchaseOptions(meta.attributes ?? [], spec, 1)
  // 개수만 있는 이름("카페믹스 50T")인데 중량·용량 필수 카테고리 → 상세 이미지 표시사항의 낱개 중량(같은 개수일 때),
  // 없으면 쿠팡 같은 상품 표기의 낱개 중량을 따른다(사장님 2026-10-28)
  if (opt.error && spec.mode === 'count') {
    if (img && img.pieces === spec.pieces) spec = img
    else {
      const u = unitMeasureFromMarket(row, spec.pieces)
      if (!u) throw new Error(`구매옵션 — ${opt.error} · 상세 이미지·같은 브랜드 쿠팡 표기 중량 없음`)
      spec = { mode: 'piece', weightG: u.u === 'g' ? u.v : null, volumeMl: u.u === 'ml' ? u.v : null, pieces: spec.pieces, perPack: spec.pieces, packs: 1 }
    }
    opt = buildPurchaseOptions(meta.attributes ?? [], spec, 1)
  }
  if (opt.error) throw new Error(`구매옵션 — ${opt.error}`)
  const notices = buildNotices(nc, title, row, spec)
  const { rep, contentImgs, contents } = await pickImages(row)
  const item = { itemName: opt.itemName.slice(0, 100), originalPrice: d.price, salePrice: d.price, ...itemBase(row, rep, notices, contents), externalVendorSku: `${SOURCE}:${row.idx}`, attributes: opt.attributes }
  return { payload: productPayload(row, title, cat, [item]), title, contentCount: contentImgs.length, noticeName: nc.noticeCategoryName, lines: null, d }
}

async function resolveCategory(row, title) {
  if (row.coupang_category_code) return { code: Number(row.coupang_category_code), name: row.coupang_category_name, cached: true }
  const pr = await api('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', { productName: title })
  const cat = pr.body?.data
  if (!cat?.predictedCategoryId) throw new Error(`카테고리 예측 실패: ${JSON.stringify(pr.body).slice(0, 120)}`)
  const code = parseInt(cat.predictedCategoryId), name = cat.predictedCategoryName ?? null
  if (!DRY) {
    const { error } = await sb.from(TABLE).update({ coupang_category_code: code, coupang_category_name: name, coupang_category_predicted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('idx', row.idx)
    if (error) console.log(`      ⚠ 카테고리 캐시 기록 실패(다음 회차에 다시 예측): ${error.message}`)
  }
  return { code, name, cached: false }
}

// ── 대상 ──
async function fetchAll(build) { const PAGE = 1000, out = []; for (let from = 0; ; from += PAGE) { const { data, error } = await build().range(from, from + PAGE - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < PAGE) return out } }
let rows = await fetchAll(() => {
  // --dry --only 는 등록 제외 상품도 미리 볼 수 있다(제외 사유를 고친 뒤 해제 전 확인) — 실제 등록은 제외 해제 후에만
  const q0 = sb.from(TABLE).select('*').eq('status', 'active').is('auto_excluded_reason', null)
  const q = DRY && ONLY.length ? q0 : q0.eq('register_excluded', false)
  return (NO_MARKET ? q : q.not('market_checked_at', 'is', null)).order('idx')
})
if (ONLY.length) rows = rows.filter((r) => ONLY.includes(String(r.idx)))
let existing
try { existing = await fetchAll(() => sb.from('jimscanner_coupang_listings').select('source_goods_no, status, last_synced_at').eq('source', SOURCE).order('id')) } catch (e) { console.error('기등록 조회 실패:', e.message); process.exit(1) }
// FAILED 는 24시간 뒤에만 재시도 — 드립 루프가 같은 실패 건으로 자리를 채우지 않게(campingmoon 과 같은 규칙)
const existingSet = new Set(existing.filter((r) => r.status !== 'FAILED' || (r.last_synced_at && Date.now() - Date.parse(r.last_synced_at) < 24 * 3600e3)).map((r) => String(r.source_goods_no)))
const skipped = []
const candidates = rows
  .map((r) => { const ref = r.market_p25 ?? r.market_low; return { ...r, _d: (NO_MARKET ? decideNoMarket : decide)(r.wholesale_price, r.delivery_price, ref ? [ref] : []) } })
  .filter((r) => {
    if (existingSet.has(String(r.idx))) { skipped.push([r.idx, '이미 등록됨']); return false }
    if (r._d.verdict !== 'OK' && r._d.verdict !== 'TARGET') { skipped.push([r.idx, `시세 ${r._d.verdict}`]); return false }
    const block = nameBlock(cleanTitle(r))
    if (block) { skipped.push([r.idx, `상품명 🚫 ${block}`]); return false }
    return true
  })
  .sort((a, b) => (a._d.verdict === 'OK' ? 0 : 1) - (b._d.verdict === 'OK' ? 0 : 1) || b._d.net - a._d.net) // 시세 OK 먼저, 그 안에선 순이익 큰 것부터
console.log(`=== 도매아토즈 → 쿠팡 등록 ${DRY ? '[DRY]' : ''}${NO_APPROVAL ? ' [승인요청 안 함]' : ''}${NO_MARKET ? ' [시세 판정 없이 목표가]' : ''} · 수수료 ${(COUPANG_FEE * 100).toFixed(1)}%${LIMIT ? ` · 이번 실행 성공 ${LIMIT}건까지` : ''} ===`)
console.log(`후보 ${candidates.length}건 (제외 ${skipped.length} · 기등록 ${existingSet.size})`)
if (skipped.length) { const g = skipped.reduce((m, [no, why]) => { const k = why.replace(/\(.*$/, ''); (m[k] ??= []).push(no); return m }, {}); for (const [why, nos] of Object.entries(g)) console.log(`  · ${why}: ${nos.length}건 (${nos.slice(0, 8).join(',')}${nos.length > 8 ? '…' : ''})`) }
console.log('')

const summary = { success: 0, fail: 0, approved: 0, errors: [] }
const logDir = path.join(__dirname, '..', '_tmp_domeatoz_register'); if (!DRY && !existsSync(logDir)) mkdirSync(logDir, { recursive: true })
// 등록 전 단계의 결정적 실패(고시·규격·이미지 없음)는 상품에 제외 사유를 남겨 다음 회차 후보에서 빠지게 한다(원인 고치면 DB 에서 해제)
const DETERMINISTIC = /식품 고시 없는|구매옵션 —|대표 이미지 없음|일반 상품 —/
const excludeProduct = async (row, reason) => {
  if (DRY) return
  const { error } = await sb.from(TABLE).update({ register_excluded: true, register_excluded_reason: `자동: ${reason}`.slice(0, 200), updated_at: new Date().toISOString() }).eq('idx', row.idx)
  if (error) console.log(`      ⚠ 제외 기록 실패(다음 회차에 다시 후보로 올라옴): ${error.message}`)
}
let done = 0, streak = 0 // 연속 오류 6건이면 이번 회차 중단 — API 일시 장애 때 후보를 훑으며 실패를 쌓지 않게
for (let i = 0; i < candidates.length; i++) {
  if (LIMIT > 0 && done >= LIMIT) break
  if (streak >= 6) { console.log(`연속 오류 ${streak}건 → 이번 회차 중단(일시 장애 의심, 다음 회차에 재시도)`); break }
  const row = candidates[i], idx = `[${i + 1}/${candidates.length}]`
  let d = row._d
  try {
    const title = cleanTitle(row)
    const cat = await resolveCategory(row, title)
    const meta = await getCategoryMeta(cat.code)
    const built = await buildPayload(row, meta, cat, d)
    d = built.d ?? d // 일반 상품은 옵션별 가격 중 가장 낮은 item 기준으로 기록
    if (DRY) {
      if (args.includes('--show-payload')) writeFileSync(path.join(process.env.TEMP || __dirname, `domeatoz-payload-${row.idx}.json`), JSON.stringify(built.payload, null, 2))
      const it = built.payload.items[0]
      console.log(`${idx} (dry) ${row.idx} ${built.title.slice(0, 34).padEnd(34)} [${cat.code}${cat.cached ? '' : '*'} ${String(cat.name ?? '').slice(0, 14)}] 고시 ${built.noticeName} 상세 ${built.contentCount}장 ${it.taxType}${built.payload.items.length > 1 ? ` · item ${built.payload.items.length}개` : ''}`)
      console.log(`        도매 ${row.wholesale_price}+배송 ${row.delivery_price} → 원가 ${d.cost} · 하한 ${d.floor} · 시세 ${d.ref} → 판매 ${d.price} 순이익 ${d.net} (${(d.margin * 100).toFixed(1)}%) | ${it.attributes.filter((a) => a.attributeValueName).map((a) => `${a.attributeTypeName}=${a.attributeValueName}`).join(' ')}`)
      if (built.lines) for (const l of built.lines) console.log(`          · ${l.sku} ${l.label} ${l.d.price}원 | ${l.attributes.map((a) => `${a.attributeTypeName}=${a.attributeValueName}`).join(' ')}`)
      if (!isFoodRow(row)) console.log(`        고시: ${built.payload.items[0].notices.map((n) => `${n.noticeCategoryDetailName.slice(0, 14)}=${String(n.content).slice(0, 24)}`).join(' | ')}`)
      done++
      continue
    }
    const searchTags = await fillSearchTags(built.payload, { category: cat.name, source: SOURCE }) // 검색어 20개(키워드도구 + Claude) — 실패해도 [] 로 진행
    let r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    if (r.body?.code !== 'SUCCESS' && BRAND_REQUIRED.test(String(r.body?.message || ''))) {
      const hit = await resolveBrand(built.title)
      if (hit) { built.payload.brandId = hit.brandId; built.payload.brand = hit.brandName } else built.payload.brand = firstToken(built.title)
      console.log(`      ↻ 브랜드 필수 카테고리 — ${hit ? `사전 브랜드 ${hit.brandName}(${hit.brandId})` : `사전에 없음, 이름만 "${built.payload.brand}"`} 로 재시도`)
      await sleep(500)
      r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    }
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null
    const success = r.status === 200 && r.body?.code === 'SUCCESS' && sellerProductId != null // id 없는 SUCCESS 는 추적 불가 → 실패로 기록
    writeFileSync(path.join(logDir, `${row.idx}.json`), JSON.stringify({ payload: built.payload, response: r.body }, null, 2), 'utf8')
    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: SOURCE, source_goods_no: row.idx, source_detail_url: `https://domeatoz.com/product/${row.idx}`, search_tags: searchTags, registered_title: built.title,
      display_category_code: cat.code, display_category_name: cat.name, brand: built.payload.brand ?? null,
      // msp_price_krw(NOT NULL) = 우리 하한가 — 공급사 MSP 가 없으니 리프라이스·pricewatch 가 이 아래로 못 내리게 하는 값(캠핑문과 같은 규칙)
      dome_price_krw: row.wholesale_price, source_shipping_fee_krw: row.delivery_price ?? 3000, outbound_shipping_fee_krw: 0, msp_price_krw: d.floor, list_price_krw: d.price,
      estimated_fee_krw: Math.round(d.price * COUPANG_FEE), estimated_margin_krw: d.net, estimated_margin_pct: +(d.margin * 100).toFixed(2),
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false, rejection_reason: success ? null : (r.body?.message ?? String(r.body).slice(0, 500)),
      request_payload: built.payload, last_response: r.body, registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    }
    const { data: inserted, error: insertErr } = await sb.from('jimscanner_coupang_listings').insert(listingRow).select('id').single()
    // DB 기록 실패 = 쿠팡엔 올라갔는데 추적 불가(다음 회차 중복 등록 위험) → 즉시 중단. 복구는 _tmp_domeatoz_register/<idx>.json 으로
    if (insertErr) { summary.fail++; streak += 6; summary.errors.push({ no: row.idx, title: built.title.slice(0, 36), reason: `listings insert 실패: ${insertErr.message}` }); console.log(`${idx} ⚠ ${row.idx} 등록 success=${success} 이나 DB insert 실패: ${insertErr.message} — 회차 중단`); continue }
    if (!success) { summary.fail++; streak++; const reason = String(r.body?.message ?? JSON.stringify(r.body)).slice(0, 160); summary.errors.push({ no: row.idx, title: built.title.slice(0, 36), cat: cat.code, reason }); console.log(`${idx} ✗ ${row.idx} [${cat.code}] ${built.title.slice(0, 30)} | ${reason}`); await sleep(500); continue }
    summary.success++; done++; streak = 0
    console.log(`${idx} ✓ ${row.idx} ${built.title.slice(0, 30).padEnd(30)} | ${d.price.toLocaleString()}원 순이익 ${d.net} sellerPID ${sellerProductId}${built.lines ? ` · 옵션 ${built.lines.length}개` : ''}`)
    // 옵션 상품: item ↔ 도매아토즈 옵션 매핑(주문 해석·승인 후 vendorItemId 채움 — coupang-followup-approvals ③-b)
    if (built.lines) {
      const liRows = built.lines.map((l) => ({ market: 'coupang', listing_key: String(sellerProductId), external_sku: l.sku, source: SOURCE, goods_no: String(row.idx), item_code: `o${l.o._k}`, option_value: l.label, pack_qty: 1, sale_price: l.d.price, cost_price: l.d.cost, status: 'ACTIVE' }))
      const { error: liErr } = await sb.from('jimscanner_listing_items').upsert(liRows, { onConflict: 'market,listing_key,external_sku' })
      if (liErr) console.log(`      ⚠ 옵션 매핑(listing_items) 기록 실패: ${liErr.message} — 주문은 상품 단위로 보임`)
    }
    if (!NO_APPROVAL) {
      let appr
      for (let attempt = 0; attempt < 3; attempt++) { await sleep(1500); appr = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`); if (appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)) break; if (!/임시저장.*상태.*상품만/.test(appr.body?.message ?? '')) break }
      const apprOk = appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)
      if (apprOk) { await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', last_synced_at: new Date().toISOString() }).eq('id', inserted.id); summary.approved++; console.log('      → 승인요청 완료 (PENDING_APPROVAL) — 승인 후 재고는 coupang-followup-approvals.mjs --source=domeatoz') }
      else {
        await sleep(3000)
        const cur = (await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)).body?.data?.statusName ?? ''
        if (cur && /승인반려/.test(cur)) { const why = (await rejectComment(sellerProductId)) || `응답: ${JSON.stringify(appr.body).slice(0, 300)}`; await sb.from('jimscanner_coupang_listings').update({ status: 'REJECTED', approval_status_name: cur, rejection_reason: `승인요청 직후 자동 반려 — ${why}`.slice(0, 500), last_synced_at: new Date().toISOString() }).eq('id', inserted.id); console.log(`      → 승인요청 직후 '승인반려'(자동 반려): ${why.slice(0, 160)}`) }
        else if (cur && !/임시저장/.test(cur)) { await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', approval_status_name: cur, last_synced_at: new Date().toISOString() }).eq('id', inserted.id); summary.approved++; console.log(`      → 승인요청 응답은 오류지만 쿠팡 상태 '${cur}' → PENDING_APPROVAL`) }
        else { console.log(`      → 승인요청 실패: ${JSON.stringify(appr.body).slice(0, 150)} — followup-approvals 가 재요청`); await sb.from('jimscanner_coupang_listings').update({ rejection_reason: `승인요청 실패: ${JSON.stringify(appr.body).slice(0, 300)}`, last_synced_at: new Date().toISOString() }).eq('id', inserted.id) }
      }
    }
  } catch (e) {
    summary.fail++; summary.errors.push({ no: row.idx, title: String(row.name_clean || '').slice(0, 36), reason: e.message }); console.log(`${idx} ✗ ${row.idx} ERROR: ${e.message}`)
    if (DETERMINISTIC.test(e.message)) await excludeProduct(row, e.message)
    else streak++ // 결정적 오류(상품 자체 문제, 제외 처리됨)는 장애 신호가 아니라 연속 오류에 안 센다
  }
  await sleep(400)
}
console.log('\n=== 완료 ===')
console.log(`성공 ${summary.success} / 승인요청 ${summary.approved} / 실패 ${summary.fail}`)
if (summary.errors.length) { console.log('\n실패 사유:'); summary.errors.forEach((e) => console.log(`  - ${e.no} [${e.cat ?? '?'}] ${e.title}: ${e.reason}`)) }
