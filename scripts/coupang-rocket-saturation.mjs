/**
 * 쿠팡 SERP 1페이지(상위 36개) 로켓배송 점유율 게이트 수집기
 * — Chrome CDP attach 방식 (coupang-market-prices-cdp.mjs 와 동일 패턴)
 *
 * 결과: supabase.jimscanner_rocket_saturation 에 keyword 단위로 row 삽입.
 *   rocket_share: 로켓·로켓프레시·로켓직구 통합 비율
 *   zone:        green(<40%) / yellow(40-70%) / red(>70%) — DB GENERATED
 *
 * 사용 절차:
 *   1) PowerShell:
 *      Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\temp\chrome-debug-coupang"
 *   2) 새로 뜬 Chrome 창은 그대로 두기 (닫지 말 것)
 *   3) node --env-file=.env.local scripts/coupang-rocket-saturation.mjs
 *
 * 옵션:
 *   --keywords=a,b,c  : 직접 키워드 지정 (콤마)
 *   --from-ggsan      : ggsan cate_label 기반 자동 시드 (기본)
 *   --limit=N         : 최대 N개 키워드 (기본 25)
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
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const args = process.argv.slice(2)
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '25')
const kwArg = args.find((a) => a.startsWith('--keywords='))?.split('=')[1]
const explicitKeywords = kwArg ? kwArg.split(',').map((s) => s.trim()).filter(Boolean) : null

// 쿠팡 PB 브랜드 (로켓 점유 안에서 자체브랜드 비율 분리용)
const PB_BRANDS = ['곰곰', '탐사', '코멧', 'CAFEELA', '카페일라', '마케마케', '코끼리리브가']

async function buildSeeds() {
  if (explicitKeywords) {
    return explicitKeywords.map((k) => ({ keyword: k, category: null }))
  }
  // ggsan 카테고리별 대표 키워드: cate_label 자체를 검색어로 사용 + 최근 등록 상위 상품 title
  const { data: cats } = await sb
    .from('jimscanner_ggsan_products')
    .select('cate_label, title')
    .not('cate_label', 'is', null)
    .eq('status', 'active')
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  const seeds = new Map()
  for (const r of cats ?? []) {
    if (!r.cate_label) continue
    if (!seeds.has(r.cate_label)) {
      seeds.set(r.cate_label, { keyword: r.cate_label, category: r.cate_label })
    }
  }
  // 부족하면 title 첫 토큰도 추가
  if (seeds.size < limit) {
    for (const r of cats ?? []) {
      if (seeds.size >= limit) break
      const tok = (r.title || '').split(/\s+/)[0]
      if (tok && tok.length >= 2 && !seeds.has(tok)) {
        seeds.set(tok, { keyword: tok, category: r.cate_label })
      }
    }
  }
  return [...seeds.values()].slice(0, limit)
}

console.log('Chrome CDP (localhost:9222) attach …')
let browser
try {
  browser = await chromium.connectOverCDP('http://localhost:9222')
} catch (e) {
  console.error('❌ Chrome CDP 연결 실패. PowerShell:')
  console.error('   Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\\temp\\chrome-debug-coupang"')
  console.error('   에러:', e.message)
  process.exit(1)
}
const ctx = browser.contexts()[0] ?? await browser.newContext()
const page = await ctx.newPage()
console.log('✓ attach 성공\n')

async function sampleSerp(query) {
  const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(query)}&listSize=36&page=1`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1200)
  return await page.evaluate(({ PB_BRANDS }) => {
    const items = []
    const lis = document.querySelectorAll('li[class*="ProductUnit"], ul#productList > li, li.search-product')
    for (const li of lis) {
      const a = li.querySelector('a[href*="/vp/products/"]')
      if (!a) continue
      if (/sourceType=srp_product_ads/.test(a.href)) continue  // 광고 제외
      const text = (li.textContent || '').replace(/\s+/g, ' ')
      const html = (li.innerHTML || '')
      // 로켓 배지 감지 — img alt / class / 텍스트 / data 속성 종합
      const hasRocket =
        /로켓배송|RocketDelivery|class="[^"]*rocket[^"]*"/i.test(html) ||
        /로켓배송/.test(text)
      const hasRocketFresh = /로켓프레시|RocketFresh|rocket-fresh/i.test(html) || /로켓프레시/.test(text)
      const hasJet = /로켓직구|로켓\s*직구|RocketGlobal|rocket-jet/i.test(html) || /로켓직구/.test(text)
      const isRocketAny = hasRocket || hasRocketFresh || hasJet
      const name = (li.querySelector('[class*="name" i], .name, .descriptions')?.textContent || text.slice(0, 100))
        .trim().replace(/\s+/g, ' ').slice(0, 120)
      const isPb = isRocketAny && PB_BRANDS.some((b) => name.includes(b))
      items.push({
        name,
        href: a.href.split('?')[0],
        is_rocket: hasRocket,
        is_rocket_fresh: hasRocketFresh,
        is_jet: hasJet,
        is_rocket_any: isRocketAny,
        is_pb: isPb,
      })
      if (items.length >= 36) break
    }
    return items
  }, { PB_BRANDS })
}

const seeds = await buildSeeds()
console.log(`샘플링 대상: ${seeds.length}개 키워드\n`)

const t0 = Date.now()
let ok = 0, errors = 0, noData = 0
for (let i = 0; i < seeds.length; i++) {
  const { keyword, category } = seeds[i]
  const idx = `[${i + 1}/${seeds.length}]`
  try {
    const items = await sampleSerp(keyword)
    const total = items.length
    if (total === 0) {
      noData++
      console.log(`${idx} ⏭ "${keyword}" — no SERP items`)
      await page.waitForTimeout(1500 + Math.random() * 1500)
      continue
    }
    const rocket_count = items.filter((x) => x.is_rocket && !x.is_rocket_fresh && !x.is_jet).length
    const rocket_fresh_count = items.filter((x) => x.is_rocket_fresh).length
    const jet_count = items.filter((x) => x.is_jet).length
    const rocket_any = items.filter((x) => x.is_rocket_any).length
    const pb_count = items.filter((x) => x.is_pb).length
    const rocket_share = +(rocket_any / total).toFixed(4)
    const rocket_fresh_share = +(rocket_fresh_count / total).toFixed(4)
    const jet_share = +(jet_count / total).toFixed(4)
    const pb_in_rocket_share = rocket_any > 0 ? +(pb_count / rocket_any).toFixed(4) : 0

    const { error } = await sb.from('jimscanner_rocket_saturation').insert({
      category,
      keyword,
      rocket_share,
      rocket_fresh_share,
      jet_share,
      pb_in_rocket_share,
      total_listings: total,
      rocket_count,
      rocket_fresh_count,
      jet_count,
      pb_count,
      raw_payload: { sample: items.slice(0, 12), collected_at: new Date().toISOString() },
    })
    if (error) {
      errors++
      console.log(`${idx} ✗ "${keyword}" insert ERROR: ${error.message}`)
    } else {
      ok++
      const zone = rocket_share < 0.4 ? 'GREEN' : rocket_share < 0.7 ? 'YELLOW' : 'RED'
      console.log(`${idx} ✓ "${keyword}" total=${total} rocket=${(rocket_share * 100).toFixed(1)}% (fresh=${(rocket_fresh_share * 100).toFixed(0)}% jet=${(jet_share * 100).toFixed(0)}% pb=${(pb_in_rocket_share * 100).toFixed(0)}%) [${zone}]`)
    }
  } catch (e) {
    errors++
    console.log(`${idx} ✗ "${keyword}" ERROR: ${e.message.slice(0, 100)}`)
  }
  await page.waitForTimeout(1800 + Math.random() * 1500)
}

await page.close()
console.log(`\n=== 완료 (${((Date.now() - t0) / 1000).toFixed(1)}초) ===  OK: ${ok}, no_data: ${noData}, errors: ${errors}`)
