/**
 * 홈쇼핑모아(hsmoa) 통합 편성 수집 — 전 채널 방송상품 + 방송가.
 * 렌더 필요(JS), 차단 없음(헤드리스 가능). 상품명=break-all 폰트요소, 방송가=가격열 마지막 금액(할인가).
 *   import { fetchHsmoaProducts } from './lib/hsmoa.mjs'
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * 현재 hsmoa 페이지의 방송상품 리스트.
 * @returns {Promise<Array<{name:string, price:number}>>}
 */
export async function fetchHsmoaProducts({ limit = 80, waitMs = 4500 } = {}) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] })
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' })
    const page = await ctx.newPage()
    await page.goto('https://hsmoa.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(waitMs)
    const items = await page.evaluate(() => {
      const out = []
      const seen = new Set()
      // 상품명 요소: break-all(상품명 칸). 각 상품명의 가격열(flex-col)에서 마지막 금액=방송가(할인 후).
      document.querySelectorAll('[class*="break-all"]').forEach((ne) => {
        if (ne.children.length) return
        let name = (ne.textContent || '').replace(/^[●\s]+/, '').replace(/^\[[^\]]*\]\s*/, '').trim()
        if (name.length < 4) return
        if (/^[0-9,]+\s*원?$/.test(name)) return                                  // 가격이 이름으로 잡힘
        if (/^(앱전용가|구매하기|원가|함께\s*방송|상품\s*더보기|방송|최저가|무료배송|적립|쿠폰|\d+%)/.test(name)) return // 라벨
        if (!/[가-힣A-Za-z]/.test(name)) return                                    // 글자 없는 건 제외
        const col = ne.closest('[class*="flex-col"]') || ne.parentElement
        const pm = (col?.innerText || '').match(/([0-9]{1,3}(?:,[0-9]{3})+)\s*원/g)
        if (!pm) return
        const price = parseInt(pm[pm.length - 1].replace(/[^0-9]/g, '')) // 마지막=할인 후 방송가
        if (!price) return
        const key = name.slice(0, 24)
        if (seen.has(key)) return
        seen.add(key)
        out.push({ name: name.slice(0, 60), price })
      })
      return out
    })
    return items.slice(0, limit)
  } finally { await browser.close().catch(() => {}) }
}
