#!/usr/bin/env node
/**
 * K-홀세일(kwholesale.co.kr, Cafe24 · (주)다인내추럴 · 브랜드 웰러스) 상품 수집 → jimscanner_kwholesale_products
 * 설계: docs/plan-kwholesale.md §3 · DDL: supabase/kwholesale_products.sql
 *
 *   node scripts/kwholesale-collect.mjs [--dry] [--only=471,176] [--limit=N] [--verbose] [--no-dain] [--refresh-dain]
 *
 * 소스 3종을 합친다:
 *   ① K홀세일 상세(사업자회원 로그인 쿠키) — 소비자가·도매가격·온라인최저가·배송비·자체상품코드·수량제한·품절·이미지
 *   ② 제품리스트 구글시트(공지 링크, 공개 CSV export) — 규격·바코드·유통기한·CODE(필준수)·제조사몰 링크
 *   ③ dainnatural.com 상품페이지(공개) — 고시정보 표(table.dain_info): 식품유형·제조원·원재료·기능정보 …
 *
 * 판매가 하한(MSP, docs §2 — 위반 시 영구탈퇴·출고정지): 무료배송 기준 소비자가 + 3,000원,
 *   2개 ×0.95 / 3개 ×0.90 (price_locked 면 할인 없음). 소비자가는 사이트·시트·온라인최저가 중 **높은 값**(보수적), 100원 올림.
 * 로그인: Cafe24 AuthSSL 이라 raw POST 불가 → 헤드리스 Chrome 로그인 후 쿠키만 fetch 에 이식(wellroot-collect 패턴).
 * 안전장치: 상세 10건 이상에서 도매가 누락 >10% 면 세션 문제로 보고 저장하지 않는다.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.KWHOLESALE_BASE_URL || 'https://kwholesale.co.kr'
const TABLE = 'jimscanner_kwholesale_products'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1igLeiRdwCblThmt5B6agSVTEE05jubP51IrXJWrhsjU/export?format=csv&gid=708786745'
const SHOP_ONLY_CATE = '79'            // shop(매장전용) — 오프라인 매장 운영자 전용
const FREE_SHIP_ADD = 3000             // 무료배송 판매 시 소비자가에 더하는 금액(공지)
const EXPIRY_MIN_DAYS = 180            // 유통기한 임박 제외 기준
const SHIP = 3000, FEE = 0.106         // src/lib/coupang/price.ts 와 동일 상수(매입 배송비·쿠팡 수수료)

const argv = process.argv.slice(2)
const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = argv.includes('--dry')
const VERBOSE = argv.includes('--verbose')
const NO_DAIN = argv.includes('--no-dain')
const REFRESH_DAIN = argv.includes('--refresh-dain')
const ONLY = new Set((arg('only') || '').split(',').map(s => s.trim()).filter(s => /^\d{1,7}$/.test(s)))  // 상품번호(숫자)만 — URL에 그대로 들어감
const LIMIT = +(arg('limit') || 0)
const CONC = Math.max(1, +(arg('concurrency') || 3))
// 판매가 규칙(사용자 결정 2026-09-27): 판매가 = max(최저판매가 MSP, 목표 순마진 가격) — 전 상품·묶음 공통.
// 목표 순마진 가격 = ceil(0.9091 × 원가 / (0.8031 − m) / 100) × 100 (수수료 10.6% + 순VAT, 매입 입력VAT 공제) — wellroot-register.mjs 와 같은 마진 계산기
const TARGET_NET = +(arg('min-margin') ?? 0.10)
const FULL_RUN = !ONLY.size && !LIMIT
const sleep = ms => new Promise(s => setTimeout(s, ms))

if (!env.KWHOLESALE_USER || !env.KWHOLESALE_PASS) { console.error('.env.local 에 KWHOLESALE_USER / KWHOLESALE_PASS 필요'); process.exit(1) }

// ── 세션(쿠키 이식 fetch) ──
const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const eq = kv.indexOf('='); if (eq < 0) continue; const k = kv.slice(0, eq).trim(); const v = kv.slice(eq + 1).trim(); if (k) cookies.set(k, v) } }
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function fx(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml', Cookie: cookieHeader(), ...(init.headers || {}) } })
  setCookies(res.headers.get('set-cookie'))
  return res
}
async function login() {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  let grade = null
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' })
    const page = await ctx.newPage()
    let dialogMsg = null
    page.on('dialog', d => { dialogMsg = d.message(); d.dismiss().catch(() => {}) })
    await page.goto(`${BASE}/member/login.html`, { waitUntil: 'load', timeout: 45000 })
    // 스킨 스크립트가 로드 직후 입력값을 지우는 경우가 있어 값이 남을 때까지 재입력(AuthSSL)
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(600)
      await page.locator('#member_id').fill(env.KWHOLESALE_USER)
      await page.locator('#member_passwd').fill(env.KWHOLESALE_PASS)
      if ((await page.locator('#member_id').inputValue()) === env.KWHOLESALE_USER && (await page.locator('#member_passwd').inputValue()) === env.KWHOLESALE_PASS) break
    }
    await Promise.all([
      page.waitForURL(u => !/\/member\/login\.html/.test(u.toString()), { timeout: 30000 }).catch(() => { throw new Error(`kwholesale 로그인 실패${dialogMsg ? ': ' + dialogMsg : ' (로그인 페이지에서 이동 안 됨)'}`) }),
      page.press('#member_passwd', 'Enter'),
    ])
    for (const c of await ctx.cookies(BASE)) cookies.set(c.name, c.value)
    // 회원등급은 화면 스크립트가 채워 넣어 raw HTML 엔 없다 → 렌더된 마이쇼핑에서 읽는다("회원등급은 사업자회원 입니다")
    await page.goto(`${BASE}/myshop/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1200)
    grade = await page.evaluate(() => (document.body.innerText.replace(/\s+/g, ' ').match(/회원등급은\s*(\S+?)\s*입니다/) || [])[1] || null).catch(() => null)
  } finally {
    await browser.close()
  }
  const r = await fx(`${BASE}/myshop/index.html`)
  if (r.status >= 300 && /login/.test(r.headers.get('location') || '')) throw new Error('kwholesale 로그인 세션 이식 실패 (myshop → login 리다이렉트)')
  return grade
}

// ── 파싱 유틸 ──
const decodeEnt = s => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#8203;/g, '')
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'font', 'u', 'i', 'em', 'a', 'small', 'sup', 'sub', 'mark', 's', 'strike', 'label'])
const htmlToText = h => decodeEnt((h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (_, t) => (INLINE_TAGS.has(t.toLowerCase()) ? '' : ' '))).replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim()
const toInt = s => { const n = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null }
const intOrNull = s => { const n = parseInt(String(s ?? ''), 10); return Number.isFinite(n) && n >= 0 ? n : null }
const abs = u => (!u ? null : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? BASE + u : u)
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const jsVar = (html, k) => { const m = html.match(new RegExp(`var\\s+${k}\\s*=\\s*'((?:\\\\.|[^'])*)'`)); return m ? m[1] : null }
const ceil100 = n => Math.ceil(n / 100) * 100

function infoTable(html) {
  const i = html.search(/xans-product-detaildesign/)
  if (i < 0) return {}
  const map = {}
  for (const m of html.slice(i, i + 30000).matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const th = htmlToText(m[1]); const td = htmlToText(m[2])
    if (th && td && th.length < 30 && !(th in map)) map[th] = td.slice(0, 1000)
  }
  return map
}
// 상세 본문 = div.productDetail ~ 관련상품(xans-product-relation) 앞.
// 이 스킨은 상세 본문 바로 뒤에 관련상품 썸네일 블록이 와서, 웰루트식(prdReview 까지) 경계면 남의 상품 썸네일 8장이 섞인다(2026-09-27 실측).
function detailRegion(html) {
  let s = html.search(/class=["']productDetail["']/)
  if (s < 0) s = html.search(/id=["']prdDetail["']/)
  if (s < 0) return ''
  const region = html.slice(s)
  const e = region.slice(20).search(/xans-product-relation|id=["'](?:prdInfo|prdReview|prdQnA|prdQna|prdRelated)["']/)
  return e > 0 ? region.slice(0, e + 20) : region.slice(0, 400000)
}
// 상세 이미지 파일명은 한글을 16진수로 인코딩한 형태('EC868CEBB984EC9E90EAB080' = 소비자가) → 풀어서 내용 판정
// 숫자만 있는 구간(타임스탬프 등)은 풀지 않는다 — 한글 UTF-8 16진수에는 A~F 가 반드시 섞인다
const decodeHexName = s => String(s || '').replace(/(?:[0-9A-F]{2}){3,}/g, (h) => { if (!/[A-F]/.test(h)) return h; try { return Buffer.from(h, 'hex').toString('utf8') } catch { return h } })
// 소비자 상세에 나가면 안 되는 판매자용 공지·홍보 배너(실측: '소비자가 절대 준수' 가격정책 안내, '대형-상단-썸네일' 선물세트 홍보)
const SELLER_ONLY_IMG_RE = /소비자가|준수|최저가|도매|위탁|사업자|공지|썸네일|바로가기|판매시|할인\s*정책/
const isDetailContentImage = (u) => !/\/web\/product\/(?:medium|small|tiny|list|extra\/small)\//.test(u) && !SELLER_ONLY_IMG_RE.test(decodeHexName(decodeURIComponent(u.split('/').pop() || '')))
function parseShipping(t) {
  if (!t) return { fee: null, threshold: null }
  const fee = /무료/.test(t) && !/[\d,]{4,}\s*원\s*\(/.test(t) ? 0 : toInt((t.match(/([\d,]+)\s*원/) || [])[1])
  const threshold = toInt((t.match(/([\d,]+)\s*원\s*이상/) || [])[1])
  return { fee, threshold }
}
// 날짜: '2028-6-7' · '2028/05/05' · '2027.11.23' → 'YYYY-MM-DD'
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return isNaN(d) ? null : d.toISOString().slice(0, 10)
}

// ── ② 제품리스트 시트 ──
function parseCsv(t) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) { if (c === '"' && t[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = '' }
    else f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  return rows
}
async function loadSheet() {
  const r = await fetch(SHEET_CSV, { redirect: 'follow' })
  if (!r.ok || !/csv/.test(r.headers.get('content-type') || '')) throw new Error(`제품리스트 시트 다운로드 실패 HTTP ${r.status} (${r.headers.get('content-type')}) — 공개 설정이 바뀌었을 수 있음`)
  const rows = parseCsv(await r.text())
  const hi = rows.findIndex(r => r[0]?.trim() === '품목코드')
  if (hi < 0) throw new Error('제품리스트 시트 헤더(품목코드) 못 찾음 — 시트 구조 변경 의심')
  const H = rows[hi].map(h => h.trim())
  const col = n => H.indexOf(n)
  const map = new Map()
  for (const r of rows.slice(hi + 1)) {
    const code = (r[0] || '').trim().toLowerCase()
    if (!/^[a-z]{2,5}\d+$/.test(code)) continue
    map.set(code, {
      name: r[col('품목명')]?.trim() || null,
      spec: r[col('규격')]?.trim() || null,
      consumer: toInt(r[col('소비자가')]) || null,
      barcode: /^\d{8,14}$/.test((r[col('바코드')] || '').trim()) ? r[col('바코드')].trim() : null,
      brand_group: r[col('품목그룹1명')]?.trim() || null,
      expiry: parseDate(r[col('유통기한(품목)')]),
      code: r[col('CODE')]?.trim() || null,
      link: /^https?:/.test((r[col('Home Link')] || '').trim()) ? r[col('Home Link')].trim() : null,
    })
  }
  return map
}

// ── ③ 제조사몰 고시정보 ──
async function fetchDainNotice(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR' } })
  if (!r.ok) return { err: `HTTP ${r.status}` }
  const html = await r.text()
  const s = html.search(/class=["'][^"']*dain_info/)
  if (s < 0) return { err: '고시 표 없음' }
  const table = html.slice(s, s + 60000).split(/<\/table>/i)[0]
  const info = {}
  for (const m of table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/g)) {
    const k = htmlToText(m[1]).replace(/\s+/g, ' ').trim(); const v = htmlToText(m[2]).trim()
    if (k && v && k.length < 40 && !(k in info)) info[k] = v.slice(0, 3000)
  }
  return Object.keys(info).length ? { info } : { err: '고시 항목 파싱 0' }
}
const pick = (info, re) => { if (!info) return null; const k = Object.keys(info).find(x => re.test(x)); return k ? info[k] : null }

// ── ① 목록 ──
async function discoverCategories() {
  const r = await fx(`${BASE}/`)
  const html = await r.text()
  const cates = new Map()
  for (const m of html.matchAll(/href=["']\/category\/([^/"']+)\/(\d+)\/["']/g)) { if (!cates.has(m[2])) cates.set(m[2], decodeURIComponent(m[1])) }
  return cates
}
// 등급 제한 페이지: Cafe24 가 본문 없이 alert('대리점회원만 접근권한이 있습니다.') 후 첫 화면으로 돌려보낸다(실측 cate 79·81·84·92)
const restrictedAlert = html => (html.length < 2000 && (html.match(/alert\(\s*['"]([^'"]*(?:회원만|접근\s*권한|권한이\s*없)[^'"]*)['"]/) || [])[1]) || null
async function listCategory(cateNo) {
  const out = []; const seen = new Set()
  for (let page = 1; page <= 40; page++) {
    const r = await fx(`${BASE}/product/list.html?cate_no=${cateNo}&page=${page}`)
    if (!r.ok) break
    let html = await r.text()
    const denied = restrictedAlert(html)
    if (denied) { out.restricted = denied; break }
    const start = html.search(/xans-product-listnormal|anchorBoxId_/)
    if (start > 0) html = html.slice(start)
    const cut = html.search(/ec-base-paginate/)
    if (cut > 0) html = html.slice(0, cut)
    let fresh = 0
    for (const b of html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)) {
      if (seen.has(b[1])) continue
      seen.add(b[1]); fresh++
      out.push({
        no: b[1],
        soldout: /ico_product_soldout|alt=["'][^"']*품절|>\s*SOLD\s*OUT\s*</i.test(b[2]),
        listConsumer: toInt((b[2].match(/ec-data-custom=["']([\d.,]+)["']/) || [])[1]),
        listPrice: toInt((b[2].match(/ec-data-price=["']([\d.,]+)["']/) || [])[1]),
      })
    }
    if (!fresh) break
    await sleep(200)
  }
  return out
}

// ── ① 상세 ──
async function fetchDetail(no, meta) {
  const detailUrl = `${BASE}/product/detail.html?product_no=${no}`
  const r = await fx(detailUrl)
  if (r.status >= 300 && r.status < 400) return { product_no: no, err: `리다이렉트 ${r.headers.get('location') || ''}` }
  if (!r.ok) return { product_no: no, err: `HTTP ${r.status}` }
  const html = await r.text()
  // 매장전용(대리점회원 전용) 상품은 상세도 등급 제한 alert 만 온다 → 오류가 아니라 매장전용으로 기록(등록 제외)
  const denied = restrictedAlert(html)
  if (denied) return { product_no: String(no), restricted: denied }
  const info = infoTable(html)
  const ogTitle = decodeEnt((html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) || [])[1] || '')
  const title = (info['상품명'] || ogTitle || '').replace(/\s+/g, ' ').trim()
  if (!title) return { product_no: no, err: '제목 파싱 실패' }
  const tags = title.match(/\[[^\]]*\]/g) || []
  const tagStr = tags.join(' ')
  const soldoutBox = html.match(/class=["']ec-base-button\s+soldout\b([^"']*)["']/)
  const soldout = (soldoutBox ? !/displaynone/.test(soldoutBox[1]) : false) || !!meta?.soldout
  const ship = parseShipping(info['배송비'])
  const og = (html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) || [])[1]
  const mains = [...new Set([...html.matchAll(/["']((?:https?:)?\/\/[^"']*\/web\/product\/(?:big|extra\/big)\/[^"']+\.(?:jpe?g|png|gif|webp))["']/gi)].map(m => abs(m[1])))].slice(0, 5)
  const region = detailRegion(html)
  const detailImages = [...new Set([...region.matchAll(/<img\b[^>]*>/gi)]
    .map(m => (m[0].match(/\bec-data-src=["']([^"']+)["']/i) || m[0].match(/\bsrc=["']([^"']+)["']/i) || [])[1] || '')
    .filter(s => s && !s.startsWith('data:') && !/echosting\.cafe24\.com|\/icon|btn_|blank\.gif/i.test(s)).map(abs))]
    .filter(isDetailContentImage)
  const cateNos = [...(meta?.cates ?? [])]
  return {
    product_no: String(no),
    custom_code: (info['자체상품코드'] || '').trim().toLowerCase() || null,
    detail_url: detailUrl,
    title,
    title_clean: title.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
    name_tags: tags.map(x => x.slice(1, -1).trim()),
    summary_text: info['상품요약정보'] || null,
    cate_nos: cateNos,
    is_shop_only: cateNos.includes(SHOP_ONLY_CATE),
    is_sample: /시음|판촉|샘플|증정/.test(tagStr) || /시음용|판촉용|샘플/.test(title),
    consumer_price_krw: toInt(info['소비자가']) || meta?.listConsumer || null,
    wholesale_price_krw: toInt(info['도매가격']) || meta?.listPrice || null,
    online_min_price_krw: toInt(info['온라인최저가']) || null,
    shipping_fee_krw: ship.fee,
    free_ship_threshold_krw: ship.threshold,
    shipping_text: info['배송비'] || null,
    min_qty: intOrNull(jsVar(html, 'product_min')),
    max_qty: intOrNull(jsVar(html, 'product_max')) || null,   // 0 = 제한 없음
    soldout,
    status: soldout ? 'soldout' : 'active',
    thumb_url: abs(og) || mains[0] || null,
    images_main: mains,
    detail_images: detailImages,
    raw_info: info,
  }
}

// ── 결합·판정 ──
// 이름 정규화(결합 보조·검증용): 괄호·기호·공백 제거, 소문자
const normName = s => String(s || '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^0-9a-z가-힣]/g, '')
// 이름 유사도 = 띄어쓰기 무시 글자쌍(bigram) Dice — 시트 이름은 붙여쓰기('도둑다이어트포스콜린')라 단어 비교는 오탐(27건 실측)
const bigrams = s => { const n = normName(s); const out = new Map(); for (let i = 0; i < n.length - 1; i++) { const g = n.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1) } return out }
function nameSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b); let inter = 0, na = 0, nb = 0
  for (const [g, c] of A) { na += c; inter += Math.min(c, B.get(g) || 0) }
  for (const c of B.values()) nb += c
  return na + nb ? (2 * inter) / (na + nb) : 0
}
// 코드로 못 찾으면 이름이 **유일하게** 같고 소비자가도 같은 시트 행만 인정(사이트 코드≠시트 코드 실측: 폴리시아 wls429↔wls195)
function sheetByName(sheet, row) {
  const n = normName(row.title)
  if (n.length < 4 || !row.consumer_price_krw) return null
  const hits = [...sheet.values()].filter(s => normName(s.name) === n)
  return hits.length === 1 && hits[0].consumer === row.consumer_price_krw ? hits[0] : null
}
function enrich(row, sheet, today) {
  let s = row.custom_code ? sheet.get(row.custom_code) : null
  row.sheet_match_method = s ? 'code' : null
  if (!s) { s = sheetByName(sheet, row); if (s) row.sheet_match_method = 'name' }
  // 결합 검증: 코드로 붙었어도 이름이 전혀 다르면(유사도 0.3 미만) 다른 상품 행일 수 있다 → 확인 필요
  if (s && row.sheet_match_method === 'code') row.sheet_name_suspect = nameSimilarity(row.title, s.name) < 0.3 ? s.name : null
  row.sheet_matched = !!s
  row.spec = s?.spec ?? null
  row.barcode = s?.barcode ?? null
  row.brand_group = s?.brand_group ?? null
  row.expiry_date = s?.expiry ?? null
  row.sheet_code = s?.code ?? null
  row.sheet_consumer_price_krw = s?.consumer ?? null
  row.dain_url = s?.link ?? null
  row.expiry_short = !!(row.expiry_date && (new Date(row.expiry_date) - today) / 864e5 < EXPIRY_MIN_DAYS)
  // 할인불가 근거 — 시트에 없는 상품은 필준수 여부를 알 수 없어 보수적으로 잠근다(묶음 할인 미적용)
  row.price_lock_source = row.online_min_price_krw ? 'online_min' : row.sheet_code === '필준수' ? 'sheet' : !s ? 'unknown' : null
  row.price_locked = !!row.price_lock_source
  row.price_mismatch = !!(row.sheet_consumer_price_krw && row.consumer_price_krw && row.sheet_consumer_price_krw !== row.consumer_price_krw)
  // 30% 넘게 다르면 코드 공유(샘플↔본품)·가격 변경 의심 → 사람 확인 전 등록 제외
  // 소비자가 사이트≠시트는 더 이상 막지 않는다(사용자 결정 2026-09-27): 하한은 높은 쪽 기준이라 위반이 안 되고, 판매가는 max(MSP, 마진가) 규칙.
  // 막는 건 코드는 같은데 이름이 전혀 다른 경우뿐 — 바코드·유통기한이 남의 상품 것일 수 있다.
  row.needs_review = !!row.sheet_name_suspect
  // 하한 기준: 사이트·시트·온라인최저가 중 높은 값(보수적 — 하한 위반은 계정 박탈)
  // 사람이 확정한 소비자가(consumer_price_manual)가 있으면 그 값이 기준 — 없으면 사이트·시트·온라인최저가 중 높은 값
  const basis = row._manualConsumer || Math.max(row.consumer_price_krw || 0, row.sheet_consumer_price_krw || 0, row.online_min_price_krw || 0) || null
  row.msp_basis_krw = basis
  row.msp_price_krw = basis ? ceil100(basis + FREE_SHIP_ADD) : null
  row.tiered_msp = basis ? {
    1: ceil100(basis + FREE_SHIP_ADD),
    2: ceil100((row.price_locked ? 2 * basis : 2 * basis * 0.95) + FREE_SHIP_ADD),
    3: ceil100((row.price_locked ? 3 * basis : 3 * basis * 0.90) + FREE_SHIP_ADD),
  } : null
  row.duplicate_of = null
  applySalePrices(row)
  row.excluded_reason = exclusionReason(row)
  return row
}
// N개 판매 예정가: 원가 = 도매가×N + 매입 배송비(도매가 합이 무료배송 기준 이상이면 0) · 하한 = tiered_msp[N]
function salePriceFor(row, n) {
  const dome = (row.wholesale_price_krw || 0) * n
  if (!dome) return null
  const threshold = row.free_ship_threshold_krw || 50000
  const ship = dome >= threshold ? 0 : (row.shipping_fee_krw ?? SHIP)
  const cost = dome + ship
  const msp = row.tiered_msp?.[n] ?? (row.msp_price_krw ? row.msp_price_krw * n : 0)
  const marginPrice = Math.ceil((0.9091 * cost / (0.8031 - TARGET_NET)) / 100) * 100
  const price = Math.ceil(Math.max(msp, marginPrice) / 100) * 100
  const fee = Math.round(price * FEE)
  const vat = Math.max(0, Math.round((price - cost) / 11))
  const margin = price - cost - fee - vat
  return { price, basis: msp >= marginPrice ? 'msp' : 'margin', msp, marginPrice, margin, pct: +(margin / price * 100).toFixed(2), ship }
}
function applySalePrices(row) {
  const p = { 1: salePriceFor(row, 1), 2: salePriceFor(row, 2), 3: salePriceFor(row, 3) }
  row.sale_prices = p[1] ? p : null
  row.sale_price_krw = p[1]?.price ?? null
  row.sale_price_basis = p[1]?.basis ?? null
  row.sale_margin_krw = p[1]?.margin ?? null
  row.sale_margin_pct = p[1]?.pct ?? null
}
function exclusionReason(row) {
  return row.is_shop_only ? '매장전용(shop)' : row.is_sample ? '시음/판촉용'
    : row.status !== 'active' ? '품절' : !row.consumer_price_krw ? '소비자가 없음' : !row.wholesale_price_krw ? '도매가 없음'
      : row.expiry_short ? `유통기한 임박(${row.expiry_date})`
        : row.duplicate_of ? `중복(같은 코드 #${row.duplicate_of})`
          : row.needs_review ? `시트 결합 의심(시트 '${String(row.sheet_name_suspect).slice(0, 20)}') 확인 필요` : null
}
// 같은 자체상품코드 여러 개(일반 + EVENT 복제 등) → 대표 1개만 후보. 우선순위: EVENT 아닌 것 → 도매가 낮은 것 → 상품번호 작은 것
const EVENT_CATE = '65'
function markDuplicates(rows) {
  const groups = new Map()
  for (const r of rows) { if (!r.custom_code || r.is_sample || r.is_shop_only) continue; (groups.get(r.custom_code) ?? groups.set(r.custom_code, []).get(r.custom_code)).push(r) }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => (a.cate_nos.includes(EVENT_CATE) - b.cate_nos.includes(EVENT_CATE)) || ((a.wholesale_price_krw ?? 1e9) - (b.wholesale_price_krw ?? 1e9)) || (+a.product_no - +b.product_no))
    for (const r of g.slice(1)) { r.duplicate_of = g[0].product_no; r.excluded_reason = exclusionReason(r) }
  }
}
function applyNotice(row, n) {
  if (!n?.info) return
  row.notice_info = n.info
  row.food_type = pick(n.info, /식품의\s*유형|식품유형/)
  row.manufacturer = pick(n.info, /제조(사|원|업소)/)
  row.functional_claims = pick(n.info, /기능정보|기능성/)
  row.notice_fetched_at = new Date().toISOString()
}
const hashOf = d => sha(JSON.stringify([d.title, d.custom_code, d.consumer_price_krw, d.wholesale_price_krw, d.online_min_price_krw, d.shipping_text, d.min_qty, d.max_qty, d.soldout, d.cate_nos, d.thumb_url, (d.detail_images || []).join('|'), d.spec, d.barcode, d.expiry_date, d.sheet_code, d.sheet_consumer_price_krw, d.dain_url, d.food_type, d.functional_claims, d.msp_basis_krw]))

// ════════ main ════════
const grade = await login()
console.log(`✓ kwholesale login (${grade ?? '등급 확인 불가'})${DRY ? ' [DRY — DB 미기록]' : ''}`)
if (grade && !/사업자|비지니스|비즈니스|대리점/.test(grade)) console.log(`⚠ 회원등급 '${grade}' — 도매가가 안 보일 수 있음(3개월 무구매 강등 규정)`)

const sheet = await loadSheet()
console.log(`✓ 제품리스트 시트 ${sheet.size}행`)

const cates = await discoverCategories()
const meta = new Map()
const restrictedCates = []   // 접근 제한(대리점회원 전용 = 매장전용 계열) — 상품이 안 보여 수집 자체가 안 됨
for (const [c, label] of cates) {
  const items = await listCategory(c)
  if (items.restricted) restrictedCates.push(`${c}:${label}`)
  for (const it of items) {
    const m = meta.get(it.no) || { cates: new Set(), soldout: false, listConsumer: null, listPrice: null }
    m.cates.add(c); if (it.soldout) m.soldout = true
    m.listConsumer ??= it.listConsumer; m.listPrice ??= it.listPrice
    meta.set(it.no, m)
  }
  if (VERBOSE) console.log(`  cate ${c} ${label}: ${items.length}`)
}
let ids = [...meta.keys()]
if (ONLY.size) {
  const missing = [...ONLY].filter(n => !meta.has(n))
  if (missing.length) console.log(`⚠ 카테고리 목록에 없는 상품번호: ${missing.join(',')} (직접 상세 수집)`)
  ids = [...ONLY]
}
if (LIMIT) ids = ids.slice(0, LIMIT)
console.log(`목록: 카테고리 ${cates.size}개 · 고유 상품 ${meta.size}개 → 상세 수집 ${ids.length}개 (동시 ${CONC})`)
if (restrictedCates.length) console.log(`🔒 접근 제한 카테고리(대리점회원 전용 → 매장전용 상품은 보이지도 않아 자동 제외): ${restrictedCates.join(', ')}`)

const existing = new Map()
if (!DRY) {
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(TABLE).select('product_no, content_hash, dain_url, notice_info, notice_fetched_at, consumer_price_manual').range(off, off + 999)
    if (error) throw new Error(`기존행 조회 실패: ${error.message} (supabase/kwholesale_products.sql 적용 여부 확인)`)
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

const restrictedDetails = results.filter(r => r.restricted)
const ok = results.filter(r => !r.err && !r.restricted)
const errs = results.filter(r => r.err)
// 이미 DB에 있던 상품이 매장전용(대리점회원 전용)으로 바뀐 경우 → 매장전용으로 표시해 등록 대상에서 뺀다
if (restrictedDetails.length) {
  console.log(`🔒 상세 접근 제한(매장전용) ${restrictedDetails.length}건: ${restrictedDetails.map(r => r.product_no).join(', ')}`)
  if (!DRY) for (const r of restrictedDetails) {
    if (!existing.has(r.product_no)) continue
    const { error } = await sb.from(TABLE).update({ is_shop_only: true, excluded_reason: `매장전용(${r.restricted})`, updated_at: new Date().toISOString() }).eq('product_no', r.product_no)
    if (error) console.log(`  ✗ 매장전용 표시 실패 ${r.product_no} ${error.message}`)
  }
}
const priceMissing = ok.filter(r => !r.is_sample && !r.wholesale_price_krw).length
if (ok.length >= 10 && priceMissing / ok.length > 0.1) {
  console.error(`✗ 도매가 누락 ${priceMissing}/${ok.length} — 로그인 세션/회원등급 문제 의심, 저장 중단`)
  process.exit(1)
}

const today = new Date(new Date().toISOString().slice(0, 10))
for (const d of ok) { d._manualConsumer = existing.get(d.product_no)?.consumer_price_manual ?? null; enrich(d, sheet, today) }
markDuplicates(ok)
// 안전망: 이름에 '상세'가 없는데 5개 이상 상품에 공통인 상세 이미지 = 공용 배너로 보고 제외(키워드에 안 걸린 새 배너 대비).
// (같은 제품의 개월수 변형끼리는 상세를 공유해 2~3개 공통이 정상이라 문턱을 5로 둔다)
if (FULL_RUN) {
  const freq = new Map()
  for (const d of ok) for (const u of new Set(d.detail_images ?? [])) freq.set(u, (freq.get(u) ?? 0) + 1)
  const banners = new Set([...freq].filter(([u, n]) => n >= 5 && !/상세/.test(decodeHexName(decodeURIComponent(u.split('/').pop() || '')))).map(([u]) => u))
  if (banners.size) {
    console.log(`🧹 공용 배너로 보고 상세에서 제외 ${banners.size}장: ${[...banners].map(u => decodeHexName(decodeURIComponent(u.split('/').pop())).slice(0, 30)).join(' | ')}`)
    for (const d of ok) d.detail_images = (d.detail_images ?? []).filter(u => !banners.has(u))
  }
}

// ③ 고시정보 — 새 링크이거나 아직 없을 때만(--refresh-dain 이면 전부)
let noticeFetched = 0, noticeFail = 0
if (!NO_DAIN) {
  const NOTICE_RETRY_MS = 7 * 864e5
  const need = ok.filter(d => { if (!d.dain_url) return false; const ex = existing.get(d.product_no); if (REFRESH_DAIN || DRY || !ex || ex.dain_url !== d.dain_url) return true; if (ex.notice_info) return false; return !ex.notice_fetched_at || Date.now() - new Date(ex.notice_fetched_at) > NOTICE_RETRY_MS })
  let k = 0
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (k < need.length) {
      const d = need[k++]
      try { const n = await fetchDainNotice(d.dain_url); if (n.info) { applyNotice(d, n); noticeFetched++ } else { d.notice_fetched_at = new Date().toISOString(); noticeFail++; if (VERBOSE) console.log(`  고시 실패 ${d.product_no}: ${n.err}`) } } catch (e) { noticeFail++; if (VERBOSE) console.log(`  고시 오류 ${d.product_no}: ${e.message}`) }
      await sleep(300)
    }
  }))
  // 재수집 안 한 건은 기존 고시값 유지(해시 비교용으로만 채움)
  for (const d of ok) {
    if (d.notice_info) continue
    const ex = existing.get(d.product_no)
    if (!d.notice_fetched_at && ex?.notice_fetched_at) d.notice_fetched_at = ex.notice_fetched_at
    if (ex?.notice_info) { d.notice_info = ex.notice_info; d.food_type = pick(ex.notice_info, /식품의\s*유형|식품유형/); d.manufacturer = pick(ex.notice_info, /제조(사|원|업소)/); d.functional_claims = pick(ex.notice_info, /기능정보|기능성/); d.notice_fetched_at = ex.notice_fetched_at }
  }
}
// 건기식 판별: 고시 식품유형(일부만 텍스트) · [건기식] 태그 · 사이트 '건강기능식품' 카테고리 소속
const hfCates = new Set([...cates].filter(([, name]) => /건강기능식품/.test(name)).map(([no]) => no))
for (const d of ok) d.is_health_functional = /건강기능식품/.test(d.food_type || '') || d.name_tags.some(t => /건기식/.test(t)) || d.cate_nos.some(c => hfCates.has(c))

let changed = 0, unchanged = 0, failed = 0
for (const d of ok) {
  d.content_hash = hashOf(d)
  if (VERBOSE || ids.length <= 30) {
    const flag = d.excluded_reason ? '⛔' : '✅'
    console.log(`  ${flag} ${d.product_no.padStart(4)} ${d.custom_code ?? '-'} ${d.title_clean.slice(0, 28).padEnd(28)} 소비자 ${d.consumer_price_krw ?? '-'} 도매 ${d.wholesale_price_krw ?? '-'} → 하한 ${d.msp_price_krw ?? '-'}${d.price_locked ? '🔒' : ''}${d.price_mismatch ? '⚠시트' + d.sheet_consumer_price_krw : ''} | 시트${d.sheet_matched ? '✓' : '✗'} 유통 ${d.expiry_date ?? '-'} | ${d.food_type ?? '고시?'}${d.excluded_reason ? ' · ' + d.excluded_reason : ''}`)
  }
  if (DRY) continue
  const now = new Date().toISOString()
  const ex = existing.get(d.product_no)
  if (ex && ex.content_hash === d.content_hash) {
    // 내용 동일해도 날짜 의존 판정(유통기한 임박)·품절 상태는 갱신
    const { error } = await sb.from(TABLE).update({ last_seen_at: now, status: d.status, soldout: d.soldout, expiry_short: d.expiry_short, duplicate_of: d.duplicate_of, needs_review: d.needs_review, excluded_reason: d.excluded_reason, is_health_functional: d.is_health_functional, notice_fetched_at: d.notice_fetched_at ?? null, sale_price_krw: d.sale_price_krw, sale_price_basis: d.sale_price_basis, sale_margin_krw: d.sale_margin_krw, sale_margin_pct: d.sale_margin_pct, sale_prices: d.sale_prices }).eq('product_no', d.product_no)
    if (error) { failed++; console.log(`  ✗ update ${d.product_no} ${error.message}`) } else unchanged++
  } else {
    const { sheet_match_method, sheet_name_suspect, _manualConsumer, ...rowForDb } = d  // 리포트 전용 필드(DB 컬럼 없음) · 수동값은 DB 원본 유지
    const { error } = await sb.from(TABLE).upsert({ ...rowForDb, last_seen_at: now, last_changed_at: now, updated_at: now }, { onConflict: 'product_no' })
    if (error) { failed++; console.log(`  ✗ upsert ${d.product_no} ${error.message}`) } else changed++
  }
}

let gone = 0
if (FULL_RUN && !DRY && meta.size > 100) {
  const { data, error } = await sb.from(TABLE).update({ status: 'gone', updated_at: new Date().toISOString() }).not('product_no', 'in', `(${[...meta.keys()].join(',')})`).neq('status', 'gone').select('product_no')
  if (error) console.log(`  ✗ gone 처리 실패 ${error.message}`); else gone = data.length
}

// ── 리포트 ──
const cnt = (arr, f) => arr.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o }, {})
const eligible = ok.filter(d => !d.excluded_reason)
console.log(`\n=== 상세 ${ok.length}건 (실패 ${errs.length}) · 등록 후보 ${eligible.length} · 제외 ${ok.length - eligible.length} ===`)
console.log('제외 사유:', JSON.stringify(cnt(ok.filter(d => d.excluded_reason), d => d.excluded_reason.replace(/\(.*\)/, ''))))
console.log(`후보: 건기식 ${eligible.filter(d => d.is_health_functional).length} · 할인불가(🔒) ${eligible.filter(d => d.price_locked).length}(온라인최저가 ${eligible.filter(d => d.price_lock_source === 'online_min').length}/시트 ${eligible.filter(d => d.price_lock_source === 'sheet').length}/미상 ${eligible.filter(d => d.price_lock_source === 'unknown').length}) · 시트 미매칭 ${eligible.filter(d => !d.sheet_matched).length} · 바코드 ${eligible.filter(d => d.barcode).length} · 고시정보(텍스트) ${eligible.filter(d => d.notice_info).length}`)
const byName = ok.filter(d => d.sheet_match_method === 'name')
if (byName.length) console.log(`🔗 이름으로 시트 결합 ${byName.length}: ${byName.map(d => `${d.product_no}(${d.custom_code}→${d.title_clean.slice(0, 14)})`).join(', ')}`)
const suspect = ok.filter(d => d.sheet_name_suspect)
if (suspect.length) { console.log(`⚠ 코드 같은데 이름 다름 ${suspect.length} (확인 필요로 제외):`); for (const d of suspect) console.log(`   ${d.product_no} ${d.custom_code} 사이트 '${d.title_clean.slice(0, 26)}' / 시트 '${String(d.sheet_name_suspect).slice(0, 26)}'`) }
const review = ok.filter(d => d.needs_review)
if (review.length) { console.log(`🔎 확인 필요(소비자가 30%↑ 불일치) ${review.length}:`); for (const d of review) console.log(`   ${d.product_no} ${d.custom_code} ${d.title_clean.slice(0, 30)} 사이트 ${d.consumer_price_krw} / 시트 ${d.sheet_consumer_price_krw}`) }
const manual = ok.filter(d => d._manualConsumer)
if (manual.length) console.log(`✍ 소비자가 수동 확정 ${manual.length}: ${manual.map(d => `${d.product_no}(${d._manualConsumer} → 하한 ${d.msp_price_krw})`).join(', ')}`)
const mism = ok.filter(d => d.price_mismatch && !d._manualConsumer)
if (mism.length) { console.log(`⚠ 소비자가 사이트≠시트 ${mism.length}건 (하한은 높은 쪽 적용):`); for (const d of mism) console.log(`   ${d.product_no} ${d.title_clean.slice(0, 30)} 사이트 ${d.consumer_price_krw} / 시트 ${d.sheet_consumer_price_krw}`) }
const unmatched = eligible.filter(d => !d.sheet_matched)
if (unmatched.length) console.log(`❓ 시트 미매칭 후보 ${unmatched.length}: ${unmatched.map(d => `${d.product_no}(${d.custom_code ?? '코드없음'})`).join(', ')}`)
// 같은 자체상품코드를 쓰는 상품(샘플↔본품, 단품↔세트 등) — 시트 소비자가가 다른 상품 것일 수 있어 사람 확인
const byCode = cnt(ok.filter(d => d.custom_code && !d.excluded_reason), d => d.custom_code)
const shared = ok.filter(d => d.custom_code && byCode[d.custom_code] > 1 && !d.excluded_reason)
if (shared.length) { console.log(`⚠ 자체상품코드 공유 후보 ${shared.length} (시트 가격 교차 확인 필요):`); for (const d of shared) console.log(`   ${d.product_no} ${d.custom_code} ${d.title_clean.slice(0, 30)} 소비자 ${d.consumer_price_krw} / 시트 ${d.sheet_consumer_price_krw}`) }
const margins = eligible.map(d => d.sale_margin_krw).filter(m => m != null).sort((a, b) => a - b)
const byMargin = eligible.filter(d => d.sale_price_basis === 'margin')
if (margins.length) console.log(`판매 예정가(max(최저판매가, 순마진 ${(TARGET_NET * 100).toFixed(0)}%가)): 최저판매가 적용 ${eligible.length - byMargin.length} · 마진가 적용 ${byMargin.length} · 마진 최소 ${margins[0]} · 중앙 ${margins[Math.floor(margins.length / 2)]} · 최대 ${margins[margins.length - 1]}`)
for (const d of byMargin) console.log(`   마진가 ${d.product_no} ${d.title_clean.slice(0, 26)} 최저판매가 ${d.msp_price_krw} → 판매 ${d.sale_price_krw} (마진 ${d.sale_margin_krw}·${d.sale_margin_pct}%)`)
console.log(`고시정보 수집 ${noticeFetched} · 실패 ${noticeFail}`)
if (errs.length) { console.log(`✗ 상세 실패 (${errs.length})`); for (const e of errs) console.log(`   ${e.product_no} ${e.err}`) }
if (!DRY) console.log(`\nDB: 변동 upsert ${changed} · 무변동 ${unchanged} · 실패 ${failed} · gone ${gone}`)
writeFileSync(path.join(process.env.TEMP || __dirname, 'kwholesale-collect-report.json'), JSON.stringify(ok.map(({ raw_info, detail_images, images_main, notice_info, ...r }) => r), null, 1))
