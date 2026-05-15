#!/usr/bin/env node
// 6대 한국 마켓플레이스 SERP 스크레이퍼 (product × channel footprint)
//
// 채널: smartstore · coupang · 11st · gmarket · auction · wemap
// 각 product 의 대표 alias(keyword) 를 검색어로 사용해 listing_count / 가격 분포 / top_seller 수집.
//
// 사용:
//   node --env-file=.env.local scripts/collect-channel-footprint.mjs
//   node --env-file=.env.local scripts/collect-channel-footprint.mjs --limit=30 --channel=coupang
//
// 주의: 외부 사이트 접근 차단 시 listing_count=0 으로 적재되며 raw_payload.error 에 사유 기록.
// Vercel cron 으로도 동작 가능하지만 봇 차단 회피를 위해 로컬 WSL 실행 권장.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락')
  process.exit(1)
}

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const LIMIT = Number(args.get('limit') ?? 50)
const ONLY_CHANNEL = args.has('channel') ? String(args.get('channel')) : null

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const CHANNELS = ['smartstore', 'coupang', '11st', 'gmarket', 'auction', 'wemap']
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function median(nums) {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function buildSerpUrl(channel, q) {
  const enc = encodeURIComponent(q)
  switch (channel) {
    case 'smartstore':
      return `https://search.shopping.naver.com/search/all?query=${enc}`
    case 'coupang':
      return `https://www.coupang.com/np/search?q=${enc}`
    case '11st':
      return `https://search.11st.co.kr/Search.tmall?kwd=${enc}`
    case 'gmarket':
      return `https://browse.gmarket.co.kr/search?keyword=${enc}`
    case 'auction':
      return `https://browse.auction.co.kr/search?keyword=${enc}`
    case 'wemap':
      return `https://search.wemakeprice.com/search?search_keyword=${enc}`
    default:
      return null
  }
}

// 채널별 휴리스틱 HTML 파서. 외부 봇 차단 / 마크업 변경 시 0 으로 떨어지지만 raw_payload 에 사유 기록.
function parseFootprint(channel, html) {
  if (!html || html.length < 500) return { listing_count: 0, prices: [], top_seller: null }
  const prices = []
  // 가격 후보: "1,234,000원" / "1234000원" / data-price="12345"
  const priceMatches = html.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*원/g) ?? []
  for (const m of priceMatches.slice(0, 50)) {
    const n = Number(m.replace(/[^0-9]/g, ''))
    if (n >= 500 && n <= 5_000_000) prices.push(n)
  }
  let listing_count = 0
  // 채널별 listing count 휴리스틱
  switch (channel) {
    case 'smartstore': {
      const m = html.match(/전체\s*([0-9,]+)\s*개/) ?? html.match(/totalCount[^0-9]+([0-9,]+)/)
      if (m) listing_count = Number(m[1].replace(/,/g, ''))
      break
    }
    case 'coupang': {
      const m = html.match(/검색결과\s*([0-9,]+)/) ?? html.match(/total[^0-9]+([0-9,]+)/i)
      if (m) listing_count = Number(m[1].replace(/,/g, ''))
      break
    }
    case '11st': {
      const m = html.match(/총\s*<strong[^>]*>\s*([0-9,]+)/) ?? html.match(/총\s*([0-9,]+)\s*개/)
      if (m) listing_count = Number(m[1].replace(/,/g, ''))
      break
    }
    case 'gmarket':
    case 'auction': {
      const m = html.match(/총\s*([0-9,]+)\s*개/) ?? html.match(/data-montelena-totalcount="([0-9]+)"/)
      if (m) listing_count = Number(m[1].replace(/,/g, ''))
      break
    }
    case 'wemap': {
      const m = html.match(/total[":\s]+([0-9,]+)/i) ?? html.match(/([0-9,]+)\s*개의\s*상품/)
      if (m) listing_count = Number(m[1].replace(/,/g, ''))
      break
    }
  }
  // 가격 개수가 listing_count 의 floor (페이지에 보이는 수) — listing 못 잡으면 prices 길이로 대체
  if (!listing_count && prices.length) listing_count = prices.length
  // 셀러/스토어 휴리스틱 (첫 번째로 등장하는 store 명)
  let top_seller = null
  const sellerMatch =
    html.match(/data-shop-name="([^"]{1,40})"/) ??
    html.match(/seller_name[^>]*>([^<]{1,40})</) ??
    html.match(/판매자\s*[:：]?\s*([^\s<]{1,30})/)
  if (sellerMatch) top_seller = sellerMatch[1].trim()
  return { listing_count, prices, top_seller }
}

async function fetchSerp(channel, query) {
  const url = buildSerpUrl(channel, query)
  if (!url) return { error: 'no_url' }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5',
        Accept: 'text/html,application/xhtml+xml',
      },
      // 일부 채널은 5s 안에 응답 — 봇 차단 시 redirect 또는 403
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return { error: `http_${res.status}`, url }
    const html = await res.text()
    return { html, url }
  } catch (e) {
    return { error: String(e?.message ?? e), url }
  }
}

async function pickRepresentativeAlias(productId) {
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, alias_type, confidence')
    .eq('product_id', productId)
    .order('confidence', { ascending: false })
    .limit(5)
  if (!data || data.length === 0) return null
  // keyword 우선, 없으면 첫 번째
  const kw = data.find((a) => a.alias_type === 'keyword')
  return (kw ?? data[0]).alias
}

async function main() {
  // 최신 final_score TOP-N 후보 product 만 (재계산 비용 절약)
  const { data: scoreRows, error: scoreErr } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(LIMIT * 10)
  if (scoreErr) {
    console.error('scores fetch error:', scoreErr.message)
    process.exit(1)
  }
  const seen = new Set()
  const targets = []
  for (const r of scoreRows ?? []) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    targets.push(r)
    if (targets.length >= LIMIT) break
  }
  console.log(`대상 product: ${targets.length}건 (limit=${LIMIT})`)

  const channels = ONLY_CHANNEL ? [ONLY_CHANNEL] : CHANNELS
  let inserted = 0
  let errors = 0

  for (const t of targets) {
    const alias = await pickRepresentativeAlias(t.product_id)
    if (!alias) {
      console.log(`  ${t.product_id}: alias 없음 → 스킵`)
      continue
    }
    for (const ch of channels) {
      const { html, error, url } = await fetchSerp(ch, alias)
      const parsed = error
        ? { listing_count: 0, prices: [], top_seller: null }
        : parseFootprint(ch, html ?? '')
      const prices = parsed.prices
      const row = {
        product_id: t.product_id,
        channel: ch,
        search_query: alias,
        listing_count: parsed.listing_count,
        min_price: prices.length ? Math.min(...prices) : null,
        median_price: median(prices),
        max_price: prices.length ? Math.max(...prices) : null,
        top_seller: parsed.top_seller,
        raw_payload: {
          url,
          error: error ?? null,
          price_sample_n: prices.length,
          html_len: html?.length ?? 0,
        },
      }
      const { error: insErr } = await sb.from('jimscanner_trends_channel_footprint').insert(row)
      if (insErr) {
        errors++
        console.error(`  insert err [${ch}]:`, insErr.message)
      } else {
        inserted++
        console.log(
          `  ✓ ${ch.padEnd(11)} q="${alias}" → ${parsed.listing_count} listings, prices=${prices.length}`,
        )
      }
      // rate limit (봇 차단 회피)
      await new Promise((r) => setTimeout(r, 800 + Math.random() * 400))
    }
  }

  // heartbeat
  await sb.from('jimscanner_trends_heartbeat').upsert({
    id: 'main',
    heartbeat_at: new Date().toISOString(),
    last_collector: 'channel_footprint',
    last_run_status: errors === 0 ? 'ok' : 'partial',
    notes: `inserted=${inserted} errors=${errors}`,
  })

  console.log(`\n결과: inserted=${inserted} errors=${errors}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
