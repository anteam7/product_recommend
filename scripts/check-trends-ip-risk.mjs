#!/usr/bin/env node
/**
 * 상표권/병행수입 IP 리스크 스캐너 (PR-4.6, 2026-05-19).
 *
 * 각 trend product 별로 휴리스틱 시그널을 결합해 risk_score 0~100 부여:
 *   1) Naver 브랜드스토어/스마트스토어 공식 인증 마크 (alias source / title 패턴)
 *   2) SERP/alias 상위 셀러명에 '공식'·'정품인증'·'한국지사'·'코리아' 등 패턴
 *   3) ggsan 도매가 ↔ alias SERP 시장가 평균 비율 (>=3x 이면 병행수입 의심)
 *   4) (옵션) KIPRIS API — 미구현, 추후 보강
 *
 * 결과는 jimscanner_trends_ip_risk 테이블에 UPSERT.
 *
 * 호출:
 *   node --env-file=.env.local scripts/check-trends-ip-risk.mjs
 *   node --env-file=.env.local scripts/check-trends-ip-risk.mjs --limit=50
 *
 * scripts/run-crons.mjs 가 classify-trends-llm 직후 단계로 spawn 한다.
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

const args = process.argv.slice(2)
const limitArg = args.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) || 500 : 500
const PARALLEL_RATIO_THRESHOLD = 3.0

// 공식 채널/정품 패턴 (한국어).
const OFFICIAL_PATTERNS = [
  '공식',
  '정품인증',
  '정품',
  '한국지사',
  '코리아',
  'korea',
  '본사',
  '공식몰',
  '공식판매처',
  '브랜드스토어',
  '스마트스토어공식',
]

// alias source 가 브랜드스토어/공식몰이면 정식 채널 존재 가정.
const BRAND_STORE_SOURCES = new Set([
  'naver_brand_store',
  'naver_smartstore_official',
  'brand_store',
])

function detectOfficialTerms(text) {
  if (!text) return []
  const lower = String(text).toLowerCase()
  const hits = []
  for (const p of OFFICIAL_PATTERNS) {
    if (lower.includes(p.toLowerCase())) hits.push(p)
  }
  return hits
}

// 환율 보정 없이 KRW 만 사용. ggsan = KRW. supplier 가 CNY 면 잘못된 ratio 가 나와서 제외.
async function fetchSerpAvgPriceKrw(productId, brand) {
  // 1) trends_aliases 에서 naver_shopping 류 source 의 가격은 없으므로,
  //    대신 trends_supplier 의 KRW 항목 평균을 SERP 대용으로 사용 (없으면 null).
  const { data } = await sb
    .from('jimscanner_trends_supplier')
    .select('price_krw, price_currency, supplier_source')
    .eq('product_id', productId)
    .not('price_krw', 'is', null)
    .limit(20)
  if (!data || data.length === 0) return { avg: null, count: 0 }
  const krw = data
    .filter((r) => r.price_currency === 'KRW' || r.price_currency == null)
    .map((r) => Number(r.price_krw))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (krw.length === 0) return { avg: null, count: 0 }
  const avg = krw.reduce((s, n) => s + n, 0) / krw.length
  return { avg, count: krw.length, brand }
}

async function fetchGgsanMinPriceForCanonical(canonicalName, brand) {
  // ggsan 카탈로그에서 canonical 또는 brand 가 title 에 포함된 최저가 매물 검색.
  if (!canonicalName) return null
  const needle = (brand && brand.length >= 2 ? brand : canonicalName).slice(0, 16)
  const { data } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, status, is_imminent')
    .ilike('title', `%${needle}%`)
    .not('price_krw', 'is', null)
    .neq('status', 'removed')
    .order('price_krw', { ascending: true })
    .limit(5)
  if (!data || data.length === 0) return null
  const valid = data.filter((r) => Number(r.price_krw) > 0)
  if (valid.length === 0) return null
  return Number(valid[0].price_krw)
}

function computeRiskScore(parts) {
  // 0~100. 각 시그널마다 가중치 합산.
  let score = 0
  const detail = {}

  // a) 공식 채널 — 25점
  if (parts.has_brand_store) {
    score += 25
    detail.brand_store = 25
  }
  // b) 공식 셀러 패턴 hits — hit 1개당 10점, 최대 30점
  const hits = Math.min(parts.official_seller_hits ?? 0, 3)
  if (hits > 0) {
    const pts = hits * 10
    score += pts
    detail.official_seller = pts
  }
  // c) 상표 등록 — 20점 (외국 권리자면 +10)
  if (parts.trademark_found) {
    score += 20
    detail.trademark = 20
    if (parts.owner_country && parts.owner_country !== 'KR') {
      score += 10
      detail.trademark_foreign = 10
    }
  }
  // d) 병행수입 의심 — 25점
  if (parts.parallel_import_suspect) {
    score += 25
    detail.parallel_import = 25
  }

  return { score: Math.min(100, Math.max(0, Math.round(score))), detail }
}

async function fetchCandidates() {
  // LLM 분류 완료된 product 우선, last_checked_at 오래된 순.
  // ip_risk 가 없는 product 는 last_checked_at = null 로 간주 → 우선 처리.
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, brand, llm_classified_at')
    .not('llm_classified_at', 'is', null)
    .order('llm_classified_at', { ascending: false })
    .limit(LIMIT)
  return products ?? []
}

async function fetchAliasesForProducts(productIds) {
  if (productIds.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, source')
    .in('product_id', productIds)
    .limit(productIds.length * 20)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    list.push(r)
    map.set(r.product_id, list)
  }
  return map
}

async function evaluateOne(product, aliases) {
  // 1) 브랜드스토어 / 정식 채널 — alias source 패턴
  const hasBrandStore = aliases.some((a) =>
    BRAND_STORE_SOURCES.has(String(a.source ?? '').toLowerCase()),
  )

  // 2) SERP top5 alias title 에서 공식 패턴 검출 (top5 = 가장 confidence 높은 5개 가정,
  //    여기선 alias 전체 union 사용해도 무방 — alias 자체가 keyword/title 단위)
  const officialTermsSet = new Set()
  let officialHits = 0
  for (const a of aliases.slice(0, 10)) {
    const hits = detectOfficialTerms(a.alias)
    if (hits.length > 0) {
      officialHits++
      for (const h of hits) officialTermsSet.add(h)
    }
  }

  // 3) ggsan 최저가 vs SERP 평균가 비율
  const ggsanMin = await fetchGgsanMinPriceForCanonical(
    product.canonical_name,
    product.brand,
  )
  const serpAgg = await fetchSerpAvgPriceKrw(product.id, product.brand)
  let priceRatio = null
  let parallelSuspect = false
  if (ggsanMin && serpAgg.avg) {
    priceRatio = serpAgg.avg / ggsanMin
    if (priceRatio >= PARALLEL_RATIO_THRESHOLD) parallelSuspect = true
  }

  // 4) 상표 등록 — KIPRIS API 미구현, 휴리스틱:
  //    brand 가 명확하고 공식 패턴이 동시에 잡히면 trademark_found=true 추정.
  //    owner_country 는 일단 null. 추후 KIPRIS 보강 시 채움.
  const trademarkFound = Boolean(product.brand) && (hasBrandStore || officialHits >= 2)
  const trademarkSource = trademarkFound ? 'heuristic' : null

  const parts = {
    has_brand_store: hasBrandStore,
    official_seller_hits: officialHits,
    trademark_found: trademarkFound,
    owner_country: null,
    parallel_import_suspect: parallelSuspect,
  }
  const { score, detail } = computeRiskScore(parts)

  return {
    product_id: product.id,
    has_brand_store: hasBrandStore,
    official_seller_terms: [...officialTermsSet],
    official_seller_hits: officialHits,
    trademark_found: trademarkFound,
    owner_country: null,
    trademark_source: trademarkSource,
    parallel_import_suspect: parallelSuspect,
    ggsan_min_price_krw: ggsanMin,
    serp_avg_price_krw: serpAgg.avg,
    price_ratio: priceRatio,
    risk_score: score,
    risk_components: detail,
    last_checked_at: new Date().toISOString(),
    check_source: 'local_heuristic',
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'check_trends_ip_risk',
      triggered_by: 'local_cli',
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

async function main() {
  const t0 = Date.now()
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] check-trends-ip-risk start (limit=${LIMIT})`)

  const products = await fetchCandidates()
  if (products.length === 0) {
    console.log('  done: 평가 대상 없음 (0 products)')
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  console.log(`  candidates: ${products.length}`)

  const aliasMap = await fetchAliasesForProducts(products.map((p) => p.id))

  const rows = []
  let highRisk = 0
  let parallel = 0
  for (const p of products) {
    try {
      const row = await evaluateOne(p, aliasMap.get(p.id) ?? [])
      rows.push(row)
      if (row.risk_score >= 60) highRisk++
      if (row.parallel_import_suspect) parallel++
    } catch (e) {
      console.error(
        `  evaluate failed (${p.id}): ${e instanceof Error ? e.message : e}`,
      )
    }
  }

  if (rows.length > 0) {
    // chunked upsert
    const CHUNK = 100
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      const { error } = await sb
        .from('jimscanner_trends_ip_risk')
        .upsert(slice, { onConflict: 'product_id' })
      if (error) {
        console.error(`  upsert chunk ${i / CHUNK} failed: ${error.message}`)
      }
    }
  }

  await logRun({
    status: 'ok',
    fetched_count: products.length,
    inserted_count: rows.length,
    duration_ms: Date.now() - t0,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${rows.length} scored, ${highRisk} high (≥60), ${parallel} parallel-suspect, ${Date.now() - t0}ms`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({
    status: 'error',
    fetched_count: 0,
    inserted_count: 0,
    duration_ms: 0,
    error_message: msg,
  })
  process.exit(1)
})
