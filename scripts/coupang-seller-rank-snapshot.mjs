#!/usr/bin/env node
/**
 * 쿠팡 SERP 셀러 일일 스냅샷 (seller-rank-snapshot)
 *
 * 목적:
 *   jimscanner_serp_seller_snapshots 에 카테고리/키워드 × 일자 × 셀러 × 순위를 적재.
 *   적재 후 RPC jimscanner_refresh_seller_velocity / jimscanner_compute_openness_index 호출.
 *
 * 실행:
 *   1) Chrome 을 remote-debugging-port=9222 로 띄운 상태에서
 *   2) node --env-file=.env.local scripts/coupang-seller-rank-snapshot.mjs
 *
 * coupang-market-prices-cdp.mjs 의 CDP attach 패턴 재사용.
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

const TOP_K = 30
const args = process.argv.slice(2)
const topK = parseInt(args.find((a) => a.startsWith('--top='))?.split('=')[1] ?? String(TOP_K))

// 기본 키워드 — 추후 jimscanner_trends_keywords 에서 동적 로드 가능.
// 우선은 빌드를 막지 않고 실행 가능한 기본 시드로 시작.
const DEFAULT_KEYWORDS = [
  { kind: 'keyword', value: '식물성 멜라토닌' },
  { kind: 'keyword', value: '루테인' },
  { kind: 'keyword', value: '오메가3' },
  { kind: 'keyword', value: '프로바이오틱스' },
  { kind: 'keyword', value: '차량용 청소기' },
]

async function loadScopes() {
  // 동적 시드 로딩 시도 — 실패해도 DEFAULT 로 폴백.
  try {
    const { data } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword')
      .order('search_count', { ascending: false })
      .limit(30)
    if (Array.isArray(data) && data.length > 0) {
      return data.map((r) => ({ kind: 'keyword', value: r.keyword }))
    }
  } catch {
    // ignore
  }
  return DEFAULT_KEYWORDS
}

async function collectSerp(page, query) {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(query)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
  await page.waitForTimeout(1200)
  return await page.evaluate((topK) => {
    const out = []
    const seen = new Set()
    const items = document.querySelectorAll('li[id^="product"], [class*="ProductUnit"], li.search-product')
    let rank = 0
    for (const li of items) {
      const a = li.querySelector('a[href*="/vp/products/"]')
      if (!a) continue
      if (/sourceType=srp_product_ads/.test(a.href)) continue
      const href = a.href.split('?')[0]
      const m = href.match(/\/vp\/products\/(\d+)/)
      const productId = m ? m[1] : null
      if (!productId || seen.has(productId)) continue
      seen.add(productId)

      const txt = (li.textContent || '')
      const priceM = txt.match(/([\d,]{3,})\s*원/)
      const price = priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : null
      const reviewM = txt.match(/\((\d{1,7})\)/) // "(123)" 형태 리뷰수
      const review = reviewM ? parseInt(reviewM[1], 10) : null
      const isRocket = /로켓배송|로켓프레시|Rocket/.test(txt)
      const name = (li.querySelector('[class*="name" i], .name')?.textContent || txt.slice(0, 120))
        .trim().replace(/\s+/g, ' ').slice(0, 200)

      rank++
      out.push({
        rank,
        product_id: productId,
        product_title: name,
        price,
        review,
        is_rocket: isRocket,
        href,
      })
      if (rank >= topK) break
    }
    return out
  }, topK)
}

async function fetchSellerForProduct(page, productId) {
  try {
    await page.goto(`https://www.coupang.com/vp/products/${productId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    })
    await page.waitForTimeout(700)
    return await page.evaluate(() => {
      // 다양한 위치에서 셀러명 / vendor 추출 시도
      const sellerLink = document.querySelector('a[href*="vendor"], a[href*="sellerStore"]')
      const sellerName =
        document.querySelector('[class*="prod-sale-vendor-name" i], .prod-sale-vendor-name')?.textContent?.trim() ||
        sellerLink?.textContent?.trim() ||
        null
      const href = sellerLink?.href || ''
      const vm = href.match(/vendor(?:Id|s)?[\/=](\w+)/i) || href.match(/sellerStore\/(\w+)/i)
      return {
        seller_id: vm ? vm[1] : sellerName || null,
        seller_name: sellerName,
      }
    })
  } catch {
    return { seller_id: null, seller_name: null }
  }
}

console.log('Chrome CDP attach …')
let browser
try {
  browser = await chromium.connectOverCDP('http://localhost:9222')
} catch (e) {
  console.error('❌ Chrome CDP 연결 실패. PowerShell 에서 Chrome 띄울 것:')
  console.error('   Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\\temp\\chrome-debug-coupang"')
  console.error('   에러:', e.message)
  process.exit(1)
}
const ctx = browser.contexts()[0] ?? (await browser.newContext())
const page = await ctx.newPage()
console.log('✓ Chrome attach 성공\n')

const scopes = await loadScopes()
const today = new Date().toISOString().slice(0, 10)
console.log(`[${today}] scope ${scopes.length}건, TOP-${topK} 스냅샷 시작\n`)

let total = 0
let skipped = 0
for (const s of scopes) {
  const t0 = Date.now()
  try {
    const items = await collectSerp(page, s.value)
    if (items.length === 0) {
      skipped++
      console.log(`  · ${s.kind}/${s.value}: 결과 0건 — skip`)
      continue
    }

    // 셀러 정보는 상위 TOP-10 만 페이지 방문 (시간 비용 절감)
    const rowsToInsert = []
    for (const it of items) {
      let seller = { seller_id: null, seller_name: null }
      if (it.rank <= 10) {
        seller = await fetchSellerForProduct(page, it.product_id)
        await page.waitForTimeout(800 + Math.random() * 600)
      }
      rowsToInsert.push({
        snapshot_date: today,
        scope_kind: s.kind,
        scope_value: s.value,
        seller_id: seller.seller_id ?? `product:${it.product_id}`,
        seller_name: seller.seller_name,
        product_id: it.product_id,
        product_title: it.product_title,
        rank_position: it.rank,
        top_k: topK,
        price_krw: it.price,
        review_count: it.review,
        is_rocket: it.is_rocket,
        is_pb: false,
        raw_payload: { href: it.href },
      })
    }

    // 멱등 upsert — UNIQUE(snapshot_date, scope_kind, scope_value, seller_id, rank_position)
    const { error } = await sb
      .from('jimscanner_serp_seller_snapshots')
      .upsert(rowsToInsert, {
        onConflict: 'snapshot_date,scope_kind,scope_value,seller_id,rank_position',
      })

    if (error) {
      console.log(`  ✗ ${s.kind}/${s.value}: upsert 실패 — ${error.message}`)
    } else {
      total += rowsToInsert.length
      console.log(`  ✓ ${s.kind}/${s.value}: ${rowsToInsert.length}건 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    }
  } catch (e) {
    console.log(`  ✗ ${s.kind}/${s.value}: ${e.message?.slice(0, 100)}`)
  }
  await page.waitForTimeout(1200 + Math.random() * 1200)
}

console.log(`\n스냅샷 적재 완료: ${total}건 (skipped ${skipped})`)
console.log('→ refresh_seller_velocity + compute_openness_index 호출')

try {
  const r1 = await sb.rpc('jimscanner_refresh_seller_velocity', { p_date: today })
  console.log('  refresh_seller_velocity:', r1.error?.message ?? `${r1.data} 신규`)
} catch (e) {
  console.log('  refresh_seller_velocity 실패:', e.message)
}
try {
  const r2 = await sb.rpc('jimscanner_compute_openness_index', { p_date: today })
  console.log('  compute_openness_index:', r2.error?.message ?? `${(r2.data ?? []).length} scope 갱신`)
} catch (e) {
  console.log('  compute_openness_index 실패:', e.message)
}

await page.close()
console.log('=== seller-rank-snapshot 완료 ===')
