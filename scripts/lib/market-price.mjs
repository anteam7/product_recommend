/**
 * 시장가(경쟁가) 조회 — 위탁 소싱 마진 계산용.
 *   - naverShopMedian(kw): 네이버 쇼핑 검색 OpenAPI(공식, 무차단) → 경쟁 lprice 중앙값
 *   - openCoupangSession(): 쿠팡 세션 — 백엔드 자동 선택(2026-10-13 사용자 요청: Aside CLI 우선)
 *       · aside : Aside AI 브라우저(aside.exe repl, 사용자 로그인 세션) — 크롬 워밍업 불필요
 *       · cdp   : 떠 있는 사용자 크롬(9222)에 CDP 접속 (launch-chrome-debug.cmd) — 폴백
 *       둘 다 "사람처럼" 검색(메인 → 검색창 입력 → 검색버튼). ?q= 딥링크는 Akamai 차단되므로 금지.
 *       · chrome: 설치된 크롬을 전용 프로필로 직접 실행(Playwright channel 'chrome') — 다건 스크리닝, auto 에는 안 들어감
 *       선택: opts.backend 또는 env COUPANG_PRICE_BACKEND = auto(기본: aside→cdp) | aside | cdp | chrome
 *   - coupangMedian(kw) / coupangMedianViaCDP(kw, 구명): 세션 1회 검색 래퍼
 *
 *   import { naverShopMedian, openCoupangSession, coupangMedian, median } from './lib/market-price.mjs'
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)

export const median = (arr) => { const a = arr.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }
const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '').trim()

/**
 * 네이버 쇼핑 검색 OpenAPI — 키워드 경쟁 상품의 최저가(lprice) 분포.
 * 광고/중복몰 노이즈 완화: 상·하위 가격 트림 후 중앙값.
 * @returns {Promise<{source:'naver', median:number|null, count:number, min:number|null, max:number|null, samples:Array}>}
 */
export async function naverShopMedian(kw, { display = 40 } = {}) {
  const id = env.NAVER_OPENAPI_CLIENT_ID, sec = env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !sec) throw new Error('NAVER_OPENAPI_CLIENT_ID/SECRET 없음 (.env.local)')
  const url = `https://openapi.naver.com/v1/search/shop.json?display=${display}&sort=sim&query=${encodeURIComponent(kw)}`
  const r = await fetch(url, { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': sec } })
  if (r.status !== 200) { const t = await r.text(); throw new Error(`네이버 쇼핑 API HTTP ${r.status}: ${t.slice(0, 150)}`) }
  const j = await r.json()
  const items = (j.items || []).map((it) => ({ title: stripTags(it.title), lprice: parseInt(it.lprice) || 0, mall: it.mallName, link: it.link }))
  const prices = items.map((it) => it.lprice).filter((n) => n > 0).sort((a, b) => a - b)
  // 상·하위 10% 트림(아주 싼 옵션/악세서리·과대가 제거) 후 중앙값
  const lo = Math.floor(prices.length * 0.1), hi = Math.ceil(prices.length * 0.9)
  const trimmed = prices.slice(lo, hi)
  return {
    source: 'naver',
    median: median(trimmed.length ? trimmed : prices),
    count: j.total ?? prices.length,
    min: prices[0] ?? null,
    max: prices[prices.length - 1] ?? null,
    samples: items.slice(0, 5),
    items: items.filter((it) => it.lprice > 0).map((it) => ({ title: it.title, price: it.lprice })), // 상품별 시장가 정합화용 원본
  }
}

// 쿠팡 결과페이지 가격 추출 (2026 DOM: ProductUnit/data-id 카드, 가격=콤마형 leaf, 정가=line-through 제외).
// page.evaluate 로 브라우저에서 실행되므로 외부 스코프 참조 금지.
function _extractCoupangPrices() {
  const out = []
  const seen = new Set()
  document.querySelectorAll('a[href*="/vp/products/"]').forEach((a) => {
    const card = a.closest('[data-id], li, [class*="ProductUnit"]') || a
    let price = null
    card.querySelectorAll('*').forEach((el) => {
      if (price != null || el.children.length) return
      const cls = typeof el.className === 'string' ? el.className : ''
      if (/line-through/.test(cls)) return // 정가(취소선) 제외 → 판매가만
      const m = (el.textContent || '').trim().match(/^([0-9]{1,3}(?:,[0-9]{3})+)\s*원?$/)
      if (m) price = parseInt(m[1].replace(/,/g, ''))
    })
    if (!price) return
    const ne = card.querySelector('[class*="ProductUnit_productName"], [class*="name"], [class*="Name"]')
    // 후기수(판매량 프록시) + 별점 — ProductRating 컨테이너의 "(N)" 텍스트 + 별 채움 width%
    let reviews = null, rating = null
    const rc = card.querySelector('[class*="ProductRating"]')
    if (rc) {
      const rm = (rc.textContent || '').match(/([0-9][0-9,]*)/)
      if (rm) reviews = parseInt(rm[1].replace(/,/g, ''))
      const st = [...rc.querySelectorAll('[style*="width"]')].map((e) => e.getAttribute('style') || '').find((s) => /width:\s*[0-9.]+%/.test(s))
      if (st) { const w = parseFloat((st.match(/width:\s*([0-9.]+)%/) || [])[1]); if (w >= 0) rating = Math.round((w / 20) * 10) / 10 }
    }
    const key = (a.getAttribute('href') || '').match(/products\/(\d+)/)?.[1] || `${price}:${out.length}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ price, title: (ne?.textContent || '').trim().slice(0, 100), reviews, rating }) // 100자: 식품 규격(용량·수량)이 제목 뒤에 붙어 50자에선 잘림
  })
  return out
}
// 결과 0건이 '진짜 없음'인지 '차단/빈 페이지'인지 구분하는 진단(페이지 안에서 실행). noResultMsg = 쿠팡의 "검색결과가 없" 안내 문구 존재.
function _diagCoupang() {
  const body = (document.body && document.body.innerText) || ''
  return { noResultMsg: /검색\s*결과가?\s*없|일치하는\s*상품이\s*없|에\s*대한\s*검색결과/.test(body) && !document.querySelector('a[href*="/vp/products/"]'), bodyLen: body.length, title: document.title }
}
/** 0건인데 진짜 없음 안내도 없으면 차단 의심(emptyReason='suspect'), 안내가 있으면 'confirmed-empty'. 결과가 있으면 필드 없음. */
function _withEmptyReason(res, diag) {
  if (res.items.length === 0) res.emptyReason = diag && diag.noResultMsg ? 'confirmed-empty' : 'suspect'
  return res
}
function _coupangResult(got) {
  const prices = got.map((g) => g.price).filter((n) => n > 0).sort((a, b) => a - b)
  const lo = Math.floor(prices.length * 0.1), hi = Math.ceil(prices.length * 0.9)
  const trimmed = prices.slice(lo, hi)
  return { source: 'coupang', median: median(trimmed.length ? trimmed : prices), count: prices.length, samples: got.slice(0, 5), items: got.filter((g) => g.price > 0).map((g) => ({ title: g.title, price: g.price, reviews: g.reviews ?? null, rating: g.rating ?? null })) }
}

// 페이지 하나로 "사람처럼" 재검색하는 search() — CDP·chrome 백엔드 공용. 검색란만 바꿔 재검색(새 탭/메인 재진입 없음).
function _makePageSearch(page, timeoutMs) {
  async function doSearchOnce(kw) {
    // 헤더 검색란(결과페이지에도 존재)에 키워드만 교체 후 검색 — 새 탭/메인 재진입 없이.
    const input = page.locator('input#headerSearchKeyword, input[name="q"]').first()
    await input.waitFor({ state: 'visible', timeout: 8000 })
    await input.click()
    await input.fill('') // 기존 키워드 비우기
    await input.type(kw, { delay: 40 })
    const btn = page.locator('form#headerSearchForm button[type="submit"], button.search-btn, .search-btn, form button[type="submit"]').first()
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {}),
      (async () => { if (await btn.count().catch(() => 0)) { await btn.click().catch(() => input.press('Enter')) } else { await input.press('Enter') } })(),
    ])
    await page.waitForTimeout(2200)
  }
  // 사람처럼 결과를 훑는 흉내 — 휠로 2~4번 내려갔다 다시 올라온다(다건 스크리닝에서 검색만 반복하는 패턴을 흐린다). 실패해도 결과엔 영향 없음.
  async function humanScroll() {
    try {
      const n = 2 + Math.floor(Math.random() * 3)
      for (let k = 0; k < n; k++) { await page.mouse.wheel(0, 300 + Math.random() * 600); await page.waitForTimeout(500 + Math.random() * 900) }
      await page.waitForTimeout(400 + Math.random() * 800)
      for (let k = 0; k < n; k++) { await page.mouse.wheel(0, -(300 + Math.random() * 600)); await page.waitForTimeout(400 + Math.random() * 700) }
    } catch { /* noop */ }
  }
  async function search(kw, { scroll = false } = {}) {
    try {
      await doSearchOnce(kw)
      // 재차단(Access Denied) → 메인으로 재워밍업 후 1회 재시도(일시 차단은 이걸로 회복됨)
      if (/Access Denied/i.test(await page.title())) {
        await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {})
        await page.waitForTimeout(2500)
        if (/Access Denied/i.test(await page.title())) return null
        await doSearchOnce(kw)
        if (/Access Denied/i.test(await page.title())) return null
      }
      const out = _withEmptyReason(_coupangResult(await page.evaluate(_extractCoupangPrices)), await page.evaluate(_diagCoupang).catch(() => null))
      if (scroll) await humanScroll()
      return out
    } catch { return null }
  }
  return search
}

/**
 * 쿠팡 세션 — 떠 있는 사용자 크롬(CDP)에 1회 붙어 페이지를 '재사용'한다.
 * 최초 1회만 메인 진입(워밍업), 이후 search(kw)는 **결과페이지 검색란만 바꿔 재검색**
 * (새 탭/메인 재진입 없음 → 봇 패턴·Akamai 재차단 위험↓). 다건 스크리닝용.
 * 반환 null = CDP 미가동/차단. 끝나면 반드시 close().
 * @returns {Promise<{search:(kw:string)=>Promise<object|null>, close:()=>Promise<void>, backend:'cdp'}|null>}
 */
export async function openCoupangSessionViaCDP({ endpoint = 'http://127.0.0.1:9222', timeoutMs = 25000 } = {}) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  let browser
  try { browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 }) } catch { return null }
  let page, reused = false
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext())
    // 이미 열려있는 쿠팡 탭이 있으면 그대로 재사용(메인 재진입조차 안 함 → 가장 안전). 없을 때만 새 탭+워밍업.
    page = ctx.pages().find((p) => (p.url() || '').includes('coupang.com'))
    if (page) { reused = true; await page.bringToFront().catch(() => {}) }
    else { page = await ctx.newPage(); await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); await page.waitForTimeout(1200) }
    if (/Access Denied/i.test(await page.title())) { if (!reused) await page.close().catch(() => {}); await browser.close().catch(() => {}); return null }
  } catch { try { await browser.close() } catch { /* noop */ } return null }

  const search = _makePageSearch(page, timeoutMs)
  // 재사용한 사용자 탭은 닫지 않음(우리가 새로 연 탭만 닫음). browser.close는 CDP 연결만 끊음.
  async function close() { try { if (page && !reused) await page.close() } catch { /* noop */ } try { await browser.close() } catch { /* noop */ } }
  return { search, close, backend: 'cdp' }
}

/**
 * 쿠팡 세션 — 설치된 크롬(Playwright channel 'chrome')을 전용 프로필로 직접 띄운다. 사용자 크롬·Aside 가 없어도 되는 다건 스크리닝용.
 * Playwright 기본 Chromium 은 40회 안팎에서 Access Denied(2026-10-25 실측) → 반드시 channel 'chrome'·헤드풀. 검색 간격은 호출 쪽에서 5초 이상.
 * 프로필(쿠키 유지) = env COUPANG_CHROME_PROFILE 또는 <repo>/_workspace/coupang-chrome-profile(gitignore). 반환 null = 크롬 없음/차단.
 * @returns {Promise<{search:(kw:string)=>Promise<object|null>, close:()=>Promise<void>, backend:'chrome'}|null>}
 */
export async function openCoupangSessionViaChrome({ timeoutMs = 25000, profileDir } = {}) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const dir = profileDir || process.env.COUPANG_CHROME_PROFILE || env.COUPANG_CHROME_PROFILE || path.join(__dirname, '..', '..', '_workspace', 'coupang-chrome-profile')
  let ctx
  try {
    ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, locale: 'ko-KR', viewport: { width: 1280, height: 900 }, args: ['--disable-blink-features=AutomationControlled'] })
  } catch (e) { console.log(`  (chrome 백엔드 불가: ${String(e?.message || e).slice(0, 120)})`); return null }
  let page
  try {
    page = ctx.pages()[0] || (await ctx.newPage())
    await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForTimeout(2500)
    if (/Access Denied/i.test(await page.title())) { await ctx.close().catch(() => {}); return null }
  } catch { await ctx.close().catch(() => {}); return null }
  const search = _makePageSearch(page, timeoutMs)
  async function close() { try { await ctx.close() } catch { /* noop */ } }
  return { search, close, backend: 'chrome' }
}

// ─── Aside 백엔드 ───
// aside.exe repl 은 Playwright 스타일 JS를 사용자의 Aside 브라우저(로그인·쿠키 유지)에서 실행하고 console.log 를 stdout 으로 돌려준다.
// 호출마다 프로세스가 뜨지만 REPL 컨텍스트와 탭은 유지되므로, 쿠팡 탭을 한 번 열어두고 검색란만 바꿔 재검색(CDP 경로와 같은 패턴).
// 주의: REPL 의 const/let 은 호출 간 유지되므로 코드를 async IIFE 로 감싸 바인딩이 새지 않게 한다.
const ASIDE_MARK = '__ASIDE_RESULT__'
let _asideOk = null
/** Aside CLI 가용 여부(1회 캐시). PATH 의 aside.exe 를 --version 으로 확인. */
export async function asideAvailable() {
  if (_asideOk != null) return _asideOk
  try { const { stdout } = await execFileP('aside', ['--version'], { timeout: 8000, windowsHide: true }); _asideOk = /\d+\.\d+/.test(stdout || '') } catch { _asideOk = false }
  return _asideOk
}
async function asideRepl(code, { timeoutMs = 125000 } = {}) {
  const { stdout } = await execFileP('aside', ['repl', code], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const line = String(stdout || '').split(/\r?\n/).find((l) => l.startsWith(ASIDE_MARK))
  if (!line) throw new Error(`aside repl: 결과 마커 없음 — ${String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 200)}`)
  return JSON.parse(line.slice(ASIDE_MARK.length))
}
// 쿠팡 탭 확보(있으면 붙고 없으면 메인 오픈) + 차단 확인. 결과 {blocked, title}
function _asideAttachCode() {
  return `await (async () => {
  const tabs = await listBrowserTabs();
  const t = tabs.find((x) => /(^|\\/\\/)(www\\.)?coupang\\.com/.test(x.url || ''));
  if (t) { await attachBrowserTab(t.targetId); } else { await openTab('https://www.coupang.com/'); await sleep(1200); }
  let title = await page.title();
  if (/Access Denied/i.test(title)) { await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}); await sleep(2500); title = await page.title(); }
  console.log(${JSON.stringify(ASIDE_MARK)} + JSON.stringify({ blocked: /Access Denied/i.test(title), title }));
})()`
}
// 검색란 교체 → 검색 → 가격 추출. 결과 {blocked, url, got:[{price,title,reviews,rating}]}
// kw 는 JSON.stringify 로 문자열 리터럴화해 주입(argv 로 전달되어 셸 인젝션 없음). 호출측 키워드는 우리 DB/스크립트 값만 쓴다.
function _asideSearchCode(kw) {
  return `await (async () => {
  const KW = ${JSON.stringify(kw)};
  const tabs = await listBrowserTabs();
  const t = tabs.find((x) => /(^|\\/\\/)(www\\.)?coupang\\.com/.test(x.url || ''));
  if (t) { await attachBrowserTab(t.targetId); } else { await openTab('https://www.coupang.com/'); await sleep(1200); }
  const blocked = async () => /Access Denied/i.test(await page.title());
  const doSearch = async () => {
    const input = page.locator('input#headerSearchKeyword, input[name="q"]').first();
    await input.waitFor({ state: 'visible', timeout: 8000 });
    await input.click(); await input.fill(''); await input.type(KW, { delay: 40 });
    const btn = page.locator('form#headerSearchForm button[type="submit"], button.search-btn, .search-btn, form button[type="submit"]').first();
    if (await btn.count().catch(() => 0)) { await btn.click().catch(() => input.press('Enter')); } else { await input.press('Enter'); }
    await sleep(2500);
  };
  await doSearch();
  if (await blocked()) {
    await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}); await sleep(2500);
    if (await blocked()) { console.log(${JSON.stringify(ASIDE_MARK)} + JSON.stringify({ blocked: true })); return; }
    await doSearch();
    if (await blocked()) { console.log(${JSON.stringify(ASIDE_MARK)} + JSON.stringify({ blocked: true })); return; }
  }
  const extract = ${_extractCoupangPrices.toString()};
  const got = await page.evaluate(extract);
  const diag = await page.evaluate(${_diagCoupang.toString()}).catch(() => null);
  console.log(${JSON.stringify(ASIDE_MARK)} + JSON.stringify({ blocked: false, url: page.url(), got, diag }));
})()`
}
/**
 * 쿠팡 세션(Aside) — 사용자의 Aside 브라우저에서 검색. 크롬 9222 불필요. 반환 null = aside 미설치/차단.
 * close()는 사용자 탭을 건드리지 않는다(no-op).
 * @returns {Promise<{search:(kw:string)=>Promise<object|null>, close:()=>Promise<void>, backend:'aside'}|null>}
 */
export async function openCoupangSessionViaAside({ timeoutMs = 125000, quiet = false } = {}) {
  const say = (m) => { if (!quiet) console.log(`  (aside 백엔드 불가: ${m})`) }
  if (!(await asideAvailable())) { say('aside.exe 미설치/PATH 없음'); return null }
  let probe
  try { probe = await asideRepl(_asideAttachCode(), { timeoutMs: 60000 }) } catch (e) { say(`쿠팡 탭 확보 실패 — ${String(e?.message || e).slice(0, 160)}`); return null }
  if (!probe) { say('응답 없음'); return null }
  if (probe.blocked) { say(`쿠팡 Access Denied(차단) — title=${probe.title || ''}`); return null }
  async function search(kw) {
    try {
      const r = await asideRepl(_asideSearchCode(kw), { timeoutMs })
      if (!r || r.blocked) return null
      return _withEmptyReason(_coupangResult(Array.isArray(r.got) ? r.got : []), r.diag)
    } catch { return null }
  }
  async function close() { /* 사용자 브라우저 탭은 그대로 둔다 */ }
  return { search, close, backend: 'aside' }
}

/**
 * 쿠팡 세션 — 백엔드 자동 선택. opts.backend | env COUPANG_PRICE_BACKEND = auto(기본) | aside | cdp | chrome.
 * auto 는 aside → cdp 순으로 시도. 반환 null = 둘 다 불가. 끝나면 close().
 */
export async function openCoupangSession(opts = {}) {
  const backend = String(opts.backend || process.env.COUPANG_PRICE_BACKEND || env.COUPANG_PRICE_BACKEND || 'auto').toLowerCase()
  if (backend === 'cdp') return openCoupangSessionViaCDP(opts)
  if (backend === 'aside') return openCoupangSessionViaAside(opts)
  if (backend === 'chrome') return openCoupangSessionViaChrome(opts)
  return (await openCoupangSessionViaAside(opts)) || openCoupangSessionViaCDP(opts)
}

/**
 * 쿠팡 단건 시세 — openCoupangSession 1회 검색 래퍼. 세션 불가/차단 시 null.
 * @returns {Promise<{source:'coupang', median:number|null, count:number, samples:Array, items:Array}|null>}
 */
export async function coupangMedian(kw, opts = {}) {
  const s = await openCoupangSession(opts)
  if (!s) return null
  try { return await s.search(kw) } finally { await s.close() }
}
/** 구명 호환 — 이제 백엔드 자동(aside→cdp). */
export const coupangMedianViaCDP = coupangMedian

/**
 * 에누리 세션 — 헤드리스 1회 띄워 페이지 재사용(차단 없어 워밍업/CDP 불필요).
 * search(kw)는 검색 후 item__box 카드의 상품명+판매가(tx--price) 원본 리스트 반환(앵커는 호출측).
 * @returns {Promise<{search:(kw:string)=>Promise<{source:'enuri',items:Array}|null>, close:()=>Promise<void>}|null>}
 */
export async function openEnuriSession({ timeoutMs = 25000, waitMs = 3500 } = {}) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  let browser, page
  try { browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] }) } catch { return null }
  try {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', locale: 'ko-KR' })
    page = await ctx.newPage()
  } catch { try { await browser.close() } catch { /* noop */ } return null }
  async function search(kw) {
    try {
      await page.goto('https://www.enuri.com/search.jsp?keyword=' + encodeURIComponent(kw), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      await page.waitForTimeout(waitMs)
      const items = await page.evaluate(() => {
        const out = []
        document.querySelectorAll('[class*="tx--price"]').forEach((pe) => {
          const price = parseInt((pe.textContent || '').replace(/[^0-9]/g, ''))
          if (!price) return
          const card = pe.closest('[class*="item__box"]') || pe.parentElement
          const a = card && card.querySelector('a[title], a[href]')
          const title = (a?.getAttribute('title') || a?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
          if (title) out.push({ title, price })
        })
        return out
      })
      return { source: 'enuri', items }
    } catch { return null }
  }
  async function close() { try { await browser.close() } catch { /* noop */ } }
  return { search, close }
}
