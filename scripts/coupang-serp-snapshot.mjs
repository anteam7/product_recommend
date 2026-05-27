#!/usr/bin/env node
/**
 * 쿠팡 SERP 셀러 스냅샷 — 주 1회 KST 일요일 03:00 실행 (Windows Task Scheduler).
 *
 * 키워드 시드 목록을 돌면서 자연 검색 (광고 제외) 상위 N개의 셀러 식별자를
 * jimscanner_serp_seller_snapshots 에 적재. 4·8·12주 후 동일 셀러 잔존율을
 * jimscanner_seller_churn_rpc 가 산출하여 카테고리 진입 함정을 판별.
 *
 * 시드: jimscanner_trends_keywords 에서 최근 30일 등장 키워드 중
 *       category_top 이 health/living/digital 인 것 상위 빈도순 100개.
 *       (별도 시드 테이블 없이 기존 데이터 재활용)
 *
 * 사용법:
 *   node --env-file=.env.local scripts/coupang-serp-snapshot.mjs
 *   node --env-file=.env.local scripts/coupang-serp-snapshot.mjs --limit 20  # 디버그용
 *   node --env-file=.env.local scripts/coupang-serp-snapshot.mjs --headful   # 디버그용
 */
import { chromium as _chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { createClient } from '@supabase/supabase-js'

_chromium.use(StealthPlugin())
const chromium = _chromium

const args = process.argv.slice(2)
const limitArg = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : 100
const headful = args.includes('--headful')
const topN = args.includes('--top') ? parseInt(args[args.indexOf('--top') + 1]) : 20

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락. --env-file 지정?')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

// 시드 키워드 가져오기 — 카테고리 분류된 trends_products 의 canonical_name 우선,
// 그다음 trends_keywords 에서 category_top 매칭된 키워드 (최근 30일 빈도순).
async function loadSeeds() {
  const seeds = []
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('canonical_name, category_top')
    .in('category_top', ['health', 'living', 'digital'])
    .order('last_seen_at', { ascending: false })
    .limit(limitArg)

  for (const p of products ?? []) {
    if (p.canonical_name && p.category_top) {
      seeds.push({ keyword: p.canonical_name, category_top: p.category_top })
    }
  }

  if (seeds.length === 0) {
    // fallback: trends_keywords 에서 직접
    const since = new Date(Date.now() - 30 * 86400_000).toISOString()
    const { data: kws } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top')
      .gte('collected_at', since)
      .in('category_top', ['health', 'living', 'digital'])
      .limit(limitArg)
    for (const k of kws ?? []) {
      if (k.keyword && k.category_top) {
        seeds.push({ keyword: k.keyword, category_top: k.category_top })
      }
    }
  }
  // dedupe by keyword
  const seen = new Set()
  return seeds.filter((s) => {
    const k = s.keyword.trim().toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

async function scrapeSerp(page, keyword) {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
  await page.waitForTimeout(800)
  return await page.evaluate((maxN) => {
    const out = []
    const items = document.querySelectorAll('li, [class*="ProductUnit"]')
    for (const li of items) {
      const a = li.querySelector('a[href*="/vp/products/"]')
      if (!a) continue
      if (/sourceType=srp_product_ads/.test(a.href)) continue
      const href = a.href
      // vendorItemId 또는 productId 를 셀러/리스팅 식별자로
      const vendorM = href.match(/vendorItemId=(\d+)/)
      const productM = href.match(/\/vp\/products\/(\d+)/)
      const sellerId = vendorM ? `v:${vendorM[1]}` : productM ? `p:${productM[1]}` : null
      if (!sellerId) continue
      const nameEl = li.querySelector('[class*="name" i], .name')
      const sellerName = (nameEl?.textContent || li.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 200)
      // 중복 셀러 (동일 vendor 의 다른 SKU) 1회만
      if (out.find((r) => r.sellerId === sellerId)) continue
      out.push({
        sellerId,
        sellerName,
        rank: out.length + 1,
        url: href.split('?')[0],
      })
      if (out.length >= maxN) break
    }
    return out
  }, topN)
}

async function main() {
  const seeds = await loadSeeds()
  console.log(`SERP 시드 ${seeds.length}건 로드 완료`)
  if (seeds.length === 0) {
    console.log('수집할 키워드가 없음. trends_products 가 비어있는지 확인.')
    return
  }

  console.log('chromium 실행 중 …')
  const browser = await chromium.launch({
    headless: !headful,
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

  const t0 = Date.now()
  let okCount = 0
  let totalRows = 0
  const capturedAt = new Date().toISOString()

  for (let i = 0; i < seeds.length; i++) {
    const { keyword, category_top } = seeds[i]
    try {
      const items = await scrapeSerp(page, keyword)
      if (items.length > 0) {
        const rows = items.map((it) => ({
          keyword,
          category_top,
          seller_id: it.sellerId,
          seller_name: it.sellerName,
          rank: it.rank,
          listing_url: it.url,
          captured_at: capturedAt,
        }))
        const { error } = await sb
          .from('jimscanner_serp_seller_snapshots')
          .insert(rows)
        if (error) {
          console.log(`  [${keyword}] insert error: ${error.message}`)
        } else {
          okCount++
          totalRows += rows.length
        }
      }
      console.log(
        `[${(i + 1).toString().padStart(3)}/${seeds.length}] ${category_top.padEnd(8)} ${keyword.slice(0, 30).padEnd(30)} → ${items.length}건`,
      )
    } catch (e) {
      console.log(`[${i + 1}] ${keyword} ERROR: ${e.message}`)
    }
    await page.waitForTimeout(2000 + Math.random() * 2000)
  }

  await browser.close()
  console.log(
    `\n=== 완료: ${okCount}/${seeds.length} 키워드 OK, ${totalRows} row 적재 (${((Date.now() - t0) / 1000).toFixed(1)}초) ===`,
  )
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
