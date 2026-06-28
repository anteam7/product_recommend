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

/**
 * 쿠팡 — 떠 있는 사용자 크롬(CDP)에 붙어 "사람처럼" 검색해서 결과 가격 중앙값.
 * 크롬이 9222로 안 떠 있거나 차단되면 null 반환(파이프라인은 네이버로 폴백).
 * 사용 전: 크롬을 `--remote-debugging-port=9222` 로 띄우고 쿠팡에 1회 접속(워밍업)해 둘 것.
 * @returns {Promise<{source:'coupang', median:number|null, count:number, samples:Array}|null>}
 */
export async function coupangMedianViaCDP(kw, { endpoint = 'http://127.0.0.1:9222', timeoutMs = 25000, keepPage = false } = {}) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  let browser
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 4000 })
  } catch {
    return null // CDP 미가동 → 폴백
  }
  let page
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext())
    page = await ctx.newPage()
    // 1) 메인 페이지 진입(워밍업된 세션이라 통과)
    await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForTimeout(1200)
    // 차단 확인
    if (/Access Denied/i.test(await page.title())) return null
    // 2) 검색창에 키워드 입력 (사람처럼)
    const input = page.locator('input#headerSearchKeyword, input[name="q"]').first()
    await input.waitFor({ state: 'visible', timeout: 8000 })
    await input.click()
    await input.fill('')
    await input.type(kw, { delay: 40 })
    // 3) 검색 버튼 클릭(딥링크 금지). 버튼 못 찾으면 Enter 폴백.
    const btn = page.locator('form#headerSearchForm button[type="submit"], button.search-btn, .search-btn, form button[type="submit"]').first()
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {}),
      (async () => { if (await btn.count().catch(() => 0)) { await btn.click().catch(() => input.press('Enter')) } else { await input.press('Enter') } })(),
    ])
    await page.waitForTimeout(2500)
    if (/Access Denied/i.test(await page.title())) return null
    // 4) 결과 가격 추출
    const got = await page.evaluate(() => {
      const out = []
      const units = document.querySelectorAll('li.search-product, [class*="ProductUnit"]')
      units.forEach((u) => {
        const pe = u.querySelector('strong.price-value, [class*="price-value"], [class*="priceValue"]')
        const ne = u.querySelector('div.name, [class*="productName"], [class*="name"]')
        const n = parseInt((pe?.textContent || '').replace(/[^0-9]/g, ''))
        if (n > 0) out.push({ price: n, title: (ne?.textContent || '').trim().slice(0, 50) })
      })
      // 폴백: 컨테이너 못잡으면 가격 노드만
      if (!out.length) document.querySelectorAll('strong.price-value').forEach((e) => { const n = parseInt((e.textContent || '').replace(/[^0-9]/g, '')); if (n > 0) out.push({ price: n, title: '' }) })
      return out
    })
    const prices = got.map((g) => g.price).filter((n) => n > 0).sort((a, b) => a - b)
    const lo = Math.floor(prices.length * 0.1), hi = Math.ceil(prices.length * 0.9)
    const trimmed = prices.slice(lo, hi)
    return { source: 'coupang', median: median(trimmed.length ? trimmed : prices), count: prices.length, samples: got.slice(0, 5), items: got.filter((g) => g.price > 0).map((g) => ({ title: g.title, price: g.price })) }
  } catch {
    return null
  } finally {
    try { if (page && !keepPage) await page.close() } catch { /* noop */ }
    // CDP 연결은 끊되 사용자 브라우저는 닫지 않음(close는 연결 해제만)
    try { if (browser) await browser.close() } catch { /* noop */ }
  }
}
