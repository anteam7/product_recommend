#!/usr/bin/env node
/**
 * Seller HHI — Naver Shopping SERP 상위 20 listing 의 판매자 집중도 산출.
 *
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (검색 API)
 *
 * 흐름:
 *   1) jimscanner_trends_products 에서 canonical_name 추출
 *      (옵션: 최근 30일 last_seen_at 만)
 *   2) 각 canonical_name 으로 Naver Shopping API 호출 → 상위 20
 *   3) mallName 으로 group by → review_count weighted share
 *      (review 0 인 listing 도 1 listing weight)
 *   4) HHI = Σ shareᵢ², top1/top3, effective seller 수 산출
 *   5) jimscanner_trends_seller_share + jimscanner_trends_seller_hhi insert
 *
 * 일 1회 실행 (cron 또는 수동).
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}
if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필요')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const MAX_PRODUCTS = Number(process.env.HHI_MAX_PRODUCTS || 50)
const SLEEP_MS = Number(process.env.HHI_SLEEP_MS || 350)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchNaverShopping(query) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=20&sort=sim`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`naver shopping ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

function computeShares(items) {
  // items: [{ mallName, productTitle, reviewCount? }]
  // Naver Shopping API 응답에는 reviewCount 가 직접 없으므로
  // weight 는 (review_proxy = 1) 로 두되, 같은 mall 의 listing 수도 합산.
  // (실제 review 데이터는 추후 크롤러 PR 에서 확장)
  // Fallback: weight = 1 per listing → share = listings_of_mall / total_listings
  const totalListings = items.length
  const mallMap = new Map() // mallName -> { count, firstRank, sumReviews }
  items.forEach((it, idx) => {
    const mall = (it.mallName || '미상').trim() || '미상'
    const reviews = Number(it.reviewCount || 0)
    let v = mallMap.get(mall)
    if (!v) {
      v = { count: 0, firstRank: idx + 1, sumReviews: 0 }
      mallMap.set(mall, v)
    }
    v.count += 1
    v.sumReviews += reviews
  })

  // review 가 모두 0 이면 listing 수 기준, 아니면 review 가중
  const totalReviews = [...mallMap.values()].reduce((s, v) => s + v.sumReviews, 0)
  const useReview = totalReviews > 0

  const shares = [...mallMap.entries()].map(([mall, v]) => ({
    seller_name: mall,
    listing_rank: v.firstRank,
    review_count: v.sumReviews,
    share_pct: useReview ? v.sumReviews / totalReviews : v.count / totalListings,
  }))
  shares.sort((a, b) => b.share_pct - a.share_pct)

  const hhi = shares.reduce((s, x) => s + x.share_pct * x.share_pct, 0)
  const top1 = shares[0]?.share_pct ?? 0
  const top3 = shares.slice(0, 3).reduce((s, x) => s + x.share_pct, 0)
  const effective = hhi > 0 ? 1 / hhi : 0

  return {
    shares,
    summary: {
      hhi,
      top1_share: top1,
      top3_share: top3,
      seller_count_effective: effective,
      total_listings: totalListings,
      top1_seller: shares[0]?.seller_name ?? null,
    },
  }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
}

async function run() {
  console.log(`[seller-hhi] start (max=${MAX_PRODUCTS})`)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: products, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, last_seen_at')
    .gte('last_seen_at', since)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_PRODUCTS)

  if (error) {
    console.error('product fetch failed:', error.message)
    process.exit(1)
  }
  const list = products || []
  console.log(`[seller-hhi] ${list.length} products`)

  const snapshot_at = new Date().toISOString()
  let ok = 0
  let skipped = 0
  let failed = 0

  for (const p of list) {
    try {
      const resp = await fetchNaverShopping(p.canonical_name)
      const items = (resp.items || []).map((it) => ({
        mallName: stripHtml(it.mallName),
        productTitle: stripHtml(it.title),
        reviewCount: 0, // open API 는 review 미제공 — 추후 크롤러 PR
      }))
      if (items.length === 0) {
        skipped += 1
        continue
      }
      const { shares, summary } = computeShares(items)

      const shareRows = shares.map((s) => ({
        product_id: p.id,
        seller_name: s.seller_name,
        share_pct: Number(s.share_pct.toFixed(6)),
        review_count: s.review_count,
        listing_rank: s.listing_rank,
        snapshot_at,
      }))
      const { error: e1 } = await sb
        .from('jimscanner_trends_seller_share')
        .insert(shareRows)
      if (e1) throw new Error(`share insert: ${e1.message}`)

      const { error: e2 } = await sb
        .from('jimscanner_trends_seller_hhi')
        .insert({
          product_id: p.id,
          hhi: Number(summary.hhi.toFixed(6)),
          top1_share: Number(summary.top1_share.toFixed(6)),
          top3_share: Number(summary.top3_share.toFixed(6)),
          seller_count_effective: Number(summary.seller_count_effective.toFixed(4)),
          total_listings: summary.total_listings,
          top1_seller: summary.top1_seller,
          snapshot_at,
        })
      if (e2) throw new Error(`hhi insert: ${e2.message}`)

      ok += 1
      console.log(
        `  ✓ ${p.canonical_name.slice(0, 30).padEnd(30)} hhi=${summary.hhi.toFixed(3)} top1=${(summary.top1_share * 100).toFixed(1)}%`,
      )
    } catch (e) {
      failed += 1
      console.warn(`  ✗ ${p.canonical_name}: ${e.message}`)
    }
    await sleep(SLEEP_MS)
  }

  console.log(`[seller-hhi] done · ok=${ok} skipped=${skipped} failed=${failed}`)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
