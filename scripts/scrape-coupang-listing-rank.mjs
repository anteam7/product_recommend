/**
 * 쿠팡 SERP rank watch — 발행 SKU 자체 타겟 키워드 노출 추적
 *
 * 매일 1회 cron 실행 가정.
 *  1) jimscanner_coupang_serp_keywords 의 active=true 행 조회
 *  2) 각 (listing, keyword) 마다 쿠팡 SERP 페이지를 N(기본 5) 페이지까지 스캔
 *  3) listing.product_id 가 발견되면 rank/page 기록, 못 찾으면 rank=NULL
 *  4) jimscanner_coupang_serp_watch 에 1 row 적재
 *
 * 사용:
 *   node scripts/scrape-coupang-listing-rank.mjs
 *   node scripts/scrape-coupang-listing-rank.mjs --limit 3 --depth-pages 3
 *   node scripts/scrape-coupang-listing-rank.mjs --listing <uuid>
 *
 * 의존: playwright (이미 설치돼 있음 — scripts/coupang-debug-search.mjs 참조)
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env.local')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
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
const VENDOR_ID = env.COUPANG_VENDOR_ID ?? ''

const PER_PAGE = 72 // 쿠팡 검색 페이지당 결과 (UI 기준 추정)
const args = process.argv.slice(2)
const argOf = (k, dflt) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt
}
const DEPTH_PAGES = parseInt(argOf('--depth-pages', '5'), 10)
const LIMIT = parseInt(argOf('--limit', '0'), 10) || null
const ONLY_LISTING = argOf('--listing', null)

async function fetchTargets() {
  let q = sb
    .from('jimscanner_coupang_serp_keywords')
    .select('id, listing_id, target_keyword, weight')
    .eq('is_active', true)
  if (ONLY_LISTING) q = q.eq('listing_id', ONLY_LISTING)
  const { data, error } = await q
  if (error) throw error
  const rows = data ?? []
  return LIMIT ? rows.slice(0, LIMIT) : rows
}

async function fetchListingsIndex(listingIds) {
  if (!listingIds.length) return new Map()
  const { data, error } = await sb
    .from('jimscanner_coupang_listings')
    .select('id, product_id, vendor_id, registered_title')
    .in('id', listingIds)
  if (error) throw error
  const m = new Map()
  for (const r of data ?? []) m.set(r.id, r)
  return m
}

function buildSearchUrl(keyword, page) {
  const q = encodeURIComponent(keyword)
  return `https://www.coupang.com/np/search?q=${q}&page=${page}&listSize=${PER_PAGE}`
}

/**
 * 한 페이지 스캔 — productId 가 우리 product_id 와 일치하는 rank 반환
 * 반환: { foundIndex, productIdsOnPage, totalResults }
 *   - foundIndex 는 페이지 내 0-based 인덱스 (없으면 -1)
 */
async function scanPage(page, targetProductId) {
  await page.waitForTimeout(1200)
  const result = await page.evaluate(() => {
    const items = [...document.querySelectorAll('a[href*="/vp/products/"]')]
    const ids = []
    const seen = new Set()
    for (const a of items) {
      const m = a.getAttribute('href')?.match(/\/vp\/products\/(\d+)/)
      if (!m) continue
      const pid = m[1]
      // 같은 컨테이너 안에 광고 표식 있는지 검사 (간단 휴리스틱)
      const li = a.closest('li, article, div.search-product')
      const isAd = li ? /\b(광고|AD)\b/.test(li.textContent || '') : false
      if (seen.has(pid)) continue
      seen.add(pid)
      ids.push({ pid, isAd })
    }
    // total 표기 — 쿠팡은 "총 N개" 라벨이 있음
    let total = null
    const totalEl = document.querySelector('[class*="total"], [class*="Total"]')
    if (totalEl) {
      const m = totalEl.textContent?.match(/[\d,]+/)
      if (m) total = parseInt(m[0].replace(/,/g, ''), 10)
    }
    return { ids, total }
  })

  const idx = result.ids.findIndex(
    (x) => !x.isAd && String(x.pid) === String(targetProductId),
  )
  return { foundIndex: idx, organicCount: result.ids.filter((x) => !x.isAd).length, totalResults: result.total }
}

async function scanOne({ page, listing, target_keyword }) {
  const targetProductId = listing.product_id
  if (!targetProductId) {
    return { rank: null, page: null, vendor_id_match: false, product_id_match: null, total_results: null }
  }
  let cumulative = 0
  let totalResults = null
  for (let pg = 1; pg <= DEPTH_PAGES; pg++) {
    const url = buildSearchUrl(target_keyword, pg)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.warn(`  goto failed pg=${pg}: ${e.message}`)
      continue
    }
    const { foundIndex, organicCount, totalResults: tr } = await scanPage(page, targetProductId)
    if (tr != null && totalResults == null) totalResults = tr
    if (foundIndex >= 0) {
      const rank = cumulative + foundIndex + 1
      return {
        rank,
        page: pg,
        vendor_id_match: true,
        product_id_match: Number(targetProductId),
        total_results: totalResults,
      }
    }
    cumulative += organicCount
    if (organicCount === 0) break // 결과 끝
  }
  return {
    rank: null,
    page: null,
    vendor_id_match: false,
    product_id_match: null,
    total_results: totalResults,
  }
}

async function main() {
  const targets = await fetchTargets()
  console.log(`Targets: ${targets.length}`)
  if (!targets.length) {
    console.log('No active keywords — exiting.')
    return
  }

  const listings = await fetchListingsIndex([...new Set(targets.map((t) => t.listing_id))])

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1366, height: 768 },
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  const page = await ctx.newPage()

  let ok = 0
  let miss = 0
  let err = 0
  const captured_at = new Date().toISOString()

  for (const t of targets) {
    const listing = listings.get(t.listing_id)
    if (!listing) {
      console.warn(`skip — listing ${t.listing_id} not found`)
      continue
    }
    try {
      console.log(`[scan] "${t.target_keyword}" → pid=${listing.product_id ?? 'NULL'}`)
      const res = await scanOne({ page, listing, target_keyword: t.target_keyword })
      const row = {
        listing_id: t.listing_id,
        target_keyword: t.target_keyword,
        rank: res.rank,
        page: res.page,
        vendor_id_match: res.vendor_id_match,
        product_id_match: res.product_id_match,
        total_results: res.total_results,
        scan_depth: DEPTH_PAGES * PER_PAGE,
        captured_at,
      }
      const { error } = await sb.from('jimscanner_coupang_serp_watch').insert(row)
      if (error) {
        console.error('  insert error:', error.message)
        err++
      } else if (res.rank != null) {
        console.log(`  ✓ rank=${res.rank} (page ${res.page})`)
        ok++
      } else {
        console.log(`  · not found in top ${DEPTH_PAGES * PER_PAGE}`)
        miss++
      }
    } catch (e) {
      console.error('  scan error:', e.message)
      err++
    }
    // 봇 우회 — 키워드 사이 짧은 휴식
    await page.waitForTimeout(1500)
  }

  await browser.close()
  console.log(`Done — hit=${ok} miss=${miss} err=${err} (vendor=${VENDOR_ID || 'n/a'})`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
