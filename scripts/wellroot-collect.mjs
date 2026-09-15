/**
 * 웰루트B2B(wellrootb2b.com, Cafe24 mall sbh2020) 상품 수집 → jimscanner_wellroot_products upsert.
 *   node scripts/wellroot-collect.mjs [--dry] [--only=751,602] [--limit=N] [--concurrency=3] [--verbose]
 *
 * 설계: docs/plan-wellroot-collect.md
 *  - fetch+쿠키 로그인(upickb2b-collect.mjs 와 같은 Cafe24 패턴). 비회원엔 공급가 비노출.
 *  - 전 카테고리 목록 순회 → 소속 카테고리·품절 아이콘 → 상세 파싱.
 *  - MSP(최저판매가, 배송비 포함) 탐지 5형태: text_tier / text_single / img_file / img_b64 / none.
 *    유효 MSP가 없으면(none·이미지형) 쿠팡 등록 제외(coupang_eligible=false) →
 *    /admin/wellroot-msp 에서 사람이 확인·입력(msp_source='manual').
 *  - manual(·이미지 해시가 같은 ocr) 유효값은 덮어쓰지 않고 탐지값(msp_detected_*)만 갱신.
 *    탐지값이 새로 바뀌었는데 유효값과 다르면 msp_review_needed.
 *  - content_hash 로 변동분만 upsert. 전체 실행 시 어느 카테고리에도 없는 상품은 status='gone'.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.WELLROOT_BASE_URL || 'https://wellrootb2b.com'
const TABLE = 'jimscanner_wellroot_products'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const argv = process.argv.slice(2)
const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = argv.includes('--dry')
const VERBOSE = argv.includes('--verbose')
const ONLY = new Set((arg('only') || '').split(',').map(s => s.trim()).filter(Boolean))
const LIMIT = +(arg('limit') || 0)
const CONC = Math.max(1, +(arg('concurrency') || 3))
const FULL_RUN = !ONLY.size && !LIMIT
const sleep = ms => new Promise(s => setTimeout(s, ms))

// 사이트 네비 기준 전 카테고리 (소속 판정을 위해 재판매 불가 카테고리도 순회)
const CATES = {
  '44': '건강식품.1', '71': '전통건강식품(추천)', '72': '분말', '73': '한방재료', '74': '원물', '75': '티백',
  '25': '건강식품.2', '49': '분말', '65': '원물', '47': '환', '56': '정/기타', '50': '액상스틱', '24': '건강기능식품',
  '64': '내 브랜드 만들기(소량제조)', '76': '건강식품(소량제조)', '78': '전통 건강식품(소량제조)', '68': 'MY BRAND(소량제조)',
  '92': '내 브랜드 만들기(BPS)', '99': '브랜드파트너십 라벨지', '93': 'MY BRAND(BPS)', '101': '브랜드파트너십 예치금',
  '100': '브랜드 파트너십 제품', '90': '부가 서비스', '95': '물류', '91': '디자인', '96': '사은품',
}
const RESELL_CATES = new Set(['44', '71', '72', '73', '74', '75', '25', '49', '65', '47', '56', '50', '24'])
const EXCLUDE_NAME = /BPS|예치금|라벨지|소량제조|MY\s*BRAND|디자인\s*변경|샘플|MOQ/i

// ── fetch + 쿠키 (upickb2b 패턴) ──
const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const eq = kv.indexOf('='); if (eq < 0) continue; const k = kv.slice(0, eq).trim(); const v = kv.slice(eq + 1).trim(); if (k) cookies.set(k, v) } }
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function fx(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml', Cookie: cookieHeader(), ...(init.headers || {}) } })
  setCookies(res.headers.get('set-cookie'))
  return res
}
// 웰루트는 Cafe24 로그인 암호화(AuthSSL)라 raw POST 는 403 → 헤드리스 크롬으로 로그인 후 쿠키만 fetch 에 이식 (bio77-collect 패턴)
async function login() {
  if (!env.WELLROOT_USER || !env.WELLROOT_PASS) throw new Error('.env.local 에 WELLROOT_USER / WELLROOT_PASS 필요')
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' })
    const page = await ctx.newPage()
    let dialogMsg = null
    page.on('dialog', d => { dialogMsg = d.message(); d.dismiss().catch(() => {}) })
    await page.goto(`${BASE}/member/login.html`, { waitUntil: 'load', timeout: 45000 })
    // 스킨 스크립트(아이디 저장 등)가 로드 직후 입력값을 초기화하는 경우가 있어 값이 남을 때까지 재입력
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(600)
      await page.locator('#member_id').fill(env.WELLROOT_USER)
      await page.locator('#member_passwd').fill(env.WELLROOT_PASS)
      if ((await page.locator('#member_id').inputValue()) === env.WELLROOT_USER && (await page.locator('#member_passwd').inputValue()) === env.WELLROOT_PASS) break
    }
    await Promise.all([
      page.waitForURL(u => !/\/member\/login\.html/.test(u.toString()), { timeout: 30000 }).catch(() => { throw new Error(`wellroot 로그인 실패${dialogMsg ? ': ' + dialogMsg : ' (로그인 페이지에서 이동 안 됨)'}`) }),
      page.press('#member_passwd', 'Enter'),
    ])
    for (const c of await ctx.cookies(BASE)) cookies.set(c.name, c.value)
  } finally {
    await browser.close()
  }
  // 검증: 회원 전용 페이지가 로그인으로 튕기지 않아야 함
  const r = await fx(`${BASE}/myshop/index.html`)
  const loc = r.headers.get('location') || ''
  if (r.status >= 300 && /login/.test(loc)) throw new Error('wellroot 로그인 세션 이식 실패 (myshop → login 리다이렉트)')
}

// ── 파싱 유틸 ──
const decodeEnt = s => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8203;/g, '')
// 인라인 태그는 공백 없이 제거 — "최<span>저가" 처럼 쪼개진 키워드를 살림
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'font', 'u', 'i', 'em', 'a', 'small', 'sup', 'sub', 'mark', 's', 'strike', 'label'])
const htmlToText = h => decodeEnt((h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (_, t) => (INLINE_TAGS.has(t.toLowerCase()) ? '' : ' '))).replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim()
const toInt = s => { const n = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null }
const intOrNull = s => { const n = parseInt(String(s ?? ''), 10); return Number.isFinite(n) && n >= 0 ? n : null }
const won = s => { const m = (s || '').match(/([\d,]{3,})\s*원/); return m ? toInt(m[1]) : null }
const abs = u => (!u ? null : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? BASE + u : u)
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
const jsVar = (html, k) => { const m = html.match(new RegExp(`var\\s+${k}\\s*=\\s*'((?:\\\\.|[^'])*)'`)); return m ? m[1] : null }

function infoTable(html) {
  const i = html.search(/xans-product-detaildesign/)
  if (i < 0) return {}
  const region = html.slice(i, i + 30000)
  const map = {}
  for (const m of region.matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const th = htmlToText(m[1]); const td = htmlToText(m[2])
    if (th && td && th.length < 30 && !(th in map)) map[th] = td.slice(0, 1000)
  }
  return map
}
function detailRegion(html) {
  const s = html.search(/id=["']prdDetail["']/)
  if (s < 0) return ''
  const region = html.slice(s)
  const e = region.slice(20).search(/id=["'](?:prdInfo|prdReview|prdQnA|prdQna|prdRelated)["']/)
  return e > 0 ? region.slice(0, e + 20) : region.slice(0, 400000)
}
function parseOptions(html) {
  const opts = []
  for (const sel of html.matchAll(/<select[^>]+(?:id|name)=["'][^"']*option[^"']*["'][\s\S]*?<\/select>/gi)) {
    const names = [...sel[0].matchAll(/<option[^>]*value=["'][^"'*]+["'][^>]*>([^<]+)<\/option>/g)].map(o => decodeEnt(o[1]).trim()).filter(t => t && !/^(필수|선택|옵션|=+|-{2,}|\.{2,}|\*)/.test(t))
    if (names.length) opts.push(names)
  }
  return opts
}
function parseShipping(t) {
  if (!t) return { fee: null, tiers: null }
  const tiers = [...t.matchAll(/(\d+)\s*개\s*이상\s*~\s*(\d+)\s*개\s*미만\s*([\d,]+)\s*원/g)].map(m => ({ min: +m[1], max: +m[2] - 1, fee: toInt(m[3]) }))
  const fee = tiers.length ? tiers[0].fee : (/무료/.test(t) && !/[\d,]{4,}\s*원/.test(t) ? 0 : won(t))
  return { fee, tiers: tiers.length ? tiers : null }
}

// ── MSP 탐지 ──
const MSP_IMG_FILE = /docs\.google\.com|EC8AA4ED81ACEBA6B0EC83B7|ECB59CECA080/i // 스크린샷_*_docs.google.com / 파일명 '최저'
const UNIT = '(?:통|개|박스|봉|병|팩|세트|포|ea|EA)'
// "1통 / 18,160" · "2개 묶음 ₩78,916" · "1개 30,000원"(옵션상품 106~111 — 구분자 없이 공백이면 '원' 필수)
const tierRe = () => new RegExp(`(\\d{1,2})\\s*${UNIT}\\s*(?:묶음)?\\s*(?:(?:[/:：]\\s*₩?|₩)\\s*([\\d,]{4,})|([\\d,]{4,})\\s*원)`, 'g')
const KW_RE = /최저\s*(?:판매)?\s*가(?!\s*(?:규제|보장))/ // "폐쇄몰은 최저가 규제 대상…" 문구 제외

// 키워드 바로 뒤(120자)에서는 구분자·'원' 없이 "최저가 제한 1통 24,900"도 인정 (상품 215·216)
const tierReLoose = () => new RegExp(`(\\d{1,2})\\s*${UNIT}\\s*(?:묶음)?\\s*(?:[/:：]\\s*₩?|₩)?\\s*([\\d,]{4,})`, 'g')

function collectTiers(s, re = tierRe) {
  const t = {}
  for (const m of s.matchAll(re())) { const n = +m[1]; const p = toInt(m[2] ?? m[3]); if (n >= 1 && n <= 20 && p >= 1000 && p <= 3_000_000 && !(n in t)) t[n] = p }
  return t
}
function parseMspText(input) {
  const text = input.replace(/(\d)\.(\d{3})(?!\d)/g, '$1,$2') // "19.400" 처럼 점을 천단위로 쓴 경우(상품 439)
  const k = text.search(KW_RE)
  let tiers = k >= 0 ? collectTiers(text.slice(k, k + 400)) : {}
  if (k >= 0 && !Object.keys(tiers).length) tiers = collectTiers(text.slice(k, k + 120), tierReLoose)
  // 제목 없이 "1통 / 19,800 2통 / …"만 있는 형태(상품 163) → 2구간 이상일 때만 인정
  if (!Object.keys(tiers).length) { const all = collectTiers(text); if (Object.keys(all).length >= 2) tiers = all }
  const qs = Object.keys(tiers).map(Number).sort((a, b) => a - b)
  if (qs.length) {
    const monotonic = qs.every((q, i) => i === 0 || tiers[q] > tiers[qs[i - 1]])
    const at = k >= 0 ? k : Math.max(0, text.search(new RegExp(`\\d{1,2}\\s*${UNIT}\\s*(?:묶음)?\\s*(?:[/:：]|₩|[\\d,]{4,}\\s*원)`)))
    const raw = text.slice(k >= 0 ? k : Math.max(0, at - 20), at + 260)
    return { source: 'text_tier', price: tiers[1] ?? null, tiers: qs.length > 1 ? tiers : null, raw, review: !monotonic || tiers[1] == null || /그룹/.test(raw) }
  }
  if (k >= 0) {
    const raw = text.slice(k, k + 200)
    const m = raw.match(/^최저\s*(?:판매)?\s*가(?:격)?\s*(?:제한|권장|준수)?[^\d₩]{0,25}₩?\s*([\d,]{4,})/)
    const p = m ? toInt(m[1]) : null
    if (p && p >= 1000 && p <= 3_000_000) return { source: 'text_single', price: p, tiers: null, raw, review: /그룹/.test(raw) }
  }
  return null
}

// ── 목록 ──
async function listCategory(cateNo) {
  const out = []; const seen = new Set()
  for (let page = 1; page <= 40; page++) {
    const r = await fx(`${BASE}/product/list.html?cate_no=${cateNo}&page=${page}`)
    if (!r.ok) break
    let html = await r.text()
    const start = html.search(/xans-product-listnormal/)
    if (start > 0) html = html.slice(start)
    const cut = html.search(/ec-base-paginate/)
    if (cut > 0) html = html.slice(0, cut)
    const blocks = [...html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)]
    let fresh = 0
    for (const b of blocks) {
      if (seen.has(b[1])) continue
      seen.add(b[1]); fresh++
      out.push({ no: b[1], soldout: /ico_product_soldout|alt=["']품절["']/i.test(b[2]) })
    }
    if (!fresh) break
    await sleep(200)
  }
  return out
}

// ── 상세 ──
async function fetchDetail(no, meta) {
  const detailUrl = `${BASE}/product/detail.html?product_no=${no}`
  const r = await fx(detailUrl)
  if (!r.ok) return { product_no: no, err: `HTTP ${r.status}` }
  const html = await r.text()
  const title = decodeEnt(jsVar(html, 'product_name') || '').replace(/\s+/g, ' ').trim()
  if (!title) return { product_no: no, err: '제목 파싱 실패' }
  const info = infoTable(html)

  const tags = title.match(/\[[^\]]*\]|\{[^}]*\}/g) || []
  const tagStr = tags.join(' ')
  const cateNos = [...(meta?.cates ?? [])]
  let excluded = null
  if (!cateNos.some(c => RESELL_CATES.has(c))) excluded = '재판매 불가 카테고리(소량제조·BPS·부가서비스)'
  else if (EXCLUDE_NAME.test(title)) excluded = '재판매 불가 상품(BPS·예치금·디자인변경·MOQ)'
  else if (/판촉/.test(tagStr)) excluded = '판촉용'
  else if (/소비기한/.test(tagStr)) excluded = '소비기한 임박 행사'
  const status = /단종|판매\s*종료/.test(tagStr) ? 'discontinued'
    : (/품절/.test(tagStr) || meta?.soldout) ? 'soldout'
      : /입고/.test(tagStr) ? 'restock_wait' : 'active'

  // MSP
  const region = detailRegion(html)
  const imgs = [...region.matchAll(/<img\b[^>]*>/gi)].map(m => (m[0].match(/\bec-data-src=["']([^"']+)["']/i) || m[0].match(/\bsrc=["']([^"']+)["']/i) || [])[1] || '').filter(Boolean)
  const b64 = imgs.find(s => s.startsWith('data:image')) || null
  const fileImg = imgs.find(s => !s.startsWith('data:') && MSP_IMG_FILE.test(s)) || null
  const t = parseMspText(htmlToText(region))
  let imageHash = null
  if (fileImg) { try { imageHash = sha(Buffer.from(await (await fetch(abs(fileImg))).arrayBuffer())) } catch { imageHash = null } }
  else if (b64) imageHash = sha(b64)
  const detectedSource = t ? t.source : fileImg ? 'img_file' : b64 ? 'img_b64' : 'none'

  const ship = parseShipping(info['배송비'])
  const opts = parseOptions(html)
  const og = (html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) || [])[1]
  const mains = [...new Set([...html.matchAll(/["']((?:https?:)?\/\/[^"']*\/web\/product\/(?:big|extra\/big)\/[^"']+\.(?:jpe?g|png|gif|webp))["']/gi)].map(m => abs(m[1])))].slice(0, 5)
  const detailImages = [...new Set(imgs.filter(s => !s.startsWith('data:') && !MSP_IMG_FILE.test(s) && /\/web\/upload\//.test(s) && !/echosting\.cafe24\.com/.test(s)).map(abs))]

  return {
    product_no: String(no),
    product_code: jsVar(html, 'product_code'),
    detail_url: detailUrl,
    title,
    title_clean: title.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim(),
    name_tags: tags.map(x => x.slice(1, -1).trim()),
    brand: tags.map(x => x.slice(1, -1).trim()).find(x => /^(웰루아|살므시)$/.test(x)) || null,
    cate_nos: cateNos,
    cate_labels: cateNos.map(c => CATES[c] || c),
    is_health_functional: cateNos.includes('24') || /건기식/.test(tagStr),
    supply_price_krw: toInt(jsVar(html, 'product_price')),
    list_price_krw: won(info['소비자가']),
    msp_detected_krw: t?.price ?? null,
    msp_detected_tiers: t?.tiers ?? null,
    msp_detected_source: detectedSource,
    msp_raw_text: t?.raw ?? null,
    msp_image_url: fileImg ? abs(fileImg) : null,
    msp_image_b64: fileImg ? null : b64,
    msp_image_hash: imageHash,
    _review: !!t?.review,
    shipping_fee_krw: ship.fee,
    shipping_tiers: ship.tiers,
    shipping_text: info['배송비'] || null,
    has_option: jsVar(html, 'has_option') === 'T',
    options: opts.length ? opts : null,
    min_qty: intOrNull(jsVar(html, 'product_min')),
    max_qty: intOrNull(jsVar(html, 'product_max')),
    stock_qty: info['재고 수량'] ? toInt(info['재고 수량']) : null,
    status,
    soldout_icon: !!meta?.soldout,
    resellable: !excluded,
    closed_mall_only: /폐쇄몰\s*전용/.test(tagStr),
    excluded_reason: excluded,
    thumb_url: abs(og) || mains[0] || null,
    images_main: mains,
    detail_images: detailImages,
    summary_text: info['상품요약정보'] || null,
    raw_info: info,
  }
}

const hashOf = d => sha(JSON.stringify([d.title, d.supply_price_krw, d.list_price_krw, d.msp_detected_source, d.msp_detected_krw, d.msp_detected_tiers, d.msp_image_hash, d.status, d.soldout_icon, d.resellable, d.closed_mall_only, d.excluded_reason, d.shipping_text, d.cate_nos, d.options, d.stock_qty, d.thumb_url, (d.detail_images || []).join('|')]))

// 유효 MSP 결정: manual(·같은 이미지의 ocr)은 보존, 그 외엔 탐지값을 유효값으로
function applyEffective(row, ex, detectReview) {
  const keep = ex && (ex.msp_source === 'manual' || (ex.msp_source === 'ocr' && ex.msp_image_hash === row.msp_image_hash))
  if (keep) {
    const detectedChanged = (row.msp_detected_krw ?? null) !== (ex.msp_detected_krw ?? null)
    const mismatch = row.msp_detected_krw != null && row.msp_detected_krw !== ex.msp_price_krw
    row.msp_review_needed = detectedChanged && mismatch ? true : !!ex.msp_review_needed
    return { price: ex.msp_price_krw, source: ex.msp_source }
  }
  row.msp_price_krw = row.msp_detected_krw
  row.tiered_msp = row.msp_detected_tiers
  row.msp_source = row.msp_detected_source
  row.msp_review_needed = !!detectReview
  return { price: row.msp_price_krw, source: row.msp_source }
}

// ── main ──
await login()
console.log(`✓ wellroot login${DRY ? ' [DRY — DB 미기록]' : ''}`)

const meta = new Map()
for (const [c, label] of Object.entries(CATES)) {
  const items = await listCategory(c)
  for (const it of items) {
    const m = meta.get(it.no) || { cates: new Set(), soldout: false }
    m.cates.add(c); if (it.soldout) m.soldout = true
    meta.set(it.no, m)
  }
  if (VERBOSE) console.log(`  cate ${c} ${label}: ${items.length}`)
}
let ids = [...meta.keys()]
if (ONLY.size) {
  const missing = [...ONLY].filter(n => !meta.has(n))
  if (missing.length) console.log(`⚠ 카테고리 목록에 없는 상품번호: ${missing.join(',')}`)
  ids = ids.filter(n => ONLY.has(n))
}
if (LIMIT) ids = ids.slice(0, LIMIT)
console.log(`목록: 전체 ${meta.size}개 → 상세 수집 ${ids.length}개 (동시 ${CONC})`)

const existing = new Map()
if (!DRY) {
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(TABLE).select('product_no, content_hash, msp_source, msp_price_krw, msp_image_hash, msp_detected_krw, msp_review_needed').range(off, off + 999)
    if (error) throw new Error(`기존행 조회 실패: ${error.message} (supabase/wellroot_products.sql 적용 여부 확인)`)
    for (const r of data) existing.set(r.product_no, r)
    if (data.length < 1000) break
  }
}

const results = []
let cursor = 0
async function worker() {
  while (cursor < ids.length) {
    const no = ids[cursor++]
    try { results.push(await fetchDetail(no, meta.get(no))) } catch (e) { results.push({ product_no: no, err: e.message }) }
    if (results.length % 50 === 0) console.log(`  … ${results.length}/${ids.length}`)
    await sleep(250)
  }
}
await Promise.all(Array.from({ length: CONC }, worker))

const ok = results.filter(r => !r.err)
const errs = results.filter(r => r.err)
const priceMissing = ok.filter(r => r.resellable && !r.supply_price_krw).length
if (ok.length >= 10 && priceMissing / ok.length > 0.1) {
  console.error(`✗ 공급가 0/누락 ${priceMissing}/${ok.length} — 로그인 세션 문제 의심, 저장 중단`)
  process.exit(1)
}

let changed = 0, unchanged = 0, failed = 0
const summary = []
for (const d of ok) {
  const { _review, ...row } = d
  row.content_hash = hashOf(d)
  const ex = existing.get(row.product_no)
  const eff = applyEffective(row, ex, _review)
  summary.push({ ...row, eff })
  if (VERBOSE || ids.length <= 40) {
    const flag = !row.resellable ? '⛔' : row.closed_mall_only ? '🔒' : eff.price ? '✅' : '❓'
    console.log(`  ${flag} ${row.product_no.padStart(4)} ${row.title.slice(0, 30).padEnd(30)} 공급 ${row.supply_price_krw ?? '-'} | MSP ${row.msp_detected_source}${row.msp_detected_krw ? ':' + row.msp_detected_krw : ''}${row.msp_detected_tiers ? '(구간 ' + Object.keys(row.msp_detected_tiers).length + ')' : ''}${eff.source === 'manual' ? ' [유효 manual:' + eff.price + ']' : ''} | ${row.status}${row.excluded_reason ? ' · ' + row.excluded_reason : ''}`)
  }
  if (DRY) continue
  const now = new Date().toISOString()
  if (ex && ex.content_hash === row.content_hash) {
    const { error } = await sb.from(TABLE).update({ last_seen_at: now, status: row.status }).eq('product_no', row.product_no)
    if (error) { failed++; console.log(`  ✗ update ${row.product_no} ${error.message}`) } else unchanged++
  } else {
    const { error } = await sb.from(TABLE).upsert({ ...row, last_seen_at: now, last_changed_at: now, updated_at: now }, { onConflict: 'product_no' })
    if (error) { failed++; console.log(`  ✗ upsert ${row.product_no} ${error.message}`) } else changed++
  }
}

let gone = 0
if (FULL_RUN && !DRY && meta.size > 100) {
  const { data, error } = await sb.from(TABLE).update({ status: 'gone', updated_at: new Date().toISOString() }).not('product_no', 'in', `(${[...meta.keys()].join(',')})`).neq('status', 'gone').select('product_no')
  if (error) console.log(`  ✗ gone 처리 실패 ${error.message}`); else gone = data.length
}

// ── 리포트 ──
const cand = summary.filter(r => r.resellable)
const cnt = (arr, f) => arr.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o }, {})
console.log(`\n=== 상세 ${ok.length}건 수집 (실패 ${errs.length}) · 재판매 후보 ${cand.length} · 제외 ${ok.length - cand.length} ===`)
console.log('제외 사유:', cnt(summary.filter(r => !r.resellable), r => r.excluded_reason))
console.log('후보 MSP 탐지:', cnt(cand, r => r.msp_detected_source))
console.log('후보 상태:', cnt(cand, r => r.status), `· 폐쇄몰전용 ${cand.filter(r => r.closed_mall_only).length} · 건기식 ${cand.filter(r => r.is_health_functional).length}`)
const eligible = cand.filter(r => !r.closed_mall_only && r.status === 'active' && r.eff.price > 0)
console.log(`쿠팡 등록 대상(유효 MSP 있음·판매중·폐쇄몰 아님): ${eligible.length}`)
const noMsp = cand.filter(r => !r.eff.price && r.msp_detected_source === 'none' && !r.closed_mall_only && !['discontinued', 'gone'].includes(r.status))
console.log(`\n❓ MSP 없음 → 등록 제외, /admin/wellroot-msp 에서 입력 (${noMsp.length})`)
for (const r of noMsp) console.log(`   ${r.product_no.padStart(4)} ${r.title.slice(0, 40)} (공급 ${r.supply_price_krw ?? '-'})`)
const imgMsp = cand.filter(r => !r.eff.price && r.msp_detected_source.startsWith('img_'))
console.log(`🖼️ 이미지 MSP (OCR/사람 입력 대기): ${imgMsp.length}`)
const review = summary.filter(r => r.msp_review_needed)
if (review.length) { console.log(`⚠️ 검수 필요 (${review.length})`); for (const r of review) console.log(`   ${r.product_no.padStart(4)} ${r.title.slice(0, 36)} | ${(r.msp_raw_text || '').slice(0, 70)}`) }
if (errs.length) { console.log(`✗ 실패 (${errs.length})`); for (const e of errs) console.log(`   ${e.product_no} ${e.err}`) }
if (!DRY) console.log(`\nDB: 변동 upsert ${changed} · 무변동 ${unchanged} · 실패 ${failed} · gone ${gone}`)
