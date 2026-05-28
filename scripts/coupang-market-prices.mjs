/**
 * 파일럿 20건의 쿠팡 시세 조사
 *   - 각 상품명으로 쿠팡 검색
 *   - 자연 검색 (광고 제외) 상위 5개 가격 추출
 *   - 중앙값 → coupang_market_price (시세 추정치)
 *   - DB raw_payload.market_price 에 저장
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium as _chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
_chromium.use(StealthPlugin())
const chromium = _chromium
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// 시세 데이터 없는 listings의 goods_no 자동 추출
const { data: missingRows } = await sb
  .from('jimscanner_coupang_listings')
  .select('source_goods_no, jimscanner_ggsan_products!inner(goods_no, raw_payload)')
  .in('status', ['APPROVED','SELLING','STOPPED','PENDING_APPROVAL','TEMPORARY_SAVE'])
const missingIds = (missingRows ?? [])
  .filter((r) => !r.jimscanner_ggsan_products?.raw_payload?.market_price?.median)
  .map((r) => r.source_goods_no)

const { data: rows } = await sb
  .from('jimscanner_ggsan_products')
  .select('goods_no, title, price_krw, min_sell_price_krw, raw_payload')
  .in('goods_no', missingIds)
  .limit(85)

// 리프라이싱 시계열용: 내 현재 등록가 맵 (goods_no → list_price) — my_is_winner 판정
const { data: listingRows } = await sb
  .from('jimscanner_coupang_listings')
  .select('source_goods_no, list_price_krw')
  .in('source_goods_no', (rows ?? []).map((r) => r.goods_no))
const myPriceMap = new Map(
  (listingRows ?? []).map((l) => [l.source_goods_no, l.list_price_krw]),
)

console.log(`대상 ${rows?.length}건`)
console.log('chromium 실행 중 …')
const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-sandbox',
  ],
})
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'ko-KR',
  viewport: { width: 1366, height: 768 },
  extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
})
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko'] })
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
})
const page = await ctx.newPage()

async function searchPrices(query) {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(query)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForTimeout(800)
  return await page.evaluate(() => {
    const results = []
    const items = document.querySelectorAll('li, [class*="ProductUnit"]')
    for (const li of items) {
      const a = li.querySelector('a[href*="/vp/products/"]')
      if (!a) continue
      if (/sourceType=srp_product_ads/.test(a.href)) continue
      const txt = li.textContent || ''
      const m = txt.match(/([\d,]{3,})\s*원/)
      if (!m) continue
      const price = parseInt(m[1].replace(/,/g, ''))
      if (price < 3000 || price > 5000000) continue
      const name = (li.querySelector('[class*="name" i], .name')?.textContent || txt.slice(0, 100))
        .trim().replace(/\s+/g, ' ').slice(0, 120)
      const k = a.href.split('?')[0]
      if (results.find((r) => r.href === k)) continue
      results.push({ name, price, href: k })
      if (results.length >= 5) break
    }
    return results
  })
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  if (s.length === 0) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b)
  if (s.length === 0) return null
  const idx = Math.min(s.length - 1, Math.floor((s.length - 1) * p))
  return s[idx]
}

const t0 = Date.now()
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  const title = r.raw_payload?.title_real || r.title
  // 검색어: 상품명에서 괄호/마지막 단어 정리 (너무 긴 거 잘라냄)
  const q = title.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ')
  try {
    const items = await searchPrices(q)
    const prices = items.map((x) => x.price)
    const med = median(prices)
    const min = prices.length ? Math.min(...prices) : null
    const max = prices.length ? Math.max(...prices) : null
    const top = items[0]
    const msp = r.min_sell_price_krw

    // 경쟁력 판단
    let verdict = 'NO_DATA'
    if (med != null && msp) {
      if (med >= msp) verdict = 'OK'
      else if (med >= msp * 0.85) verdict = 'BORDERLINE'
      else verdict = 'NOT_COMPETITIVE'
    }
    console.log(
      `[${r.goods_no}] ${title.slice(0, 40).padEnd(40)} | MSP=${msp?.toLocaleString().padStart(8)} | top=${top?.price?.toLocaleString().padStart(8) ?? '—'} median=${med?.toLocaleString().padStart(8) ?? '—'} (${items.length}건) | ${verdict}`,
    )

    const newPayload = {
      ...(r.raw_payload || {}),
      market_price: {
        query: q,
        top: top ? { name: top.name, price: top.price, href: top.href } : null,
        samples: items,
        median: med,
        min,
        max,
        verdict,
        msp_compare: msp ? { msp, gap_pct: med != null ? Math.round(((med - msp) / msp) * 100) : null } : null,
        collected_at: new Date().toISOString(),
      },
    }
    await sb.from('jimscanner_ggsan_products').update({ raw_payload: newPayload }).eq('goods_no', r.goods_no)

    // 리프라이싱 시계열 누적 — jimscanner_coupang_market_price_history (append-only)
    if (med != null && prices.length > 0) {
      const myPrice = myPriceMap.get(r.goods_no) ?? null
      const p25 = percentile(prices, 0.25)
      await sb.from('jimscanner_coupang_market_price_history').insert({
        goods_no: r.goods_no,
        competitor_min: min,
        competitor_median: med,
        competitor_p25: p25,
        sample_count: prices.length,
        my_list_price: myPrice,
        my_is_winner: myPrice != null && min != null ? myPrice <= min : null,
        query: q,
        raw: { samples: items },
      })
    }
  } catch (e) {
    console.log(`[${r.goods_no}] ERROR: ${e.message}`)
  }
  // 봇 차단 회피: 2~4초 random
  await page.waitForTimeout(2000 + Math.random() * 2000)
}

await browser.close()
console.log(`\n=== 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초) ===`)
