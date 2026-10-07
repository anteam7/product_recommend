/**
 * 화장품스토리 → 쿠팡 Open API 등록 (jimscanner_cmtstory_products → jimscanner_coupang_listings, source='cmtstory')
 *   node scripts/cmtstory-register.mjs [--limit=N] [--only=1000001276,…] [--dry] [--no-approval] [--allow-claims] [--bundle=1,2,3]
 *                                      [--verdict=OPEN,WIN] [--check-images] [--show-payload]
 * 설계: docs/plan-cmtstory.md §4 · 기준 코드: kwholesale-register.mjs(검증된 등록 흐름) — 다른 점:
 *   - 전 상품 화장품: 고시는 '화장품' 11항목(용량·사용기한·제조업자/책임판매업자는 수집값, 나머지 '상세설명 참조'·법정 주의사항 문구).
 *     쿠팡 화장품 카테고리는 전부 isAllowSingleItem=false → 변형(1·2·3개) 필수. 수량 축만 쓰고 절대준수 수량 구간이 있으면 그 수량만.
 *   - 구매옵션: 상품명 규격(30ml·100g·30매·N개입) → lib/coupang-purchase-options. 중량/용량 없는 카테고리(시트마스크·세트·티슈)는
 *     필수 속성이 '개당 수량'·'수량' 뿐이라 여기서 직접 채운다(buildCosmeticOptions).
 *   - 판매가: 수집기 sale_prices[N] = max(절대준수가, 순마진 10%) 그대로. 절대준수 문구 없는 상품은 하한 없음(사용자 결정 2026-10-07).
 *   - 수수료 9.6%(row.coupang_fee_rate). 택배 CJGLS(화장품스토리 주 택배사). 출고지·반품지는 기존(항동로·신사로) 그대로.
 *   - 이미지: 대표 = og:image(상세 크기) · 상세 = 상품 사진(최대 4) + 상세설명(/editor/goods/). 공급사 규정상 변형·수정 금지 → 가공 없음.
 *     --check-images 면 dry 에서 상세 이미지 치수를 재서 쿠팡 규격(500~5000px) 밖이면 경고(sharp 없으면 건너뜀).
 *   - 상품명: coupang-name-audit 규칙 + 화장품 의약품 오인·기능성 표현(미백·주름개선·여드름·재생·항균 등)은 ⚠ → --allow-claims 로만 허용.
 *   - 시장성(P0.5): --verdict=OPEN,WIN 이면 cmtstory-market-scan.mjs 결과(market_verdict)가 그 값인 상품만 등록.
 *   - 전성분 서류: 메타 requiredDocumentNames 에 'MANDATORY INGREDIENTS PIC' 가 있어 첫 등록은 서류 없이 보내고,
 *     성분 서류 요구로 거절되면 상세설명 첫 이미지를 그 서류로 붙여 1회 재시도(실측 전 — 결과를 docs 에 기록할 것).
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
const TABLE = 'jimscanner_cmtstory_products'
const SOURCE = 'cmtstory'

// 출고지·반품지 — 기존 매입처와 동일(사용자 결정: 소비자 변심 반품은 건강산이 안 받으므로 내 주소). wellroot/kwholesale-register.mjs 와 이중관리 지점.
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717
const RETURN_CENTER_CODE = '1002609354'
const RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8'
const RETURN_ADDRESS_DETAIL = '301'
const RETURN_ZIP_CODE = '08703'
const COMPANY_CONTACT = '010-4164-3802'
const DELIVERY_COMPANY = 'CJGLS'           // 화장품스토리 주 택배사 CJ대한통운(공지) — 한진 발송분은 송장 크론이 택배사 코드로 구분
const DEFAULT_FEE = 0.096
const MAX_TITLE_LEN = 100
const PRIVACY_NOTICE = '[개인정보 처리 위탁 안내] 이 상품은 공급사 (주)건강산(화장품스토리)에서 직접 발송됩니다. 배송을 위해 주문 시 입력하신 수령인 정보(이름·주소·연락처)가 (주)건강산 및 배송 택배사에 제공되며, 배송 완료 후 관련 법령에 따라 처리됩니다.'
const COSMETIC_CAUTION = '1. 화장품 사용 시 또는 사용 후 직사광선에 의하여 사용부위가 붉은 반점, 부어오름 또는 가려움증 등의 이상 증상이나 부작용이 있는 경우 전문의 등과 상담할 것 2. 상처가 있는 부위 등에는 사용을 자제할 것 3. 보관 및 취급 시의 주의사항 가) 어린이의 손이 닿지 않는 곳에 보관할 것 나) 직사광선을 피해서 보관할 것'
const QUALITY_STD = '본 제품에 이상이 있을 경우 공정거래위원회 고시 소비자분쟁해결기준에 의거 보상합니다.'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const NO_APPROVAL = args.includes('--no-approval')
const ALLOW_CLAIMS = args.includes('--allow-claims')
const CHECK_IMAGES = args.includes('--check-images')
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const LIMIT = +(argOf('limit') || 0) || 0
const ONLY = (argOf('only') || '').split(',').map(s => s.trim()).filter(s => /^\d{1,12}$/.test(s))
const BUNDLE_QTYS = (argOf('bundle') || '1,2,3').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
const VERDICTS = new Set((argOf('verdict') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean))

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
// 이미지 — 화장품스토리 CDN(godomall.speedycdn.net)은 같은 파일에 content-type 을 multipart/form-data 로 주는 응답이 흔하고(2026-10-07 dry 56/170)
// 연속 요청에 간헐 실패도 있어 쿠팡이 원본 URL 을 못 받을 위험이 크다 → 바이트를 받아 매직바이트(JPEG·PNG·GIF·WEBP)로 확인한 뒤
// Supabase site-assets 에 무가공 복사(재호스팅)해 그 공개 URL 을 쿠팡에 넘긴다(공급사 규정: 이미지 사용 허용·변형 금지 — 복사만).
// --no-rehost 면 원본 URL 그대로(확인만).
const REHOST = !args.includes('--no-rehost')
const BUCKET = 'site-assets'
const IMAGE_MAGIC = [[[0xff, 0xd8, 0xff], 'image/jpeg', 'jpg'], [[0x89, 0x50, 0x4e, 0x47], 'image/png', 'png'], [[0x47, 0x49, 0x46, 0x38], 'image/gif', 'gif'], [[0x52, 0x49, 0x46, 0x46], 'image/webp', 'webp']]
async function fetchImage(u, attempt = 0) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.cmtstory.com/' } })
    if (r.status === 200) {
      const buf = Buffer.from(await r.arrayBuffer())
      const hit = IMAGE_MAGIC.find(([m]) => buf.length > 16 && m.every((b, i) => buf[i] === b))
      if (hit) return { buf, contentType: hit[1], ext: hit[2] }
    }
  } catch { /* 재시도 */ }
  if (attempt < 1) { await sleep(800); return fetchImage(u, attempt + 1) }
  return null
}
const rehosted = new Map()   // 원본 URL → 공개 URL (한 실행 안에서 중복 업로드 방지)
async function imageUrlFor(u, goodsNo) {
  if (rehosted.has(u)) return rehosted.get(u)
  const img = await fetchImage(u)
  if (!img) return null
  if (!REHOST) { rehosted.set(u, u); return u }
  // 쿠팡 상세 이미지 한도 10MB([[coupang_image_spec]]) 초과면 그 이미지만 제외. 스토리지 객체 한도(~5MB)를 넘는 긴 상세 GIF/PNG(7~9MB)는
  // 진짜 상세설명이라 빼면 안 되므로 원본 CDN URL 을 그대로 쓴다(쿠팡이 못 받으면 승인 반려로 드러남 → 그때 분할 검토).
  if (img.buf.length > 10 * 1024 * 1024) { console.log(`      ⚠ 이미지 ${(img.buf.length / 1048576).toFixed(1)}MB 초과(쿠팡 한도) — 제외 ${u.split('/').pop()}`); rehosted.set(u, null); return null }
  const base = (u.split('/').pop() || 'img').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)
  const key = `coupang/cmtstory/${goodsNo}/${base}.${img.ext}`
  const { error } = await sb.storage.from(BUCKET).upload(key, img.buf, { contentType: img.contentType, upsert: true })
  if (error) {
    if (/exceeded the maximum allowed size|too large|413/i.test(error.message)) { console.log(`      ⚠ 스토리지 한도 초과(${(img.buf.length / 1048576).toFixed(1)}MB) — 원본 URL 사용 ${u.split('/').pop()}`); rehosted.set(u, u); return u }
    throw new Error(`이미지 재호스팅 실패(${key}): ${error.message}`)
  }
  const pub = sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl
  rehosted.set(u, pub)
  return pub
}
// 상세 이미지 치수(쿠팡 DETAIL 규격 500~5000px) — sharp 가 있을 때만. 공급사 규정상 이미지 가공은 하지 않고 경고만.
let sharpMod = null
async function imageDims(u) {
  if (sharpMod === null) { try { sharpMod = (await import('sharp')).default } catch { sharpMod = false } }
  if (!sharpMod) return null
  try { const buf = Buffer.from(await (await fetch(u)).arrayBuffer()); const m = await sharpMod(buf).metadata(); return { w: m.width, h: m.height } } catch { return null }
}

// ── 상품명 검사 — coupang-name-audit.mjs RULES(정본) + 화장품 의약품 오인·기능성 표현 ──
const NAME_RULES = [
  { sev: 'block', key: '광고성', re: /(최저가|초특가|특가|핫딜|세일|할인|사은품|무료\s*증정|1\s*\+\s*1|당일\s*발송|당일\s*배송|무료\s*배송|품절\s*임박|한정\s*수량|이벤트|행사|베스트|인기\s*상품|판매\s*1위|강력\s*추천|대박|％|\bsale\b|\bhot\b)/i },
  { sev: 'claim', key: '효능/질병', re: /(치료|치유|완치|예방|효능|효과|항암|항염|소염|진통|염증|면역|해독|디톡스|개선|회복)/ },
  { sev: 'claim', key: '화장품 기능성/오인', re: /(미백|주름\s*개선|여드름|아토피|탈모|항균|살균|재생|세포|피부과|의약|약용|상처)/ },   // 기능성(심사 필요)·의약품 오인 — 식약처 심사 여부를 모르면 상품명에 넣지 않는다
  { sev: 'block', key: '금지특수문자', re: /[※☆★♥♡▶◀◆■□【】〈〉「」『』]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u },
  { sev: 'block', key: 'URL/연락처', re: /(https?:\/\/|www\.|\.com|\.co\.kr|01[016-9][- ]?\d{3,4}[- ]?\d{4})/i },
  { sev: 'block', key: '타플랫폼', re: /(네이버|스마트\s*스토어|11번가|지마켓|g마켓|옥션|위메프|티몬|인터파크|아마존)/i },
]
function auditName(name) {
  const hits = NAME_RULES.map(r => { const m = name.match(r.re); return m ? { ...r, hit: m[0].trim() } : null }).filter(Boolean)
  if ([...name].length > MAX_TITLE_LEN) hits.push({ sev: 'block', key: '길이초과', hit: `${[...name].length}자` })
  return hits
}

// ── 고시: '화장품' 11항목 ──
function buildNotices(noticeCategory, title, row, spec) {
  const name = noticeCategory.noticeCategoryName
  const volume = spec?.volumeMl != null ? `${+spec.volumeMl.toFixed(2)}ml` : spec?.weightG != null ? `${+spec.weightG.toFixed(2)}g` : null
  const pieces = title.match(/(\d+)\s*(매입|개입|매|장|입)(?![가-힣a-z])/)?.[0]   // "10매"·"(10매입)" — 한글 뒤 \b 는 동작하지 않는다(ASCII 경계만)
  const valueFor = (dn) => {
    if (/용량|중량/.test(dn)) return volume ?? pieces ?? '상세설명 참조'
    if (/사용기한|개봉/.test(dn)) return row.expiry_date ? `사용기한 ${row.expiry_date} 까지 (제품 별도 표기 참조)` : '제품 별도 표기 참조'
    if (/제조업자|책임판매|맞춤형/.test(dn)) return row.manufacturer ? String(row.manufacturer).slice(0, 60) : '상세설명 참조'
    if (/주의사항/.test(dn)) return COSMETIC_CAUTION
    if (/품질보증/.test(dn)) return QUALITY_STD
    if (/상담.*전화|전화번호/.test(dn)) return COMPANY_CONTACT
    return '상세설명 참조'   // 제품 주요 사양 · 사용방법 · 제조국 · 전성분 · 기능성 심사 유무
  }
  const mandatory = (noticeCategory.noticeCategoryDetailNames ?? []).filter(d => d.required === 'MANDATORY')
  return mandatory.map(d => ({ noticeCategoryName: name, noticeCategoryDetailName: d.noticeCategoryDetailName, content: valueFor(d.noticeCategoryDetailName) }))
}

// ── 판매가: 수집기 sale_prices 사용 + 하한 안전장치(절대준수가가 있을 때만) ──
function priceFor(row, n) {
  const p = row.sale_prices?.[String(n)] ?? row.sale_prices?.[n]
  if (!p?.price) throw new Error(`판매가 미계산(${n}개) — cmtstory-collect.mjs 재실행 필요`)
  const floor = row.tiered_msp?.[String(n)] ?? (row.msp_price_krw ? row.msp_price_krw * n : 0)
  if (floor && p.price < floor) throw new Error(`판매가 ${p.price} < 절대준수가 ${floor} (${n}개) — 등록 중단`)
  const fee = row.coupang_fee_rate ?? DEFAULT_FEE
  return { qty: n, listPrice: p.price, msp: floor || null, margin: p.margin, marginPct: p.pct, ship: p.ship, basis: p.basis, fee: Math.round(p.price * fee) }
}
// 변형 수량 — 절대준수 수량 구간(tiered_msp 1·2·3)이 있으면 그 수량만, 없거나 1개만이면 1·2·3 전부(하한은 1개가×N)
function variantQtys(row, requested) {
  const t = row.tiered_msp && typeof row.tiered_msp === 'object' ? row.tiered_msp : null
  if (!t || Object.keys(t).length < 2) return requested
  const have = requested.filter(n => n === 1 || (typeof t[String(n)] === 'number' && t[String(n)] > 0))
  return have.length >= 2 ? have : requested.slice(0, 2)
}

function cleanTitle(row) {
  let t = String(row.title_clean || row.title || '').replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim()
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN).trim()
  return t
}

/**
 * 중량·용량 없는 화장품 카테고리(시트마스크 56184: 개당 수량+수량 · 세트 56671: 수량 · 티슈 56142: 개당 수량 그룹)용 구매옵션.
 * 필수 속성이 '개당 수량'·'수량'(또는 같은 그룹 중 하나)으로만 채워질 때만 성공, 아니면 error.
 */
function buildCosmeticOptions(attrs, title, qty) {
  const pieces = +(title.match(/(\d+)\s*(매입|개입|매|장|입|ea|p)(?![가-힣a-z])/i)?.[1] || 0) || 1   // "10매"·"(10매입)"·"10ea" → 10개입 (한글 뒤 \b 무동작)
  const out = []
  const filledGroups = new Set()
  const unit = (a, prefs) => (a.usableUnits ?? []).find(u => prefs.includes(u)) ?? (a.usableUnits ?? [])[0] ?? prefs[0]
  const parts = []
  for (const a of attrs) {
    const name = a.attributeTypeName
    const grp = a.groupNumber && a.groupNumber !== 'NONE' ? a.groupNumber : null
    if (name === '개당 수량' && (a.required === 'MANDATORY' || grp)) {
      const v = `${pieces}${unit(a, ['개입', '매입', '입', '개'])}`
      out.push({ attributeTypeName: name, attributeValueName: v, exposed: 'EXPOSED' }); parts.push(v); if (grp) filledGroups.add(grp); continue
    }
    if (name === '수량' || name === '총 수량') {
      if (name === '총 수량' && attrs.some(x => x.attributeTypeName === '수량')) continue
      const v = `${qty}${unit(a, ['개', '세트', '박스', '팩'])}`
      out.push({ attributeTypeName: name, attributeValueName: v, exposed: 'EXPOSED' }); parts.push(v); continue
    }
    out.push({ attributeTypeName: name, attributeValueName: '', exposed: 'NONE', _grp: grp, _req: a.required })
  }
  for (const o of out) {
    if (o.exposed === 'NONE' && o._req === 'MANDATORY' && !(o._grp && filledGroups.has(o._grp))) return { error: `처리 못 하는 필수 구매옵션: ${o.attributeTypeName}` }
    delete o._grp; delete o._req
  }
  if (!parts.length) return { error: '수량 속성 없음' }
  return { attributes: out, itemName: parts.join(' ') }
}
function purchaseOptions(meta, title, spec, n) {
  const attrs = meta.attributes ?? []
  const a = spec ? buildPurchaseOptions(attrs, spec, n) : { error: '규격 없음' }
  if (!a.error) return a
  const b = buildCosmeticOptions(attrs, title, n)
  if (!b.error) return b
  return { error: `${a.error} / ${b.error}` }
}

async function buildPayload(row, meta, categoryCode, categoryName, qtys) {
  const prices = qtys.map(n => priceFor(row, n))
  const price = prices[0]
  const title = cleanTitle(row)
  const noticeCategory = (meta.noticeCategories ?? []).find(n => n.noticeCategoryName === '화장품')
  if (!noticeCategory) throw new Error(`'화장품' 고시 없는 카테고리(${(meta.noticeCategories ?? []).map(n => n.noticeCategoryName).join(',') || '고시없음'})`)
  const spec = parseSpec(title)
  const notices = buildNotices(noticeCategory, title, row, spec)

  const mains = Array.isArray(row.images_main) ? row.images_main : []
  const repSrc = row.thumb_url || mains[0]
  if (!repSrc) throw new Error('대표 이미지 없음')
  const rep = await imageUrlFor(repSrc, row.goods_no)
  if (!rep) throw new Error(`대표 이미지 다운로드 실패: ${repSrc}`)
  const contentCands = [...mains.filter(u => u !== repSrc).slice(0, 4), ...(Array.isArray(row.images_content) ? row.images_content : [])]
  const contentImgs = []
  const warnings = []
  for (const u of contentCands.slice(0, 16)) {
    const hosted = await imageUrlFor(u, row.goods_no)
    if (!hosted) continue
    if (CHECK_IMAGES) { const d = await imageDims(u); if (d && (d.w < 500 || d.h < 500 || d.w > 5000 || d.h > 5000)) warnings.push(`${d.w}x${d.h} ${u.split('/').pop()}`) }
    contentImgs.push(hosted)
    if (contentImgs.length >= 12) break
  }
  if (!contentImgs.length) throw new Error('상세 이미지 없음/다운로드 실패 — 승인반려 대상이라 등록 보류')
  const items_images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: rep }]
  const contents = [
    ...contentImgs.map(u => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] })),
    { contentsType: 'TEXT', contentDetails: [{ content: PRIVACY_NOTICE, detailType: 'TEXT' }] },
  ]

  const items = qtys.map((n, i) => {
    const p = prices[i]
    const opt = purchaseOptions(meta, title, spec, n)
    if (opt.error) throw new Error(`구매옵션 — ${opt.error}`)
    return {
      itemName: opt.itemName,
      originalPrice: p.listPrice, salePrice: p.listPrice,
      maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: 2, unitCount: n, adultOnly: 'EVERYONE', taxType: 'TAX',
      parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
      externalVendorSku: `${row.goods_no}-${n}`,
      emptyBarcode: true, emptyBarcodeReason: n > 1 ? '묶음 상품' : '바코드 없음',
      images: items_images, notices, attributes: opt.attributes, contents, offerCondition: 'NEW',
    }
  })
  const payload = {
    vendorId: VENDOR_ID, sellerProductName: title, displayProductName: title,
    displayCategoryCode: categoryCode,
    generalProductName: title, productGroup: title.split(/\s+/).slice(0, 3).join(' '),
    manufacture: row.manufacturer ? String(row.manufacturer).slice(0, 60) : '상세설명 참조',
    saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: DELIVERY_COMPANY, deliveryChargeType: 'FREE', deliveryCharge: 0,
    freeShipOverAmount: 0, deliveryChargeOnReturn: RETURN_CHARGE, remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY',
    returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: COMPANY_CONTACT,
    returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL,
    returnCharge: RETURN_CHARGE, outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE, vendorUserId: 'anteam7',
    requested: false, items, notices: [], requiredDocuments: [],
  }
  const firstContent = (row.images_content ?? [])[0]
  return { payload, price, prices, qtys, title, categoryName, contentCount: contentImgs.length, ingredientsPic: (firstContent && rehosted.get(firstContent)) || contentImgs[0], warnings }
}

/** 카테고리 예측 (결과는 DB 캐시 — 매 실행 호출하지 않는다) */
async function resolveCategory(row, title) {
  if (row.coupang_category_code) return { code: row.coupang_category_code, name: row.coupang_category_name, cached: true }
  const pr = await api('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', { productName: title })
  const cat = pr.body?.data
  if (!cat?.predictedCategoryId) throw new Error(`카테고리 예측 실패: ${JSON.stringify(pr.body).slice(0, 120)}`)
  const code = parseInt(cat.predictedCategoryId)
  const name = cat.predictedCategoryName ?? null
  await sb.from(TABLE).update({ coupang_category_code: code, coupang_category_name: name, coupang_category_predicted_at: new Date().toISOString() }).eq('goods_no', row.goods_no)
  return { code, name, cached: false }
}

// ── 대상 선정 ────────────────────────────────────────────────────
const baseSel = sb.from(TABLE).select('*')
const { data: rows, error: qErr } = ONLY.length ? await baseSel.in('goods_no', ONLY) : await baseSel.eq('coupang_eligible', true)
if (qErr) { console.error('대상 조회 실패:', qErr.message); process.exit(1) }
const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no, status').eq('source', SOURCE)
// FAILED 는 재시도 가능(SKIPPED 는 카테고리 제약이라 계속 막는다) — 웰루트·K홀세일과 동일
const existingSet = new Set((existing ?? []).filter(r => r.status !== 'FAILED').map(r => r.source_goods_no))

const skipped = []
const candidates = (rows ?? []).filter(r => {
  if (existingSet.has(r.goods_no)) { skipped.push([r.goods_no, '이미 등록됨']); return false }
  if (!r.coupang_eligible) { skipped.push([r.goods_no, `등록 대상 아님(${r.excluded_reason ?? r.register_excluded_reason ?? '품절·옵션·임박·제외 등'})`]); return false }
  if (VERDICTS.size && !VERDICTS.has(String(r.market_verdict || 'UNKNOWN').toUpperCase())) { skipped.push([r.goods_no, `시장성 ${r.market_verdict ?? '미확인'} (--verdict=${[...VERDICTS].join(',')})`]); return false }
  const hits = auditName(cleanTitle(r))
  const block = hits.find(h => h.sev === 'block')
  if (block) { skipped.push([r.goods_no, `상품명 🚫 ${block.key}("${block.hit}")`]); return false }
  const claim = hits.find(h => h.sev === 'claim')
  if (claim && !ALLOW_CLAIMS) { skipped.push([r.goods_no, `상품명 표현 ⚠ ${claim.key}("${claim.hit}") — 상품명 정리 후 등록(--allow-claims)`]); return false }
  return true
}).sort((a, b) => (b.sale_prices?.['2']?.margin ?? 0) - (a.sale_prices?.['2']?.margin ?? 0))   // 2개 묶음 마진 큰 순(묶음이 주력)
const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates

console.log(`=== 화장품스토리 → 쿠팡 등록 ${DRY ? '[DRY]' : ''}${NO_APPROVAL ? ' [승인요청 안 함]' : ''}${VERDICTS.size ? ` [시장성 ${[...VERDICTS].join(',')}]` : ''} ===`)
console.log(`대상 ${targets.length}건 (후보 ${candidates.length} · 제외 ${skipped.length} · 기등록 ${existingSet.size})`)
if (skipped.length) {
  const grouped = skipped.reduce((m, [no, why]) => { const k = why.replace(/\("[^"]*"\)/, '').replace(/\(.*\)$/, ''); (m[k] ??= []).push(no); return m }, {})
  for (const [why, nos] of Object.entries(grouped)) console.log(`  · ${why}: ${nos.length}건 (${nos.slice(0, 8).join(',')}${nos.length > 8 ? '…' : ''})`)
}
console.log('')
const summary = { success: 0, fail: 0, approved: 0, skip: 0, errors: [] }
const logDir = path.join(__dirname, '..', '_tmp_cmtstory_register')
if (!DRY && !existsSync(logDir)) mkdirSync(logDir, { recursive: true })
const dryStats = { ok: 0, byCat: {}, optionErr: 0, warn: 0 }

for (let i = 0; i < targets.length; i++) {
  const row = targets[i]
  const idx = `[${i + 1}/${targets.length}]`
  try {
    const title = cleanTitle(row)
    const cat = await resolveCategory(row, title)
    const meta = await getCategoryMeta(cat.code)
    const qtys = variantQtys(row, BUNDLE_QTYS)
    if (meta.isAllowSingleItem === false && qtys.length < 2) { console.log(`${idx} ⏭ ${row.goods_no} [${cat.code}] ${title.slice(0, 32)} | 변형 2개 이상 필요 — SKIP`); summary.skip++; await sleep(300); continue }

    const built = await buildPayload(row, meta, cat.code, cat.name, qtys)
    if (DRY && args.includes('--show-payload') && i === 0) writeFileSync(path.join(process.env.TEMP || __dirname, `cmtstory-payload-${row.goods_no}.json`), JSON.stringify(built.payload, null, 2))
    if (DRY) {
      dryStats.ok++; dryStats.byCat[`${cat.code} ${cat.name ?? ''}`] = (dryStats.byCat[`${cat.code} ${cat.name ?? ''}`] || 0) + 1
      const variants = built.prices.map(p => `${p.qty}개 ${p.listPrice.toLocaleString()}원(${p.basis === 'msp' ? '절대준수가' : '마진가'}, 마진 ${p.margin.toLocaleString()} ${p.marginPct}%)`).join(' · ')
      console.log(`${idx} (dry) ${row.goods_no} ${built.title.slice(0, 30).padEnd(30)} | 도매 ${String(row.wholesale_price_krw).padStart(6)} [${cat.code}${cat.cached ? '' : '*'} ${String(cat.name ?? '').slice(0, 12)}] 상세 ${built.contentCount}장${row.market_verdict ? ` · 시장 ${row.market_verdict}` : ''}`)
      console.log(`        ${variants}`)
      console.log(`        옵션 ${built.payload.items.map(it => it.itemName).join(' / ')}`)
      if (built.warnings.length) { dryStats.warn++; console.log(`        ⚠ 이미지 규격 밖: ${built.warnings.join(' | ')}`) }
      await sleep(150)
      continue
    }

    let r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    if (!(r.status === 200 && r.body?.code === 'SUCCESS') && /성분|ingredient/i.test(JSON.stringify(r.body)) && built.ingredientsPic) {
      // 전성분 서류 요구 → 상세설명 첫 이미지를 'MANDATORY INGREDIENTS PIC' 로 붙여 1회 재시도(실측 전 가설 — 결과를 plan §10 에 기록)
      console.log(`      ↻ 전성분 서류 요구(${String(r.body?.message ?? '').slice(0, 80)}) — 상세 이미지를 서류로 붙여 재시도`)
      built.payload.requiredDocuments = [{ templateName: 'MANDATORY INGREDIENTS PIC', vendorDocumentPath: built.ingredientsPic }]
      await sleep(500)
      r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    }
    const success = r.status === 200 && r.body?.code === 'SUCCESS'
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null
    writeFileSync(path.join(logDir, `${row.goods_no}.json`), JSON.stringify({ payload: built.payload, response: r.body }, null, 2), 'utf8')

    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: SOURCE,
      source_goods_no: row.goods_no, source_detail_url: row.detail_url, registered_title: built.title,
      display_category_code: cat.code, display_category_name: cat.name, brand: null,
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
      summary.errors.push({ no: row.goods_no, title: built.title.slice(0, 36), reason: `listings insert 실패: ${insertErr.message}` })
      console.log(`${idx} ⚠ ${row.goods_no} 등록 success=${success} 이나 DB insert 실패: ${insertErr.message}`)
      await sleep(500); continue
    }
    if (!success) {
      summary.fail++
      const reason = String(r.body?.message ?? JSON.stringify(r.body)).slice(0, 150)
      summary.errors.push({ no: row.goods_no, title: built.title.slice(0, 36), cat: cat.code, reason })
      console.log(`${idx} ✗ ${row.goods_no} [${cat.code}] ${built.title.slice(0, 30)} | ${reason}`)
      await sleep(500); continue
    }
    summary.success++
    console.log(`${idx} ✓ ${row.goods_no} ${built.title.slice(0, 30).padEnd(30)} | ${built.qtys.length}변형 ${built.price.listPrice.toLocaleString()}원 (${built.price.marginPct}%) sellerPID=${sellerProductId}`)

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
        console.log('      → 승인요청 완료 (PENDING_APPROVAL) — 승인 후 재고는 coupang-followup-approvals.mjs --source=cmtstory')
      } else {
        // 응답이 에러여도 쿠팡에선 이미 심사중·승인완료인 경우가 있다(504, "IN_REVIEW by seller gating") → 실제 상태를 다시 읽는다(K홀세일 2026-09-27)
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
    if (DRY && /구매옵션/.test(e.message)) dryStats.optionErr++
    summary.errors.push({ no: row.goods_no, title: String(row.title || '').slice(0, 36), reason: e.message })
    console.log(`${idx} ✗ ${row.goods_no} ERROR: ${e.message}`)
  }
  await sleep(DRY ? 100 : 500)
}

console.log('\n=== 완료 ===')
if (DRY) console.log(`dry 통과 ${dryStats.ok} / 실패 ${summary.fail}(구매옵션 ${dryStats.optionErr}) / 보류 ${summary.skip} / 이미지 경고 ${dryStats.warn}\n카테고리: ${JSON.stringify(dryStats.byCat)}`)
else console.log(`성공 ${summary.success} / 승인요청 ${summary.approved} / 실패 ${summary.fail} / 보류 ${summary.skip}`)
if (summary.errors.length) {
  console.log('\n실패 사유:')
  summary.errors.forEach(e => console.log(`  - ${e.no} [${e.cat ?? '?'}] ${e.title}: ${e.reason}`))
}
