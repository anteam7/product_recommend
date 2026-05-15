#!/usr/bin/env node
/**
 * score-entry-difficulty — 진입난이도 매트릭스 산출 (일 1회)
 *
 * 각 canonical product 마다:
 *   - ad_cpc_est:    네이버 SearchAd 입찰가 + SERP 광고슬롯 점유율로 추정 CPC
 *   - ad_difficulty: ad_cpc_est 정규화 (0~100, 2000원/click = 100)
 *   - seo_barrier:   top-10 스마트스토어 SERP 평균 리뷰수·광고리스팅 비율 가중
 *   - organic_runway: market_raw(google_suggest, naver_blog) 롱테일 키워드 커버리지 합산
 *
 * 외부 API 키가 없는 환경(현 단계)에선 alias/market_raw 의 누적 시그널만으로
 * 휴리스틱 추정. 외부 광고비 데이터가 들어오면 ad_cpc_est 만 교체 가능하도록 설계.
 *
 * 사용:
 *   node --env-file=.env.local scripts/score-entry-difficulty.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const CPC_MAX_KRW = 2000        // 진입 불가 기준선
const CPC_PER_ALIAS = 80        // alias 1개당 +80원 (수요 proxy)
const CPC_PER_COMPETITION = 18  // competition_score 1점 당 +18원

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

async function loadProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  return data ?? []
}

async function loadLatestScores(productIds) {
  if (productIds.length === 0) return new Map()
  // 최근 7일 안의 가장 최근 score 만 가져옴
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at')
    .in('product_id', productIds)
    .gte('computed_at', since)
    .order('computed_at', { ascending: false })
  if (error) throw error
  const map = new Map()
  for (const r of data ?? []) {
    if (!map.has(r.product_id)) map.set(r.product_id, r)
  }
  return map
}

async function loadAliases(productIds) {
  if (productIds.length === 0) return new Map()
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('product_id', productIds)
  if (error) throw error
  const map = new Map()
  for (const r of data ?? []) {
    let arr = map.get(r.product_id)
    if (!arr) { arr = []; map.set(r.product_id, arr) }
    arr.push(String(r.alias ?? ''))
  }
  return map
}

async function loadMarketCoverage(aliasesByProduct) {
  // market_raw (google_suggest + naver_blog) 의 query/title 안에서 alias 가 몇 번 나오는지 카운트.
  // 30일 window.
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('source, query, title')
    .in('source', ['google_suggest', 'naver_blog'])
    .gte('captured_at', since)
    .limit(20000)
  if (error) {
    console.error('  market_raw load failed:', error.message)
    return new Map()
  }
  const rows = data ?? []

  // alias → product_id 역인덱스
  const aliasToProduct = new Map()
  for (const [pid, list] of aliasesByProduct) {
    for (const a of list) {
      const k = a.toLowerCase()
      if (k && !aliasToProduct.has(k)) aliasToProduct.set(k, pid)
    }
  }

  const coverage = new Map() // product_id -> { suggestHits, blogHits, longtailKeywords:Set }
  for (const r of rows) {
    const text = `${r.query ?? ''} ${r.title ?? ''}`.toLowerCase()
    if (!text.trim()) continue
    for (const [alias, pid] of aliasToProduct) {
      if (alias.length < 2) continue
      if (text.includes(alias)) {
        let c = coverage.get(pid)
        if (!c) { c = { suggestHits: 0, blogHits: 0, longtail: new Set() }; coverage.set(pid, c) }
        if (r.source === 'google_suggest') c.suggestHits++
        else if (r.source === 'naver_blog') c.blogHits++
        // 롱테일: alias 외 추가 단어가 붙은 경우 (스페이스 포함)
        const trimmed = text.trim()
        if (trimmed !== alias && trimmed.length > alias.length + 1) c.longtail.add(trimmed.slice(0, 80))
      }
    }
  }
  return coverage
}

function estimateAdCpc({ aliasCount, competitionScore }) {
  // 광고 단가 휴리스틱:
  //   alias_count 가 많을수록 수요 多 → 광고 입찰 경쟁 ↑
  //   competition_score 는 SERP 밀도 (높을수록 경쟁 약함) → 역상관
  //
  // CPC_KRW ≈ base 200 + alias*CPC_PER_ALIAS + (100-competition)*CPC_PER_COMPETITION
  const base = 200
  const comp = clamp(competitionScore ?? 50, 0, 100)
  const cpc = base + (aliasCount ?? 0) * CPC_PER_ALIAS + (100 - comp) * CPC_PER_COMPETITION
  return Math.round(cpc)
}

function adDifficultyFromCpc(cpc) {
  // 0원 = 0점, 2000원 이상 = 100점. 로그 스케일.
  if (cpc <= 0) return 0
  const ratio = clamp(cpc / CPC_MAX_KRW, 0, 1)
  return Math.round(ratio * 100)
}

function seoBarrierFromSignals({ commerceScore, supplierScore, aliasCount }) {
  // SERP 깊이 proxy: commerce_score (네이버쇼핑 TOP 노출) + supplier (도매가 있으면 셀러 많음)
  // alias_count 가 크면 키워드가 일반화 → 진입 어렵.
  const c = clamp(commerceScore ?? 30, 0, 100)
  const s = clamp(supplierScore ?? 30, 0, 100)
  const aliasFactor = clamp((aliasCount ?? 0) * 4, 0, 60)
  const score = c * 0.4 + s * 0.3 + aliasFactor * 0.3
  return Math.round(clamp(score, 0, 100))
}

function organicRunwayScore(cov, trendScore) {
  if (!cov) {
    // 트렌드 약간이라도 있으면 약한 runway 부여 (탐험가능 신호)
    return Math.round(clamp((trendScore ?? 0) * 0.15, 0, 15))
  }
  const longtail = cov.longtail.size
  const total = cov.suggestHits + cov.blogHits
  // 0 ~ 100 으로 압축. longtail 30개 + total 50건이면 만점 근처.
  const longtailScore = clamp(longtail * 2.5, 0, 60)
  const volumeScore = clamp(total * 1.2, 0, 40)
  return Math.round(clamp(longtailScore + volumeScore, 0, 100))
}

async function upsertDifficulty(rows) {
  if (rows.length === 0) return 0
  let inserted = 0
  // 100개씩 batch insert
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const { error } = await sb.from('jimscanner_trends_entry_difficulty').insert(chunk)
    if (error) {
      console.error('  insert error:', error.message)
      continue
    }
    inserted += chunk.length
  }
  return inserted
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] score-entry-difficulty start`)

  const products = await loadProducts()
  if (products.length === 0) {
    console.log('  no products to score.')
    return
  }
  const ids = products.map((p) => p.id)
  const [scores, aliases] = await Promise.all([
    loadLatestScores(ids),
    loadAliases(ids),
  ])
  const coverage = await loadMarketCoverage(aliases)

  const rows = []
  for (const p of products) {
    const s = scores.get(p.id)
    const cpc = estimateAdCpc({
      aliasCount: p.alias_count ?? 0,
      competitionScore: s?.competition_score,
    })
    const ad_difficulty = adDifficultyFromCpc(cpc)
    const seo_barrier = seoBarrierFromSignals({
      commerceScore: s?.commerce_score,
      supplierScore: s?.supplier_score,
      aliasCount: p.alias_count ?? 0,
    })
    const cov = coverage.get(p.id)
    const organic_runway = organicRunwayScore(cov, s?.trend_score)

    rows.push({
      product_id: p.id,
      ad_cpc_est: cpc,
      ad_difficulty,
      seo_barrier,
      organic_runway,
      components: {
        ad: {
          method: 'heuristic_v1',
          alias_count: p.alias_count ?? 0,
          competition_score: s?.competition_score ?? null,
        },
        seo: {
          commerce_score: s?.commerce_score ?? null,
          supplier_score: s?.supplier_score ?? null,
          alias_factor: clamp((p.alias_count ?? 0) * 4, 0, 60),
        },
        runway: {
          suggest_hits: cov?.suggestHits ?? 0,
          blog_hits: cov?.blogHits ?? 0,
          longtail_count: cov?.longtail?.size ?? 0,
          window_days: 30,
        },
      },
    })
  }

  const inserted = await upsertDifficulty(rows)
  console.log(
    `[${new Date().toISOString()}] done — scored ${rows.length} products, inserted ${inserted} rows in ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error('score-entry-difficulty failed:', e?.message ?? e)
  process.exit(1)
})
