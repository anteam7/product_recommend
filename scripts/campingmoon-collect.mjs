#!/usr/bin/env node
/**
 * 캠핑문(campingmoon.co.kr, Cafe24 mall llue89) 상품 + 옵션 수집 → jimscanner_campingmoon_products / _items upsert.
 *   node scripts/campingmoon-collect.mjs [--dry] [--only=4385,4472] [--limit=N] [--concurrency=3] [--verbose] [--no-login]
 *
 * 설계: docs/plan-campingmoon.md §1·§3.2 (2026-10-14 정찰)
 *  - 로그인: Cafe24 AuthSSL → 헤드리스 크롬으로 로그인 후 쿠키를 fetch 에 이식(wellroot-collect 패턴). 비로그인 페이지는 CDN 300초 캐시라 로그인 세션으로 읽는다.
 *  - 전체상품(cate 152) 목록으로 상품 번호·품절 아이콘 → 하위 카테고리 목록으로 소속(cate_nos) → 상세에서 가격·옵션(option_stock_data JSON)·이미지.
 *  - 옵션: 1축 select(색상/사이즈/선택). item_code = product_code+000A…, is_selling "F" = 옵션 품절. stock_number 는 신뢰하지 않는다.
 *  - 35% 할인은 상세에 없음(주문서에서만) → 판매가만 저장, 원가는 계산식(문서 §2.1).
 *  - 상세 이미지는 외부 호스트(cki100.x-y.net) URL 만 저장. site-assets 복사는 등록기가 등록 대상에만 한다.
 *  - content_hash 로 변경분만 upsert. 전체 실행 시 전체상품 목록에 없는 상품은 status='gone'(옵션도 gone).
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.CAMPINGMOON_BASE_URL || 'https://campingmoon.co.kr'
const TABLE = 'jimscanner_campingmoon_products', ITEMS = 'jimscanner_campingmoon_items'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const argv = process.argv.slice(2)
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = argv.includes('--dry'), VERBOSE = argv.includes('--verbose'), NO_LOGIN = argv.includes('--no-login')
const ONLY = new Set((arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean))
const LIMIT = +(arg('limit') || 0)
const CONC = Math.max(1, +(arg('concurrency') || 3))
const FULL_RUN = !ONLY.size && !LIMIT
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// 사이트 네비 기준 카테고리(2026-10-14 정찰). 152 = 전체상품(수집 기준), 나머지는 소속 판정용. 146·180·183 은 네비 미노출 배너 카테고리.
const ALL_CATE = '152'
const CATES = {
  '155': '캠핑문(자사브랜드)',
  '4': '텐트/침낭', '52': '텐트', '51': '타프', '7': '침낭/해먹', '53': '폴대', '84': '랜턴', '61': '텐트소품/공구',
  '30': '코펠/주방용품', '81': '코펠/식기', '74': '컵/주전자', '75': '조리도구', '70': '아이스박스/쿨러', '73': '기타주방',
  '32': '화로/연료', '90': '화로대', '89': '그릴', '87': '버너/토치', '179': '연료', '92': '기타화로', '175': '난방',
  '12': '테이블/의자', '49': '테이블', '47': '의자', '50': '기타가구',
  '150': '레저용품', '165': '자전거', '168': '바이크', '171': '차량', '169': '등산', '170': '낚시', '173': '기타레저',
  '36': '기타소품', '154': '생활', '163': '욕실', '40': '의류/가방/잡화', '115': '정리/수납', '102': '공구', '116': '기타',
  '146': '(배너)', '180': '(배너)캠핑문 화로대', '183': '(배너)구형잡화',
}
const LEAF_CATES = ['155', '52', '51', '7', '53', '84', '61', '81', '74', '75', '70', '73', '90', '89', '87', '179', '92', '175', '49', '47', '50', '165', '168', '171', '169', '170', '173', '154', '163', '40', '115', '102', '116', '146', '180', '183']
// KC(전기용품·가스용품) 인증 대상 의심 — 기타 재화 고시로 등록할 수 없고 인증번호가 필요하다 → 등록 제외 후보로 표시만
const KC_RE = /버너|토치|스토브|난로|히터|난방|가스|충전식|LED|랜턴|전기|USB|배터리|보조배터리|선풍기|라이터|발전기/i

// ── fetch + 쿠키 ──
const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const eq = kv.indexOf('='); if (eq < 0) continue; const k = kv.slice(0, eq).trim(); const v = kv.slice(eq + 1).trim(); if (v === 'deleted') cookies.delete(k); else cookies.set(k, v) } }
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function fx(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml', Cookie: cookieHeader(), ...(init.headers || {}) } })
  setCookies(res.headers.get('set-cookie'))
  return res
}
async function login() {
  if (!env.CAMPINGMOON_USER || !env.CAMPINGMOON_PASS) throw new Error('.env.local 에 CAMPINGMOON_USER / CAMPINGMOON_PASS 필요')
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' })
    const page = await ctx.newPage()
    let dialogMsg = null
    page.on('dialog', (d) => { dialogMsg = d.message(); d.dismiss().catch(() => {}) })
    await page.goto(`${BASE}/member/login.html`, { waitUntil: 'load', timeout: 45000 })
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(600)
      await page.locator('#member_id').fill(env.CAMPINGMOON_USER)
      await page.locator('#member_passwd').fill(env.CAMPINGMOON_PASS)
      if ((await page.locator('#member_id').inputValue()) === env.CAMPINGMOON_USER && (await page.locator('#member_passwd').inputValue()) === env.CAMPINGMOON_PASS) break
    }
    await Promise.all([
      page.waitForURL((u) => !/\/member\/login\.html/.test(u.toString()), { timeout: 30000 }).catch(() => { throw new Error(`campingmoon 로그인 실패${dialogMsg ? ': ' + dialogMsg : ''}`) }),
      page.press('#member_passwd', 'Enter'),
    ])
    for (const c of await ctx.cookies(BASE)) cookies.set(c.name, c.value)
  } finally { await browser.close() }
  const r = await fx(`${BASE}/myshop/index.html`)
  const loc = r.headers.get('location') || ''
  if (r.status >= 300 && /login/.test(loc)) throw new Error('campingmoon 로그인 세션 이식 실패 (myshop → login 리다이렉트)')
  const html = await r.text()
  const grade = (htmlToText(html).match(/\[\s*([^\]]*\d+%)\s*\]\s*회원/) || [])[1]
  console.log(`로그인 OK · 회원 등급 ${grade || '(미확인)'}`)
  if (grade && !/35/.test(grade)) console.log(`  ⚠ 등급이 (사업자) 35% 가 아니다: ${grade} — 원가 계산식(0.65) 확인 필요`)
}

// ── 파싱 유틸 ──
const decodeEnt = (s) => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'font', 'u', 'i', 'em', 'a', 'small', 'sup', 'sub', 'mark', 's', 'strike', 'label'])
const htmlToText = (h) => decodeEnt((h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (_, t) => (INLINE_TAGS.has(t.toLowerCase()) ? '' : ' '))).replace(/\s+/g, ' ').trim()
const toInt = (s) => { const n = parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null }
const abs = (u) => (!u ? null : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? BASE + u : u)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const jsVar = (html, k) => { const m = html.match(new RegExp(`var\\s+${k}\\s*=\\s*'((?:\\\\.|[^'])*)'`)); return m ? m[1] : null }
const unescapeJs = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\')
function infoTable(html) {
  const i = html.search(/xans-product-detaildesign/)
  if (i < 0) return {}
  const region = html.slice(i, i + 30000), map = {}
  for (const m of region.matchAll(/<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) { const th = htmlToText(m[1]), td = htmlToText(m[2]); if (th && td && th.length < 30 && !(th in map)) map[th] = td.slice(0, 1000) }
  return map
}
function detailRegion(html) {
  const s = html.search(/id=["']prdDetail["']/)
  if (s < 0) return ''
  const region = html.slice(s)
  const e = region.slice(20).search(/id=["'](?:prdInfo|prdReview|prdQnA|prdQna|prdRelated)["']/)
  return e > 0 ? region.slice(0, e + 20) : region.slice(0, 400000)
}
/** 내부 코드 접두(a170·ms43·ch·FXK)·노이즈 제거. 모델코드(MT-3955)는 유지하고 따로도 뽑는다 */
export function cleanName(raw) {
  let s = decodeEnt(raw || '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^(?:a\d{1,4}|ms\d{1,3}|ch\d{0,3}|FXK\d*)(?=[\s가-힣A-Z(\[])\s*/, '')
  s = s.replace(/\(\s*옵션\s*품절\s*\)|\[감성캠핑\]|\d+\s*개\s*묶음\s*\d+%\s*(할인)?|\(품절\)|\[품절\]/g, ' ')
  s = s.replace(/\s+/g, ' ').replace(/^[\s\-–·,]+|[\s\-–·,]+$/g, '').trim()
  return s
}
export const modelCodeOf = (s) => (String(s || '').match(/\b[A-Z]{1,4}-\d{3,5}[A-Z]?\b/) || [])[0] || null

// ── 목록 ──
async function listCategory(cateNo) {
  const out = []; const seen = new Set()
  for (let page = 1; page <= 80; page++) {
    // 목록 한 쪽이 실패하면 조용히 잘린 목록으로 gone 처리가 일어난다 → 3회 재시도 후에도 실패면 throw(전체 중단)
    let r = null
    for (let t = 1; t <= 3; t++) {
      try { r = await fx(`${BASE}/product/list.html?cate_no=${cateNo}&page=${page}`) } catch (e) { r = { ok: false, status: 0, err: e.message.slice(0, 120) } }
      if (r.ok || r.status === 404) break // 404 만 재시도 제외. 429/408/5xx/네트워크 예외는 재시도
      if (t < 3) await sleep(1500 * t)
    }
    if (r.status === 404 && page > 1) break // 마지막 쪽 너머(정상 종료). Cafe24 는 보통 200 + 상품 0건으로 끝난다
    if (!r.ok) throw new Error(`목록 조회 실패 cate ${cateNo} page ${page}: ${r.status || r.err} — 잘린 목록으로 gone 처리하지 않도록 중단`)
    let html = await r.text()
    const start = html.search(/xans-product-listnormal|anchorBoxId_/)
    if (start > 0) html = html.slice(start)
    const cut = html.search(/ec-base-paginate/)
    if (cut > 0) html = html.slice(0, cut)
    let fresh = 0
    for (const b of html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)) {
      if (seen.has(b[1])) continue
      seen.add(b[1]); fresh++
      const name = htmlToText((b[2].match(/<p class=["']name["'][\s\S]*?<\/p>/) || [])[0] || '')
      out.push({ no: b[1], soldout: /icon_sellout|ico_product_soldout|alt=["'][^"']*품절/i.test(b[2]), listName: name, listPrice: toInt((b[2].match(/([\d,]{4,})\s*원/) || [])[1]), thumb: abs((b[2].match(/<img[^>]+src=["']([^"']+)["'][^>]*class=["'][^"']*thumb|<img[^>]+class=["'][^"']*thumb[^"']*["'][^>]+src=["']([^"']+)["']/) || []).slice(1).find(Boolean)) })
    }
    if (!fresh) break
    await sleep(150)
  }
  return out
}

// ── 상세 ──
function parseOptions(html, productCode) {
  const items = []
  const raw = jsVar(html, 'option_stock_data') || jsVar(html, 'single_option_stock_data')
  if (raw) {
    try {
      const obj = JSON.parse(decodeEnt(unescapeJs(raw)))
      for (const [code, v] of Object.entries(obj)) {
        if (typeof v !== 'object' || !v) continue
        items.push({ item_code: code, option_name: v.option_name || null, option_value: typeof v.option_value === 'string' ? v.option_value : (v.option_value && Object.values(v.option_value).join('/')) || null, add_price: toInt(v.stock_price) || 0, option_price: toInt(v.option_price), is_selling: String(v.is_selling ?? 'T') !== 'F', is_display: String(v.is_display ?? 'T') !== 'F', item_image: abs(v.item_image_file || null) || null })
      }
    } catch (e) { if (VERBOSE) console.log('  option_stock_data 파싱 실패:', e.message.slice(0, 80)) }
  }
  // 보조: <select name="option1"> 라벨("브라운 [품절]", "22cm (+4,000원)")로 품절·가산액 보정
  const sel = html.match(/(<select[^>]+name=["']option1["'][^>]*>)([\s\S]*?)<\/select>/)
  let optionTitle = sel ? (sel[1].match(/option_title=["']([^"']+)["']/) || [])[1] || null : null
  if (!optionTitle) optionTitle = items.find((i) => i.option_name)?.option_name || null
  if (sel) sel[1] = sel[2] // 아래 루프는 옵션 본문만 본다
  if (sel) {
    for (const m of sel[1].matchAll(/<option[^>]+value=["']([A-Z0-9]{6,})["'][^>]*>([\s\S]*?)<\/option>/g)) {
      const label = htmlToText(m[2]); const code = m[1]
      const soldout = /\[\s*품절\s*\]|\(\s*품절\s*\)/.test(label)
      const add = toInt((label.match(/\(\s*\+\s*([\d,]+)\s*원\s*\)/) || [])[1]) || 0
      const value = label.replace(/\[\s*품절\s*\]|\(\s*품절\s*\)|\(\s*\+\s*[\d,]+\s*원\s*\)/g, '').trim()
      const ex = items.find((x) => x.item_code === code)
      if (ex) { if (soldout) ex.is_selling = false; if (!ex.option_value) ex.option_value = value; if (!ex.add_price && add) ex.add_price = add }
      else items.push({ item_code: code, option_name: optionTitle, option_value: value, add_price: add, option_price: null, is_selling: !soldout, is_display: true, item_image: null })
    }
  }
  if (!items.length && productCode) items.push({ item_code: `${productCode}000A`, option_name: null, option_value: null, add_price: 0, option_price: null, is_selling: true, is_display: true, item_image: null })
  return { items, optionTitle }
}
async function fetchDetail(no, meta) {
  const detailUrl = `${BASE}/product/detail.html?product_no=${no}`
  const r = await fx(detailUrl)
  if (r.status >= 300 && r.status < 400) return { product_no: no, err: `리다이렉트 ${r.headers.get('location') || ''}` }
  if (!r.ok) return { product_no: no, err: `HTTP ${r.status}` }
  const html = await r.text()
  const info = infoTable(html)
  const ogTitle = decodeEnt((html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) || [])[1] || '')
  const nameRaw = (unescapeJs(jsVar(html, 'product_name') || '') || info['상품명'] || ogTitle || meta?.listName || '').replace(/\s+/g, ' ').trim()
  if (!nameRaw) return { product_no: no, err: '제목 파싱 실패' }
  const productCode = info['상품코드'] || (html.match(/default_item_code["']?\s*[:=]\s*["']([A-Z0-9]+?)000[A-Z]["']/) || [])[1] || null
  const salePrice = toInt(jsVar(html, 'product_price')) || toInt((html.match(/id=["']span_product_price_text["'][^>]*>([^<]*)</) || [])[1]) || meta?.listPrice || null
  const consumer = toInt((html.match(/id=["']span_product_price_custom["'][^>]*>[\s\S]*?([\d,]{4,})\s*원/) || [])[1])
  const soldoutIcon = (jsVar(html, 'is_soldout_icon') || 'F') === 'T'
  const big = abs((html.match(/<img[^>]+class=["'][^"']*BigImage[^"']*["'][^>]+src=["']([^"']+)["']|<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*BigImage/) || []).slice(1).find(Boolean)) || abs((html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) || [])[1])
  const region = detailRegion(html)
  const detailImgs = [...new Set([...region.matchAll(/<img[^>]+(?:ec-data-src|src)=["']([^"']+)["']/g)].map((m) => abs(m[1])).filter((u) => u && !/\/web\/upload\/icon|blank\.gif|\.gif$/i.test(u)))]
  const descText = htmlToText(region).slice(0, 2000)
  const { items, optionTitle } = parseOptions(html, productCode)
  const minQty = toInt(jsVar(html, 'product_min')), maxQty = toInt(jsVar(html, 'product_max'))
  const nameClean = cleanName(nameRaw)
  return {
    product_no: String(no), product_code: productCode, detail_url: detailUrl, name_raw: nameRaw, name_clean: nameClean, model_code: modelCodeOf(nameRaw),
    consumer_price: consumer, sale_price: salePrice, soldout: soldoutIcon || (items.length > 0 && items.every((i) => !i.is_selling)) || !!meta?.soldout,
    has_option: items.length > 1 || !!optionTitle, option_title: optionTitle, thumb_url: meta?.thumb || null, big_url: big,
    detail_image_src: detailImgs.slice(0, 10), description_text: descText || null, min_qty: minQty, max_qty: maxQty && maxQty > 0 ? maxQty : null,
    kc_suspect: KC_RE.test(nameRaw), items,
  }
}
const hashOf = (d) => sha(JSON.stringify([d.name_raw, d.consumer_price, d.sale_price, d.soldout, d.option_title, d.big_url, d.detail_image_src, d.cate_nos, d.items.map((i) => [i.item_code, i.option_value, i.add_price, i.option_price, i.is_selling])]))

// ── 실행 ──
if (!NO_LOGIN) await login()
const meta = new Map()
let ids = []
if (ONLY.size) ids = [...ONLY]
else {
  const all = await listCategory(ALL_CATE)
  for (const p of all) meta.set(p.no, { ...p, cate_nos: new Set() })
  console.log(`전체상품(cate ${ALL_CATE}) ${all.length}건 (목록 품절 ${all.filter((p) => p.soldout).length})`)
  for (const c of LEAF_CATES) {
    const rows = await listCategory(c)
    for (const p of rows) { if (!meta.has(p.no)) meta.set(p.no, { ...p, cate_nos: new Set() }); meta.get(p.no).cate_nos.add(c) }
    if (VERBOSE) console.log(`  cate ${c} ${CATES[c] || ''}: ${rows.length}`)
  }
  ids = [...meta.keys()]
  if (LIMIT) ids = ids.slice(0, LIMIT)
}
console.log(`상세 수집 ${ids.length}건 (동시 ${CONC})`)
const exRows = []
for (let from = 0; ; from += 1000) { // PostgREST 기본 1,000행 제한 — 952건이라 곧 넘는다
  const { data, error: exErr } = await sb.from(TABLE).select('product_no, content_hash').order('product_no').range(from, from + 999)
  if (exErr) throw new Error(`기존 행 조회 실패: ${exErr.message}`)
  exRows.push(...(data || [])); if ((data || []).length < 1000) break
}
const existing = new Map(exRows.map((r) => [r.product_no, r]))
const ok = [], errs = []
let k = 0
await Promise.all(Array.from({ length: CONC }, async () => {
  while (k < ids.length) {
    const no = ids[k++]
    try {
      const d = await fetchDetail(no, meta.get(no))
      if (d.err) { errs.push(d); if (VERBOSE) console.log(`  ✗ ${no} ${d.err}`) } else { d.cate_nos = [...(meta.get(no)?.cate_nos || [])]; ok.push(d) }
    } catch (e) { errs.push({ product_no: no, err: e.message.slice(0, 120) }) }
    await sleep(120)
  }
}))

let changed = 0, unchanged = 0, failed = 0, itemRows = 0
for (const d of ok) {
  d.content_hash = hashOf(d)
  if (VERBOSE || ids.length <= 30) console.log(`  ${d.soldout ? '⛔' : '✅'} ${d.product_no.padStart(4)} ${(d.product_code || '-').padEnd(9)} ${d.name_clean.slice(0, 30).padEnd(30)} 판매 ${d.sale_price ?? '-'} 소비자 ${d.consumer_price ?? '-'} 옵션 ${d.option_title || '-'} ${d.items.length}(판매중 ${d.items.filter((i) => i.is_selling).length}) 상세 ${d.detail_image_src.length}장${d.model_code ? ' ' + d.model_code : ''}${d.kc_suspect ? ' KC?' : ''}`)
  if (DRY) continue
  const now = new Date().toISOString()
  const ex = existing.get(d.product_no)
  const { items, ...row } = d
  if (ex && ex.content_hash === d.content_hash) {
    const { error } = await sb.from(TABLE).update({ last_seen_at: now, status: 'active', soldout: d.soldout, updated_at: now }).eq('product_no', d.product_no)
    if (error) { failed++; console.log(`  ✗ update ${d.product_no} ${error.message}`); continue }
    unchanged++
    // 내용 동일(해시 동일)이어도 옵션 is_selling 은 해시에 포함되므로 여기 오면 옵션 상태도 동일 — 추가 갱신 불필요
  } else {
    const { error } = await sb.from(TABLE).upsert({ ...row, status: 'active', last_seen_at: now, last_changed_at: now, updated_at: now }, { onConflict: 'product_no' })
    if (error) { failed++; console.log(`  ✗ upsert ${d.product_no} ${error.message}`); continue }
    changed++
    const rows = items.map((i) => ({ ...i, product_no: d.product_no, status: 'active', soldout_at: i.is_selling ? null : now, updated_at: now }))
    const { error: ie } = await sb.from(ITEMS).upsert(rows, { onConflict: 'item_code' })
    if (ie) { console.log(`  ✗ items ${d.product_no} ${ie.message}`) } else itemRows += rows.length
    const codes = items.map((i) => i.item_code).filter((c) => /^[A-Z0-9]+$/.test(c)) // 필터 문자열에 넣으므로 영숫자만
    if (codes.length) { const { error: ge } = await sb.from(ITEMS).update({ status: 'gone', is_selling: false, updated_at: now }).eq('product_no', d.product_no).not('item_code', 'in', `(${codes.join(',')})`).neq('status', 'gone'); if (ge) console.log(`  ✗ items gone ${d.product_no} ${ge.message}`) }
  }
}
let gone = 0
if (FULL_RUN && !DRY && meta.size > 500) {
  const { data, error } = await sb.from(TABLE).update({ status: 'gone', updated_at: new Date().toISOString() }).not('product_no', 'in', `(${[...meta.keys()].join(',')})`).neq('status', 'gone').select('product_no')
  if (error) console.log(`  ✗ gone 처리 실패 ${error.message}`); else gone = data.length
}

const cnt = (arr, f) => arr.reduce((o, r) => { const k2 = f(r); o[k2] = (o[k2] || 0) + 1; return o }, {})
const live = ok.filter((d) => !d.soldout)
console.log(`\n=== 상세 ${ok.length}건 (실패 ${errs.length}) · 판매가능 ${live.length} · 품절 ${ok.length - live.length} · 옵션 상품 ${ok.filter((d) => d.has_option).length} · 옵션 행 ${ok.reduce((s, d) => s + d.items.length, 0)} · KC 의심 ${ok.filter((d) => d.kc_suspect).length} ===`)
console.log('옵션 축:', JSON.stringify(cnt(ok.filter((d) => d.has_option), (d) => d.option_title || '?')))
console.log('상세 이미지 수:', JSON.stringify(cnt(ok, (d) => String(d.detail_image_src.length))))
if (errs.length) console.log('실패:', errs.slice(0, 10).map((e) => `${e.product_no}(${e.err})`).join(', '))
if (!DRY) console.log(`DB: 변경 ${changed} · 동일 ${unchanged} · 실패 ${failed} · 옵션 upsert ${itemRows} · gone ${gone}`)
