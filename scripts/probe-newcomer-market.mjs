#!/usr/bin/env node
/**
 * ggsan 신규 입고 정찰병 — 시장 probe cron
 *
 * 매일 KST 02:30 (ggsan 동기화 30분 후) 또는 수동 실행.
 *
 * 동작:
 *   1) SQL 함수 jimscanner_enqueue_ggsan_newcomers() 호출
 *      → price_history 1건만 가진 신규 row 를 newcomer_scores 에 INSERT.
 *   2) probe_status='pending' row 를 N개 가져와
 *      네이버 쇼핑 API (NAVER_OPENAPI_CLIENT_ID/_SECRET) 로 시장가 측정.
 *   3) 동일 cate_cd 의 기존 ggsan 가격 분포로 category z-score.
 *   4) 마진율/포화도/종합 score 계산 후 UPDATE.
 *
 * ENV:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   NAVER_OPENAPI_CLIENT_ID, NAVER_OPENAPI_CLIENT_SECRET  (옵션 — 없으면 시장 미발견 처리)
 *   PROBE_BATCH_SIZE (default: 50)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const NAVER_ID = process.env.NAVER_OPENAPI_CLIENT_ID
const NAVER_SECRET = process.env.NAVER_OPENAPI_CLIENT_SECRET
const BATCH_SIZE = parseInt(process.env.PROBE_BATCH_SIZE ?? '50', 10)

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function buildQuery(title) {
  // 검색 정확도 ↑: 과도한 토큰 제거, 첫 5단어 + 브랜드 가능성 있는 영문/한글 묶음만.
  const cleaned = title
    .replace(/[\[\]\(\)\{\}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = cleaned.split(' ').slice(0, 5)
  return words.join(' ')
}

async function fetchNaverShopping(query) {
  if (!NAVER_ID || !NAVER_SECRET) return null
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=20&sort=asc`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_ID,
      'X-Naver-Client-Secret': NAVER_SECRET,
    },
  })
  if (!res.ok) {
    throw new Error(`naver ${res.status}`)
  }
  const json = await res.json()
  const items = Array.isArray(json.items) ? json.items : []
  if (items.length === 0) return { items: [] }
  return { items }
}

function computeMarketStats(items) {
  const prices = items
    .map((it) => parseInt(it.lprice ?? '0', 10))
    .filter((n) => n > 0)
  if (prices.length === 0) {
    return { min: null, median: null, sellerCount: 0, reviewCount: 0 }
  }
  const sorted = [...prices].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const min = sorted[0]
  const mallSet = new Set(items.map((it) => it.mallName).filter(Boolean))
  // naver API 는 리뷰수가 없어 mallProductId 다양도로 대체. 정밀치는 다나와 SERP 보강에서.
  return {
    min,
    median,
    sellerCount: mallSet.size,
    reviewCount: 0,
  }
}

async function getCategoryPriceDistribution(cateCd) {
  if (!cateCd) return null
  const { data } = await sb
    .from('jimscanner_ggsan_products')
    .select('price_krw')
    .eq('cate_cd', cateCd)
    .not('price_krw', 'is', null)
    .limit(500)
  const prices = (data ?? []).map((r) => r.price_krw).filter((n) => typeof n === 'number')
  if (prices.length < 5) return null
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length
  const variance = prices.reduce((acc, p) => acc + (p - mean) ** 2, 0) / prices.length
  const std = Math.sqrt(variance)
  return { mean, std: std || 1 }
}

function computeNewcomerScore({ marginPct, saturation, zScore, hasMatch }) {
  if (!hasMatch) return 30 // 시장 미발견 = 미지의 신상, 중립값
  const marginPart = Math.max(0, Math.min(50, (marginPct ?? 0) * 0.5))
  const saturationPart = Math.max(0, 30 * (1 - (saturation ?? 0.5)))
  const zPart = Math.max(0, Math.min(20, ((zScore ?? 0) + 2) * 5))
  return Math.round(marginPart + saturationPart + zPart)
}

async function probeOne(score) {
  // 상품 정보 조인
  const { data: product } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_cd, price_krw')
    .eq('goods_no', score.goods_no)
    .maybeSingle()

  if (!product) {
    return { ok: false, status: 'error', error: 'product not found' }
  }

  const query = buildQuery(product.title)
  let stats = { min: null, median: null, sellerCount: 0, reviewCount: 0 }
  let probeStatus = 'no_match'
  let probeError = null

  try {
    const result = await fetchNaverShopping(query)
    if (result == null) {
      probeStatus = 'no_match'
      probeError = 'naver api key missing'
    } else if (result.items.length === 0) {
      probeStatus = 'no_match'
    } else {
      stats = computeMarketStats(result.items)
      probeStatus = stats.min == null ? 'no_match' : 'probed'
    }
  } catch (e) {
    probeStatus = 'error'
    probeError = String(e.message ?? e).slice(0, 500)
  }

  const wholesale = product.price_krw ?? null
  const marginPct =
    wholesale && stats.min ? ((stats.min - wholesale) / wholesale) * 100 : null
  const saturation = stats.sellerCount === 0 ? null : Math.min(1, stats.sellerCount / 20)

  const dist = await getCategoryPriceDistribution(product.cate_cd)
  const zScore =
    dist && wholesale ? (wholesale - dist.mean) / dist.std : null

  const newcomerScore = computeNewcomerScore({
    marginPct,
    saturation,
    zScore,
    hasMatch: probeStatus === 'probed',
  })

  const { error: updateErr } = await sb
    .from('jimscanner_ggsan_newcomer_scores')
    .update({
      market_min_krw: stats.min,
      market_median_krw: stats.median,
      market_seller_count: stats.sellerCount,
      market_review_count: stats.reviewCount,
      market_query: query,
      probe_status: probeStatus,
      probe_error: probeError,
      probed_at: new Date().toISOString(),
      margin_pct: marginPct,
      saturation_score: saturation,
      category_zscore: zScore,
      newcomer_score: newcomerScore,
    })
    .eq('goods_no', score.goods_no)

  if (updateErr) {
    return { ok: false, status: 'update_failed', error: updateErr.message }
  }
  return { ok: true, status: probeStatus, score: newcomerScore }
}

async function main() {
  console.log('▶ ggsan 신규 입고 정찰병 시작')

  // 1) 큐잉
  const { data: enqueueRet, error: rpcErr } = await sb.rpc('jimscanner_enqueue_ggsan_newcomers')
  if (rpcErr) {
    console.warn('큐잉 RPC 실패 (마이그레이션 미적용?):', rpcErr.message)
  } else {
    console.log(`  ✓ 큐잉: ${enqueueRet ?? 0} 신규 row`)
  }

  // 2) pending 가져오기
  const { data: pending, error: selectErr } = await sb
    .from('jimscanner_ggsan_newcomer_scores')
    .select('goods_no, probe_status, queued_at')
    .in('probe_status', ['pending', 'error'])
    .eq('dismissed', false)
    .order('queued_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (selectErr) {
    console.error('pending 조회 실패:', selectErr.message)
    process.exit(1)
  }

  console.log(`  ▶ probe 대상: ${pending?.length ?? 0}개`)

  let okCount = 0
  let failCount = 0
  for (const row of pending ?? []) {
    try {
      const r = await probeOne(row)
      if (r.ok) {
        okCount++
        console.log(`    [${row.goods_no}] ${r.status} score=${r.score ?? '?'}`)
      } else {
        failCount++
        console.log(`    [${row.goods_no}] FAIL ${r.status} ${r.error ?? ''}`)
      }
    } catch (e) {
      failCount++
      console.log(`    [${row.goods_no}] EXC ${e.message ?? e}`)
    }
    // rate limit: 네이버 OpenAPI 10 qps 한도
    await new Promise((r) => setTimeout(r, 120))
  }

  console.log(`✓ 완료 ok=${okCount} fail=${failCount}`)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
