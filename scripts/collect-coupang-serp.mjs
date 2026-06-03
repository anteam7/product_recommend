#!/usr/bin/env node
/**
 * 쿠팡 SERP 실측 스냅샷 수집기 — competition_score 실데이터 접지.
 *
 * docs/trend-radar-v4-execution-plan.md §5.4 의 competition 축은 실시장(공급측)에
 * 직접 닿는 유일한 축인데, 그 SERP 측정값을 적재하는 파이프라인이 없어 추정값으로 돌았음.
 * 본 스크립트는 coupang-debug-search.mjs 의 헤드리스 검색을 기반으로,
 * final_score 상위 후보 + 핀 상품의 alias 키워드로 쿠팡 검색결과를 실측해
 * jimscanner_trends_serp 에 적재한다 (검색결과 수 / 실가격대 분위 / 리뷰 포화 / 로켓·광고 점유).
 *
 *   node scripts/collect-coupang-serp.mjs            # 상위 후보 + 핀 자동 선정
 *   node scripts/collect-coupang-serp.mjs --top 30   # 상위 N개 (기본 20)
 *   node scripts/collect-coupang-serp.mjs --headful  # 브라우저 표시 (디버깅)
 *
 * run-crons.mjs 가 --serp 단계로 매일 호출한다.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

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

const args = process.argv.slice(2)
const topN = (() => {
  const i = args.indexOf('--top')
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) || 20 : 20
})()
const HEADFUL = args.includes('--headful')

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo))
}

/** 한 키워드의 쿠팡 SERP 1페이지를 파싱한다. */
async function scrapeKeyword(page, keyword) {
  const url = 'https://www.coupang.com/np/search?q=' + encodeURIComponent(keyword)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2500)

  return await page.evaluate(() => {
    const out = { prices: [], reviews: [], rocket: 0, ad: 0, cards: 0 }
    // 상품 카드: a[href*="/vp/products/"] 를 가진 li/컨테이너
    const cards = [...document.querySelectorAll('li.search-product, li[class*="ProductUnit"], ul.search-product-list > li')]
    const seen = cards.length ? cards : [...document.querySelectorAll('a[href*="/vp/products/"]')].map((a) => a.closest('li') || a)
    for (const el of seen) {
      const text = (el.textContent || '').replace(/\s+/g, ' ')
      // 가격: "원" 앞 숫자 (콤마 포함)
      const priceMatch = text.match(/([\d,]{3,})\s*원/)
      if (priceMatch) {
        const n = parseInt(priceMatch[1].replace(/,/g, ''), 10)
        if (n > 0 && n < 100000000) out.prices.push(n)
      }
      // 리뷰 수: "(1,234)" 패턴
      const reviewMatch = text.match(/\(\s*([\d,]+)\s*\)/)
      if (reviewMatch) out.reviews.push(parseInt(reviewMatch[1].replace(/,/g, ''), 10))
      // 로켓배송 / 광고 마커
      const cls = (el.className || '') + ' ' + (el.innerHTML || '').slice(0, 2000)
      if (/rocket|로켓/i.test(cls) || el.querySelector('[class*="badge"][class*="rocket"], img[alt*="로켓"]')) out.rocket++
      if (/\bad\b|adMark|광고/i.test(cls) || el.querySelector('[class*="ad-badge"], [class*="adMark"]')) out.ad++
      out.cards++
    }
    return out
  })
}

async function main() {
  // 1) 대상 product 선정: final_score 상위 + 핀.
  const { data: topScores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('final_score', { ascending: false })
    .order('computed_at', { ascending: false })
    .limit(topN * 3)

  const seen = new Set()
  const productIds = []
  for (const r of topScores ?? []) {
    if (r.product_id && !seen.has(r.product_id)) {
      seen.add(r.product_id)
      productIds.push(r.product_id)
    }
    if (productIds.length >= topN) break
  }

  // 핀 상품도 포함 (테이블 존재 시 best-effort)
  try {
    const { data: pins } = await sb.from('jimscanner_trends_pins').select('product_id')
    for (const p of pins ?? []) {
      if (p.product_id && !seen.has(p.product_id)) {
        seen.add(p.product_id)
        productIds.push(p.product_id)
      }
    }
  } catch {
    /* 핀 테이블 미존재 — 무시 */
  }

  if (!productIds.length) {
    console.log('대상 product 없음 (scores 비어있음). 종료.')
    return
  }

  // 2) product 별 검색 키워드 = confidence 최고 alias (없으면 canonical_name).
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .in('id', productIds)
  const nameById = new Map((products ?? []).map((p) => [p.id, p.canonical_name]))

  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, confidence')
    .in('product_id', productIds)
    .order('confidence', { ascending: false })
  const kwById = new Map()
  for (const a of aliases ?? []) if (!kwById.has(a.product_id)) kwById.set(a.product_id, a.alias)

  const targets = productIds
    .map((id) => ({ id, keyword: kwById.get(id) || nameById.get(id) }))
    .filter((t) => t.keyword)

  console.log(`[${new Date().toISOString()}] 쿠팡 SERP 실측 대상 ${targets.length}건`)

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

  let ok = 0
  let fail = 0
  for (const t of targets) {
    try {
      const r = await scrapeKeyword(page, t.keyword)
      const prices = r.prices.filter((n) => n > 0).sort((a, b) => a - b)
      const reviews = r.reviews.filter((n) => n >= 0)
      const reviewSum = reviews.reduce((s, n) => s + n, 0)
      const avgReview = reviews.length ? Math.round(reviewSum / reviews.length) : null

      const row = {
        product_id: t.id,
        keyword: t.keyword,
        listing_count: r.cards || null,
        price_min: prices.length ? prices[0] : null,
        price_p25: percentile(prices, 0.25),
        price_median: percentile(prices, 0.5),
        price_p75: percentile(prices, 0.75),
        price_max: prices.length ? prices[prices.length - 1] : null,
        top_review_sum: reviewSum || null,
        avg_review: avgReview,
        rocket_share: r.cards ? +(r.rocket / r.cards).toFixed(3) : null,
        ad_slot_share: r.cards ? +(r.ad / r.cards).toFixed(3) : null,
        raw_payload: { prices: prices.slice(0, 40), reviews: reviews.slice(0, 40), rocket: r.rocket, ad: r.ad },
      }
      const { error } = await sb.from('jimscanner_trends_serp').insert(row)
      if (error) throw error
      ok++
      console.log(
        `  OK ${t.keyword.slice(0, 28).padEnd(28)} cards=${String(row.listing_count ?? '-').padStart(3)} median=${row.price_median ?? '-'} avgRev=${row.avg_review ?? '-'} rocket=${row.rocket_share ?? '-'}`,
      )
    } catch (e) {
      fail++
      console.log(`  ERR ${t.keyword?.slice(0, 28)} — ${e instanceof Error ? e.message : String(e)}`)
    }
    await page.waitForTimeout(800)
  }

  await browser.close()

  // heartbeat 갱신 (collector 생존 신호)
  try {
    await sb.from('jimscanner_trends_heartbeat').upsert({
      id: 'main',
      heartbeat_at: new Date().toISOString(),
      last_collector: 'collect-coupang-serp',
      last_run_status: fail === 0 ? 'ok' : ok > 0 ? 'partial' : 'error',
      notes: `serp ${ok} ok / ${fail} fail`,
    })
  } catch {
    /* heartbeat 실패는 치명적 아님 */
  }

  console.log(`[${new Date().toISOString()}] SERP 실측 완료 — ${ok} ok / ${fail} fail`)
  if (fail > ok) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
