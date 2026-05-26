/**
 * 쿠팡 캐노니컬 상품(/vp/products/{id}) 페이지에서
 *   - 'OO명의 판매자가 판매중' (sellers_count)
 *   - winner 가격, winner 배지(로켓/로켓와우/로켓프레시/로켓직구/일반)
 *   - 캐노니컬 누적 리뷰 수
 *   - 직전 snapshot 대비 winner 교체 여부 → 30일 churn 카운트
 * 를 수집해 jimscanner_coupang_catalog_crowding 에 적재.
 *
 * 입력: ggsan_products.raw_payload.market_price.top.href 에 캐노니컬 상품 URL
 *       (scripts/coupang-market-prices.mjs 에서 이미 저장됨)
 *
 * 사용:
 *   node scripts/coupang-catalog-crowding.mjs
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

function extractProductId(href) {
  const m = (href || '').match(/\/vp\/products\/(\d+)/)
  return m ? m[1] : null
}

function classifyBadge(text) {
  if (!text) return 'normal'
  if (/로켓\s*와우/.test(text)) return 'rocket_wow'
  if (/로켓\s*프레시/.test(text)) return 'rocket_fresh'
  if (/로켓\s*직구/.test(text)) return 'rocket_global'
  if (/로켓\s*배송|로켓/.test(text)) return 'rocket'
  return 'normal'
}

const { data: rows } = await sb
  .from('jimscanner_ggsan_products')
  .select('goods_no, title, raw_payload')
  .not('raw_payload->market_price->top->>href', 'is', null)
  .limit(200)

const targets = (rows ?? [])
  .map((r) => ({
    goods_no: r.goods_no,
    title: r.title,
    href: r.raw_payload?.market_price?.top?.href,
    product_id: extractProductId(r.raw_payload?.market_price?.top?.href),
  }))
  .filter((t) => t.product_id)

console.log(`대상 ${targets.length}건 (캐노니컬 URL 보유한 ggsan)`)
if (targets.length === 0) {
  console.log('수집할 대상 없음. 먼저 coupang-market-prices.mjs 실행 필요.')
  process.exit(0)
}

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

async function scrapeCatalog(productId) {
  const url = `https://www.coupang.com/vp/products/${productId}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
  await page.waitForTimeout(1200)
  return await page.evaluate(() => {
    const root = document.body
    const text = root?.innerText || ''
    // 'OO명의 판매자가 판매중' or 'N명의 판매자' 또는 '다른 셀러 N개'
    let sellers = null
    const m1 = text.match(/(\d+)\s*명(?:의)?\s*판매자/)
    const m2 = text.match(/다른\s*셀러\s*(\d+)/)
    const m3 = text.match(/판매자\s*비교\s*\((\d+)\)/)
    if (m1) sellers = parseInt(m1[1])
    else if (m2) sellers = parseInt(m2[1]) + 1
    else if (m3) sellers = parseInt(m3[1])

    // winner 가격
    let winnerPrice = null
    const priceEl =
      document.querySelector('.total-price strong, .prod-price .total-price, .price-amount, [class*="totalPrice"]') ||
      document.querySelector('[data-testid*="price"]')
    if (priceEl) {
      const pm = (priceEl.textContent || '').replace(/[^\d]/g, '')
      if (pm) winnerPrice = parseInt(pm)
    }
    if (!winnerPrice) {
      const pm2 = text.match(/([\d,]{4,})\s*원/)
      if (pm2) winnerPrice = parseInt(pm2[1].replace(/,/g, ''))
    }

    // winner 배지 텍스트
    const badgeAreaText =
      document.querySelector('.badges, .prod-badges, [class*="Badge"], [class*="rocket" i]')?.textContent ||
      text.slice(0, 3000)

    // 캐노니컬 누적 리뷰 수
    let reviewCount = null
    const rm = text.match(/(?:리뷰|review)\s*(?:수|count)?\s*[\(:]?\s*([\d,]{1,7})/i)
    if (rm) reviewCount = parseInt(rm[1].replace(/,/g, ''))
    if (reviewCount == null) {
      const rm2 = text.match(/([\d,]{2,7})\s*개의?\s*리뷰/)
      if (rm2) reviewCount = parseInt(rm2[1].replace(/,/g, ''))
    }

    // winner 셀러명 (보통 '판매자: XXX')
    let sellerName = null
    const sm = text.match(/판매자\s*[:\s]+\s*([^\n\r]{1,40})/)
    if (sm) sellerName = sm[1].trim().slice(0, 60)

    return {
      sellers_count: sellers,
      winner_price: winnerPrice,
      badge_text: badgeAreaText.slice(0, 300),
      canonical_review_count: reviewCount,
      winner_seller_name: sellerName,
    }
  })
}

async function fetchPrevSnapshot(productId) {
  const { data } = await sb
    .from('jimscanner_coupang_catalog_crowding')
    .select('winner_price, winner_seller_name, winner_churn_30d, snapshot_at')
    .eq('product_id', productId)
    .gte('snapshot_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
    .order('snapshot_at', { ascending: false })
    .limit(50)
  return data ?? []
}

const t0 = Date.now()
for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  try {
    const scrap = await scrapeCatalog(t.product_id)
    const badge = classifyBadge(scrap.badge_text)
    const prev = await fetchPrevSnapshot(t.product_id)
    // 30일 winner churn = 직전 30일 동안 winner_price OR seller 가 바뀐 횟수
    let churn = 0
    let last = { price: scrap.winner_price, seller: scrap.winner_seller_name }
    for (const p of prev) {
      if (
        (p.winner_price != null && last.price != null && p.winner_price !== last.price) ||
        (p.winner_seller_name && last.seller && p.winner_seller_name !== last.seller)
      ) {
        churn += 1
      }
      last = { price: p.winner_price, seller: p.winner_seller_name }
    }

    const insert = {
      product_id: t.product_id,
      ggsan_sku: t.goods_no,
      sellers_count: scrap.sellers_count,
      winner_price: scrap.winner_price,
      winner_badge_type: badge,
      winner_seller_name: scrap.winner_seller_name,
      winner_churn_30d: churn,
      canonical_review_count: scrap.canonical_review_count,
      raw_payload: scrap,
    }
    await sb.from('jimscanner_coupang_catalog_crowding').insert(insert)
    console.log(
      `[${t.product_id}] ggsan=${t.goods_no} sellers=${scrap.sellers_count ?? '?'} price=${scrap.winner_price?.toLocaleString() ?? '?'} badge=${badge} churn30=${churn} reviews=${scrap.canonical_review_count ?? '?'}`,
    )
  } catch (e) {
    console.log(`[${t.product_id}] ERROR: ${e.message}`)
  }
  await page.waitForTimeout(2000 + Math.random() * 2000)
}

await browser.close()
console.log(`\n=== 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초) ===`)
