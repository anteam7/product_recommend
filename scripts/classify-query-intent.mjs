#!/usr/bin/env node
/**
 * 쿼리 마이크로인텐트 분해 cron — 6시간마다 (2026-05-20)
 *
 * 각 canonical product 의 alias 키워드 + 같은 카테고리의 82cook_talk·naver_blog·naver_news
 * 텍스트를 5종 마이크로 인텐트(price/compare/howto/trouble/buy_source)로 분류,
 * share + query_count 를 jimscanner_trends_query_intent 에 누적.
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-query-intent.mjs
 *
 * 환경:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * 분류 방식:
 *   현재는 한국어 키워드 사전 기반 규칙 엔진(LLM 분류 cron 비용 0).
 *   classify-trends-llm.mjs 와 같은 claude-code-cli 패턴으로 확장 가능.
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

const BUCKETS = ['price', 'compare', 'howto', 'trouble', 'buy_source']

// 한국어 키워드 사전. 최소 1개 매칭하면 해당 버킷에 1표.
// 우선순위: trouble > buy_source > price > compare > howto (specific → general)
const KEYWORDS = {
  trouble: [
    '부작용', '고장', '문제', '환불', '교환', '불량', '안 됨', '안돼',
    '오류', '에러', '망함', '실패', '안 되', '버그',
  ],
  buy_source: [
    '어디서', '구매처', '직구', '정품', '공식', '판매처', '어디 사', '어디 살',
    '어디에서', '어디서 사', '어디 파', '정품 확인', '병행', '가품',
  ],
  price: [
    '싸게', '최저가', '할인', '쿠폰', '특가', '저렴', '가격', '얼마',
    '세일', '핫딜', '딜', '프로모션',
  ],
  compare: [
    '비교', '추천', 'vs', '어떤', '뭐가', '뭐 좋', '어느 게', '차이',
    '대신', '대체', '대안', '랭킹', '순위', 'best',
  ],
  howto: [
    '사용법', '후기', '효과', '품질', '어떻게', '방법', '리뷰', '느낌',
    '써본', '먹어본', '체험', '경험', '느낌', '괜찮', '좋은가', '쓰는법',
  ],
}

function classifyText(text) {
  if (!text) return null
  const t = text.toLowerCase()
  // 우선순위 순서대로 검사
  for (const bucket of ['trouble', 'buy_source', 'price', 'compare', 'howto']) {
    for (const kw of KEYWORDS[bucket]) {
      if (t.includes(kw.toLowerCase())) return bucket
    }
  }
  return null
}

async function fetchProducts() {
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .not('llm_classified_at', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(500)
  return data ?? []
}

async function fetchAliases(productIds) {
  if (productIds.length === 0) return new Map()
  const map = new Map()
  // chunk to avoid IN length blow-up
  const chunkSize = 100
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize)
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias')
      .in('product_id', chunk)
    for (const r of data ?? []) {
      const list = map.get(r.product_id) ?? []
      list.push(r.alias)
      map.set(r.product_id, list)
    }
  }
  return map
}

// 같은 카테고리의 텍스트성 소스 (82cook_talk, naver_blog, naver_news) keyword 모음
async function fetchCategoryTexts() {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const map = new Map() // category_top → [keyword]
  const sources = ['82cook_talk', 'naver_blog', 'naver_news']
  for (const src of sources) {
    const { data } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top')
      .eq('source', src)
      .gte('collected_at', since)
      .limit(5000)
    for (const r of data ?? []) {
      const top = r.category_top ?? 'other'
      const list = map.get(top) ?? []
      list.push(r.keyword)
      map.set(top, list)
    }
  }
  return map
}

async function applyResults(rows) {
  if (rows.length === 0) return
  // chunk insert
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const { error } = await sb.from('jimscanner_trends_query_intent').insert(chunk)
    if (error) {
      console.error(`  insert error: ${error.message}`)
    }
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'classify_query_intent',
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
  const computedAt = new Date().toISOString()
  console.log(`[${computedAt}] classify-query-intent start`)

  const products = await fetchProducts()
  if (products.length === 0) {
    console.log('  done: 분류 대상 product 없음')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }
  console.log(`  products: ${products.length}`)

  const aliasMap = await fetchAliases(products.map((p) => p.id))
  const categoryTexts = await fetchCategoryTexts()
  console.log(
    `  alias rows: ${[...aliasMap.values()].reduce((n, l) => n + l.length, 0)}, ` +
      `category texts: ${[...categoryTexts.values()].reduce((n, l) => n + l.length, 0)}`,
  )

  const insertRows = []
  let withSignal = 0

  for (const p of products) {
    const aliases = aliasMap.get(p.id) ?? []
    const catTexts = categoryTexts.get(p.category_top) ?? []

    // 같은 카테고리 텍스트 중 alias 와 토큰 1개라도 겹치는 것만 — 정확도용
    const aliasTokens = new Set(
      aliases
        .flatMap((a) => a.split(/[\s,.()\-_/]+/))
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length >= 2),
    )

    const matchingTexts = catTexts.filter((kw) => {
      const lk = kw.toLowerCase()
      for (const tok of aliasTokens) {
        if (lk.includes(tok)) return true
      }
      return false
    })

    const corpus = [...aliases, ...matchingTexts]
    if (corpus.length === 0) continue

    const counts = { price: 0, compare: 0, howto: 0, trouble: 0, buy_source: 0 }
    let classifiedTotal = 0
    for (const text of corpus) {
      const b = classifyText(text)
      if (b) {
        counts[b]++
        classifiedTotal++
      }
    }
    if (classifiedTotal === 0) continue
    withSignal++

    for (const bucket of BUCKETS) {
      const share = counts[bucket] / classifiedTotal
      insertRows.push({
        product_id: p.id,
        intent_bucket: bucket,
        share: Number(share.toFixed(4)),
        query_count: counts[bucket],
        computed_at: computedAt,
      })
    }
  }

  console.log(`  products with intent signal: ${withSignal}, insert rows: ${insertRows.length}`)
  await applyResults(insertRows)

  await logRun({
    status: 'ok',
    fetched_count: products.length,
    inserted_count: insertRows.length,
    duration_ms: Date.now() - t0,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${withSignal} products classified, ${insertRows.length} rows, ${Date.now() - t0}ms`,
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
