/**
 * 쿠팡 시세 조사 — Chrome CDP attach 방식
 * 사용자가 직접 실행한 Chrome (remote-debugging-port=9222)에 attach
 * 일반 사용자 트래픽이라 봇 차단 회피
 *
 * 사용 절차:
 *   1) PowerShell에서 아래 명령 실행 (별도 Chrome 인스턴스 시작):
 *      Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\temp\chrome-debug-coupang"
 *   2) 새로 뜬 Chrome 창은 그대로 두기 (닫지 말 것)
 *   3) 이 스크립트 실행: node scripts/coupang-market-prices-cdp.mjs
 *
 * 옵션:
 *   --limit N  : 최대 N건 (기본 전체)
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { normalizePrice } from './lib/pack-normalize.mjs'

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
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '85')

// CDP attach
console.log('Chrome CDP (localhost:9222) attach …')
let browser
try {
  browser = await chromium.connectOverCDP('http://localhost:9222')
} catch (e) {
  console.error('❌ Chrome CDP 연결 실패. 먼저 Chrome을 remote-debugging-port=9222로 실행:')
  console.error('   PowerShell: Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\\temp\\chrome-debug-coupang"')
  console.error('   에러:', e.message)
  process.exit(1)
}
const ctx = browser.contexts()[0] ?? await browser.newContext()
const page = await ctx.newPage()
console.log('✓ Chrome attach 성공\n')

// 시세 조사 대상
const { data: missingRows } = await sb
  .from('jimscanner_coupang_listings')
  .select('source_goods_no, jimscanner_ggsan_products!inner(goods_no, raw_payload)')
  .in('status', ['APPROVED', 'SELLING', 'STOPPED', 'PENDING_APPROVAL', 'TEMPORARY_SAVE'])
const missingIds = (missingRows ?? [])
  .filter((r) => !r.jimscanner_ggsan_products?.raw_payload?.market_price?.median)
  .map((r) => r.source_goods_no)
  .slice(0, limit)

const { data: rows } = await sb
  .from('jimscanner_ggsan_products')
  .select('goods_no, title, price_krw, min_sell_price_krw, raw_payload')
  .in('goods_no', missingIds)

console.log(`시세 조사 대상: ${rows.length}건\n`)

async function searchPrices(query) {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(query)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
  await page.waitForTimeout(1000)
  return await page.evaluate(() => {
    const results = []
    for (const li of document.querySelectorAll('li, [class*="ProductUnit"]')) {
      const a = li.querySelector('a[href*="/vp/products/"]')
      if (!a) continue
      if (/sourceType=srp_product_ads/.test(a.href)) continue
      const m = (li.textContent || '').match(/([\d,]{3,})\s*원/)
      if (!m) continue
      const price = parseInt(m[1].replace(/,/g, ''))
      if (price < 3000 || price > 5000000) continue
      const name = (li.querySelector('[class*="name" i], .name')?.textContent || li.textContent.slice(0, 100)).trim().replace(/\s+/g, ' ').slice(0, 120)
      const k = a.href.split('?')[0]
      if (results.find((r) => r.href === k)) continue
      const txt = li.textContent || ''
      const rocket = /로켓|rocket/i.test(li.innerHTML)
      const rev = txt.match(/\(\s*([\d,]+)\s*\)/) // 리뷰수 (괄호 안 숫자)
      const reviews = rev ? parseInt(rev[1].replace(/,/g, '')) : null
      results.push({ name, price, href: k, rocket, reviews })
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

const t0 = Date.now()
let ok = 0, noData = 0, errors = 0
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  const idx = `[${i + 1}/${rows.length}]`
  const q = (r.raw_payload?.title_real || r.title).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ')
  try {
    const items = await searchPrices(q)
    const prices = items.map((x) => x.price)
    const med = median(prices)
    if (med == null) {
      noData++
      console.log(`${idx} ⏭ ${r.goods_no} ${q.slice(0,40)} — no data`)
    } else {
      ok++
      const msp = r.min_sell_price_krw
      const verdict = msp && med >= msp ? 'OK' : msp && med >= msp * 0.85 ? 'BORDERLINE' : 'NOT_COMPETITIVE'
      const newPayload = {
        ...(r.raw_payload || {}),
        market_price: {
          query: q,
          samples: items.map((x) => x.price),
          median: med,
          min: Math.min(...prices),
          max: Math.max(...prices),
          verdict,
          msp_compare: msp ? { msp, gap_pct: Math.round(((med - msp) / msp) * 100) } : null,
          collected_at: new Date().toISOString(),
          source: 'chrome_cdp',
        },
      }
      await sb.from('jimscanner_ggsan_products').update({ raw_payload: newPayload }).eq('goods_no', r.goods_no)

      // 화이트스페이스 보드용: 경쟁 리스팅을 개당가로 정규화해 시계열 적재.
      // est_monthly_revenue 는 리뷰수×개당가 프록시(리뷰수 = 누적 판매 대용) — 절대값보다 밴드 간 상대 비교용.
      const scannedAt = new Date().toISOString()
      const listingRows = items.map((it) => {
        const norm = normalizePrice(it.price, it.name)
        return {
          product_id: r.goods_no,
          keyword: q,
          unit_price: norm.unitPrice,
          pack_count: norm.packCount,
          list_price: it.price,
          est_monthly_revenue: it.reviews != null ? it.reviews * norm.unitPrice : null,
          rocket: !!it.rocket,
          listing_name: it.name,
          listing_href: it.href,
          scanned_at: scannedAt,
        }
      })
      if (listingRows.length) await sb.from('jimscanner_trends_market_prices').insert(listingRows)

      console.log(`${idx} ✓ ${r.goods_no} MSP=${msp?.toLocaleString()} median=${med.toLocaleString()} | ${verdict}`)
    }
  } catch (e) {
    errors++
    console.log(`${idx} ✗ ${r.goods_no} ERROR: ${e.message.slice(0, 100)}`)
  }
  await page.waitForTimeout(1500 + Math.random() * 1500)  // 1.5~3s random
}

await page.close()
console.log(`\n=== 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초) ===  OK: ${ok}, no_data: ${noData}, errors: ${errors}`)
