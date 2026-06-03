#!/usr/bin/env node
/**
 * 쿠팡 SERP 스냅샷 수집 — 실판매 속도(Sell-through Velocity) 입력.
 *
 * 검색 키워드별 상위 N개 리스팅의 (순위·가격·평점·리뷰수)를 시점 캡처해
 * jimscanner_trends_serp_snapshot 에 적재한다. 연속 두 스냅샷 차분으로
 * RPC jimscanner_serp_velocity 가 Δreview/Δt → 실판매수량·월매출을 역산한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/collect-coupang-serp-snapshot.mjs --keyword="멜라토닌" --top=20 --cat=health
 *   node --env-file=.env.local scripts/collect-coupang-serp-snapshot.mjs --keywords="멜라토닌,루테인,오메가3" --cat=health
 *   node --env-file=.env.local scripts/collect-coupang-serp-snapshot.mjs --headful   # 디버그(브라우저 표시)
 *
 * Windows Task Scheduler 등록 예 (매일 1회 — coupang stock/order sync 러너와 동일 패턴):
 *   $action = New-ScheduledTaskAction -Execute "node.exe" `
 *     -Argument "--env-file=.env.local scripts/collect-coupang-serp-snapshot.mjs --keywords=멜라토닌,루테인,오메가3 --cat=health" `
 *     -WorkingDirectory "C:\Web\jimscanner-personal"
 *   $trigger = New-ScheduledTaskTrigger -Daily -At 4:00am
 *   Register-ScheduledTask -TaskName "jimscanner-coupang-serp-snapshot" -Action $action -Trigger $trigger -RunLevel Limited
 *
 * 주의: 차분(velocity)은 캡처 간격이 균일할수록 정확. 매일 1회 권장.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
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
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const arg = (k) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`))
  return a ? a.split('=').slice(1).join('=') : null
}
const flag = (k) => process.argv.includes(`--${k}`)

const KEYWORDS = (arg('keywords') || arg('keyword') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TOP = parseInt(arg('top') || '20', 10)
const CATEGORY = arg('cat') || null
const HEADFUL = flag('headful')

if (KEYWORDS.length === 0) {
  console.error('키워드 필요: --keyword="멜라토닌" 또는 --keywords="a,b,c"')
  process.exit(1)
}

/** SERP 한 페이지에서 상위 TOP개 리스팅 추출. */
async function scrapeSerp(page, keyword) {
  const url = 'https://www.coupang.com/np/search?q=' + encodeURIComponent(keyword) + '&listSize=36'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2500)

  return await page.evaluate((top) => {
    const out = []
    // 검색 결과 li (ProductUnit / search-product) — 클래스명은 변동될 수 있어 다중 셀렉터.
    const items = [
      ...document.querySelectorAll('li.search-product, li[class*="ProductUnit"], ul#productList > li'),
    ]
    const toInt = (s) => {
      const n = parseInt(String(s || '').replace(/[^0-9]/g, ''), 10)
      return Number.isFinite(n) ? n : null
    }
    const toFloat = (s) => {
      const m = String(s || '').match(/[0-9]+(\.[0-9]+)?/)
      return m ? parseFloat(m[0]) : null
    }
    for (const li of items) {
      if (out.length >= top) break
      const a = li.querySelector('a[href*="/vp/products/"]')
      if (!a) continue
      const m = a.getAttribute('href')?.match(/\/vp\/products\/(\d+)/)
      if (!m) continue
      const itemId = m[1]

      const title =
        li.querySelector('[class*="name"], .name, .descriptions .name')?.textContent?.trim() ||
        a.textContent?.trim().slice(0, 200) ||
        null
      const price =
        toInt(li.querySelector('[class*="price-value"], strong.price-value, .price-value')?.textContent) ??
        toInt(li.querySelector('[class*="price"]')?.textContent)
      const rating = toFloat(li.querySelector('[class*="rating"]:not([class*="count"]), em.rating')?.textContent)
      const reviewCount =
        toInt(li.querySelector('[class*="rating-total-count"], .rating-total-count')?.textContent) ?? 0

      out.push({ itemId, title, price, rating, reviewCount })
    }
    return out
  }, TOP)
}

async function main() {
  const browser = await chromium.launch({
    headless: !HEADFUL,
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

  // 단일 captured_at 으로 한 run 의 모든 row 를 묶음 (velocity 차분 시 시점 일관).
  const capturedAt = new Date().toISOString()
  let totalInserted = 0

  for (const keyword of KEYWORDS) {
    try {
      const items = await scrapeSerp(page, keyword)
      if (items.length === 0) {
        console.warn(`[${keyword}] 결과 0건 (셀렉터 변동/봇차단 가능) — 스킵`)
        continue
      }
      const rows = items.map((it, idx) => ({
        keyword,
        category_top: CATEGORY,
        coupang_item_id: it.itemId,
        product_title: it.title,
        rank: idx + 1,
        price: it.price,
        rating: it.rating,
        review_count: it.reviewCount ?? 0,
        captured_at: capturedAt,
      }))
      // UNIQUE(coupang_item_id, captured_at) 충돌 무시 — 동일 run 중복 방지
      const { error } = await sb
        .from('jimscanner_trends_serp_snapshot')
        .upsert(rows, { onConflict: 'coupang_item_id,captured_at', ignoreDuplicates: true })
      if (error) {
        console.error(`[${keyword}] 적재 실패:`, error.message)
        continue
      }
      totalInserted += rows.length
      console.log(`[${keyword}] ${rows.length}건 적재 (리뷰합 ${rows.reduce((s, r) => s + r.review_count, 0).toLocaleString()})`)
      await page.waitForTimeout(1500) // rate-limit 회피
    } catch (e) {
      console.error(`[${keyword}] 오류:`, e.message)
    }
  }

  await browser.close()
  console.log(`\n완료: ${KEYWORDS.length}개 키워드, 총 ${totalInserted}건 스냅샷 (captured_at=${capturedAt})`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
