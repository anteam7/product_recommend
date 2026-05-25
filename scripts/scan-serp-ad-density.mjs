#!/usr/bin/env node
/**
 * SERP 광고밀도 인덱스 — 네이버 쇼핑 1페이지 paid vs organic 점유율 측정.
 *
 * 큐 소스 (우선순위):
 *   1) 핀 키워드 (jimscanner_trends_pins)
 *   2) recommend RPC 가 뽑는 TV/search 매칭 top_keyword
 *   3) 최근 7일 fetched 키워드 (jimscanner_trends_keywords, 빈도 top N)
 *
 * 결과는 jimscanner_serp_density 에 1건/run/키워드 으로 append.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/scan-serp-ad-density.mjs            # 기본 큐
 *   node --env-file=.env.local scripts/scan-serp-ad-density.mjs --limit 20
 *   node --env-file=.env.local scripts/scan-serp-ad-density.mjs --keyword "수면 영양제"
 *   node --env-file=.env.local scripts/scan-serp-ad-density.mjs --dry-run
 *
 * 참고:
 *   - 네이버 검색광고 공식 API 가 없어 HTML 파싱.
 *   - User-Agent 회피 + 키워드 사이 800~1500ms jitter sleep.
 *   - 추출 실패한 키워드는 raw 만 저장하고 ad_count=0/organic_count=0 으로 적재.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const args = process.argv.slice(2)
const argv = {
  limit: 30,
  keyword: null,
  dryRun: false,
}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--limit') argv.limit = Math.max(1, parseInt(args[++i] ?? '30', 10) || 30)
  else if (a === '--keyword') argv.keyword = args[++i] ?? null
  else if (a === '--dry-run') argv.dryRun = true
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function classifyDomain(host) {
  if (!host) return 'other'
  const h = host.toLowerCase()
  if (h.includes('smartstore.naver.com') || h.includes('shopping.naver.com')) return 'marketplace'
  if (h.includes('coupang') || h.includes('11st') || h.includes('gmarket') || h.includes('auction.co.kr') || h.includes('tmon') || h.includes('wemakeprice') || h.includes('ssg.com') || h.includes('lotteon')) return 'marketplace'
  if (h.includes('blog.naver.com') || h.includes('tistory.com') || h.includes('brunch.co.kr') || h.includes('post.naver.com')) return 'blog'
  if (h.includes('cafe.naver.com') || h.includes('cafe.daum.net')) return 'blog'
  return 'brand_self'
}

/**
 * 네이버 쇼핑 SERP 1페이지를 fetch 해서 광고/자연 슬롯 카운트.
 * 셀렉터는 시즌에 따라 바뀌므로 best-effort 휴리스틱.
 */
async function probeNaverShopping(keyword) {
  const url = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}&pagingIndex=1`
  let html = ''
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        Referer: 'https://shopping.naver.com/',
      },
    })
    if (!res.ok) {
      return { error: `http_${res.status}`, ad_count: 0, organic_count: 0, raw: {} }
    }
    html = await res.text()
  } catch (e) {
    return { error: e.message ?? String(e), ad_count: 0, organic_count: 0, raw: {} }
  }

  // 광고 슬롯 휴리스틱: "광고" 라벨이 붙은 product card.
  // 네이버는 className 이 hashed 라서 텍스트 라벨로 추정.
  const adMatches = html.match(/광고<\/[a-z]+>/gi) || []
  const ad_count = Math.min(20, adMatches.length)

  // 자연 슬롯: <li class="...product_item..."> 같은 카드 카운트에서 ad 분리.
  const productItems = html.match(/class="[^"]*product_item[^"]*"/gi) || []
  const totalCards = productItems.length
  const organic_count = Math.max(0, totalCards - ad_count)

  // top3: 첫 3개 product card 중 "광고" 라벨이 같은 카드 내에 있는지 — 간단 휴리스틱.
  // class 위치 인덱스를 기준으로 슬라이스.
  let top3_ad_count = 0
  if (totalCards > 0) {
    // 첫 3개 product_item 의 시작 인덱스 잡고, 그 다음 슬롯 시작까지 사이에 "광고" 가 있는지.
    const re = /class="[^"]*product_item[^"]*"/gi
    const positions = []
    let m
    while ((m = re.exec(html)) !== null) {
      positions.push(m.index)
      if (positions.length >= 4) break
    }
    for (let i = 0; i < Math.min(3, positions.length); i++) {
      const start = positions[i]
      const end = positions[i + 1] ?? Math.min(html.length, start + 8000)
      const slice = html.slice(start, end)
      if (/광고<\/[a-z]+>/i.test(slice)) top3_ad_count++
    }
  }

  // 광고 평균가 — product card 내 첫 가격 숫자만 best-effort.
  const priceMatches = html.match(/price_num[^>]*>[\s\S]{0,40}?([0-9,]{3,})/gi) || []
  const prices = priceMatches
    .map((s) => {
      const m2 = s.match(/([0-9,]{3,})/)
      return m2 ? parseInt(m2[1].replace(/,/g, ''), 10) : NaN
    })
    .filter((n) => Number.isFinite(n) && n > 100)
  const avg_ad_price_krw = prices.length
    ? Math.round(prices.slice(0, Math.max(1, ad_count)).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(prices.length, ad_count)))
    : null

  // organic_top_domain: 첫 product_item 의 href domain best-effort.
  let organic_top_domain = null
  let organic_top_domain_kind = 'other'
  const linkMatch = html.match(/href="(https?:\/\/[^"]+)"/i)
  if (linkMatch) {
    try {
      const u = new URL(linkMatch[1])
      organic_top_domain = u.hostname
      organic_top_domain_kind = classifyDomain(u.hostname)
    } catch {}
  }

  const total = ad_count + organic_count
  const ad_density = total > 0 ? ad_count / total : null
  const top3_ad_ratio = totalCards > 0 ? top3_ad_count / 3 : null
  // 위치 가중치: top3 슬롯 2배, 그 외 1배. 분모 = 2*3 + 1*(total-3).
  let weighted_ad_density = null
  if (total > 0) {
    const top3Total = Math.min(3, total)
    const restTotal = Math.max(0, total - top3Total)
    const denom = 2 * top3Total + 1 * restTotal
    const numerator = 2 * top3_ad_count + 1 * Math.max(0, ad_count - top3_ad_count)
    weighted_ad_density = denom > 0 ? numerator / denom : null
  }

  return {
    error: null,
    ad_count,
    organic_count,
    ad_density,
    top3_ad_count,
    top3_ad_ratio,
    avg_ad_price_krw,
    organic_top_domain,
    organic_top_domain_kind,
    weighted_ad_density,
    raw: { total_cards: totalCards, sample_prices: prices.slice(0, 5) },
  }
}

async function buildQueue(limit, keywordOverride) {
  if (keywordOverride) return [keywordOverride]

  const queue = []
  const seen = new Set()
  const push = (kw) => {
    if (!kw) return
    const k = kw.trim()
    if (!k || seen.has(k)) return
    seen.add(k)
    queue.push(k)
  }

  // 1) 핀
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .order('pinned_at', { ascending: false })
    .limit(limit)
  for (const r of pins ?? []) push(r.keyword)

  // 2) 최근 7일 키워드 빈도 top N
  if (queue.length < limit) {
    const since = new Date(Date.now() - 7 * 86400_000).toISOString()
    const { data: kws } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword')
      .gte('collected_at', since)
      .limit(2000)
    const freq = new Map()
    for (const r of kws ?? []) {
      const k = (r.keyword ?? '').trim()
      if (!k) continue
      freq.set(k, (freq.get(k) ?? 0) + 1)
    }
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1])
    for (const [k] of ranked) {
      if (queue.length >= limit) break
      push(k)
    }
  }

  return queue.slice(0, limit)
}

const t0 = Date.now()
const queue = await buildQueue(argv.limit, argv.keyword)
console.log(`[${new Date().toISOString()}] scan-serp-ad-density: ${queue.length} keyword(s)`)
if (queue.length === 0) {
  console.log('  큐 비어 있음. 핀/최근 키워드 없음.')
  process.exit(0)
}

let ok = 0
let fail = 0
const rows = []
for (let i = 0; i < queue.length; i++) {
  const kw = queue[i]
  const probe = await probeNaverShopping(kw)
  const tag = probe.error ? `ERR(${probe.error})` : `ad=${probe.ad_count}/org=${probe.organic_count} d=${probe.ad_density?.toFixed(2) ?? '-'} top3=${probe.top3_ad_count}/3`
  console.log(`  [${(i + 1).toString().padStart(3)}/${queue.length}] ${kw.padEnd(28)} ${tag}`)
  if (probe.error) fail++
  else ok++

  rows.push({
    keyword: kw,
    serp_type: 'naver_shopping',
    ad_count: probe.ad_count,
    organic_count: probe.organic_count,
    ad_density: probe.ad_density,
    top3_ad_count: probe.top3_ad_count,
    top3_ad_ratio: probe.top3_ad_ratio,
    avg_ad_price_krw: probe.avg_ad_price_krw,
    organic_top_domain: probe.organic_top_domain,
    organic_top_domain_kind: probe.organic_top_domain_kind,
    weighted_ad_density: probe.weighted_ad_density,
    raw: { ...probe.raw, error: probe.error ?? null },
  })

  if (i < queue.length - 1) await sleep(800 + Math.floor(Math.random() * 700))
}

if (!argv.dryRun && rows.length > 0) {
  // chunked insert
  const chunk = 200
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const { error } = await sb.from('jimscanner_serp_density').insert(slice)
    if (error) {
      console.error(`  insert error: ${error.message}`)
      fail++
    }
  }
}

const totalMs = Date.now() - t0
console.log(
  `[${new Date().toISOString()}] done — ${ok} ok, ${fail} fail, inserted=${argv.dryRun ? 'DRY' : rows.length} in ${totalMs}ms`,
)
process.exit(fail > 0 ? 1 : 0)
