/**
 * 시장가(경쟁가) 조회 — 위탁 소싱 마진 계산용.
 *   - naverShopMedian(kw): 네이버 쇼핑 검색 OpenAPI(공식, 무차단) → 경쟁 lprice 중앙값
 *   - coupangMedianViaCDP(kw): 떠 있는 사용자 크롬에 CDP 접속 → "사람처럼" 검색
 *       (쿠팡 메인 → 검색창 입력 → 검색버튼 클릭. ?q= 딥링크는 Akamai 차단되므로 금지)
 *
 *   import { naverShopMedian, coupangMedianViaCDP, median } from './lib/market-price.mjs'
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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
    out.push({ price, title: (ne?.textContent || '').trim().slice(0, 50), reviews, rating })
  })
  return out
}
function _coupangResult(got) {
  const prices = got.map((g) => g.price).filter((n) => n > 0).sort((a, b) => a - b)
  const lo = Math.floor(prices.length * 0.1), hi = Math.ceil(prices.length * 0.9)
  const trimmed = prices.slice(lo, hi)
  return { source: 'coupang', median: median(trimmed.length ? trimmed : prices), count: prices.length, samples: got.slice(0, 5), items: got.filter((g) => g.price > 0).map((g) => ({ title: g.title, price: g.price, reviews: g.reviews ?? null, rating: g.rating ?? null })) }
}

/**
 * 쿠팡 세션 — 떠 있는 사용자 크롬(CDP)에 1회 붙어 페이지를 '재사용'한다.
 * 최초 1회만 메인 진입(워밍업), 이후 search(kw)는 **결과페이지 검색란만 바꿔 재검색**
 * (새 탭/메인 재진입 없음 → 봇 패턴·Akamai 재차단 위험↓). 다건 스크리닝용.
 * 반환 null = CDP 미가동/차단. 끝나면 반드시 close().
 * @returns {Promise<{search:(kw:string)=>Promise<object|null>, close:()=>Promise<void>}|null>}
 */
export async function openCoupangSession({ endpoint = 'http://127.0.0.1:9222', timeoutMs = 25000 } = {}) {
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

  async function search(kw) {
    try {
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
      if (/Access Denied/i.test(await page.title())) return null
      return _coupangResult(await page.evaluate(_extractCoupangPrices))
    } catch { return null }
  }
  // 재사용한 사용자 탭은 닫지 않음(우리가 새로 연 탭만 닫음). browser.close는 CDP 연결만 끊음.
  async function close() { try { if (page && !reused) await page.close() } catch { /* noop */ } try { await browser.close() } catch { /* noop */ } }
  return { search, close }
}

/**
 * 쿠팡 단건 시세 — openCoupangSession 1회 검색 래퍼(기존 호출부 호환). 크롬 9222 미가동/차단 시 null.
 * @returns {Promise<{source:'coupang', median:number|null, count:number, samples:Array, items:Array}|null>}
 */
export async function coupangMedianViaCDP(kw, opts = {}) {
  const s = await openCoupangSession(opts)
  if (!s) return null
  try { return await s.search(kw) } finally { await s.close() }
}

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
