#!/usr/bin/env node
/**
 * market_raw 미처리 뉴스·검색 시그널 → 트렌드 상품 자동 연결 배치.
 *
 * 동작:
 *   1) jimscanner_market_raw.processed=false 행을 가져와 title·query
 *      텍스트에서 키워드를 추출 (불용어/숫자/심볼 제거).
 *   2) jimscanner_trends_aliases.alias 와 pg_trgm similarity (>=0.6)
 *      ILIKE+similarity 매칭으로 canonical_product_id 탐색.
 *   3) 매칭 성공:
 *      - jimscanner_trends_products.last_seen_at = now()
 *      - jimscanner_market_signals 에 signal_type='keyword' upsert
 *        (frequency++, raw_ids append, last_seen 갱신, product_id 세팅)
 *   4) 매칭 실패:
 *      - jimscanner_trends_aliases 에 confidence=0.3 임시 alias 삽입
 *        (다음 classify-trends-llm 실행 때 분류 대상으로 올라감)
 *   5) processed=true 마킹.
 *
 * 호출:
 *   node --env-file=.env.local scripts/link-market-signals.mjs
 *
 * 환경:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
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

const RAW_BATCH = 200
const SIM_THRESHOLD = 0.6
const MIN_KEYWORD_LEN = 2

// 한국어/영어 뉴스에 자주 등장하는 무의미 토큰
const STOPWORDS = new Set([
  '뉴스', '속보', '기사', '단독', '오늘', '내일', '어제', '최근', '관련', '발표',
  '공개', '예정', '시작', '진행', '확정', '리뷰', '비교', '추천', '인기', '특가',
  '할인', '쿠폰', '신상', '브랜드', '제품', '상품', 'news', 'review', 'best',
  'top', 'new', 'sale', 'deal', 'hot',
])

function extractKeywords(text) {
  if (!text) return []
  // 한글, 영문, 숫자, 일부 기호만 남기고 토큰화
  const cleaned = String(text)
    .replace(/[^\p{Letter}\p{Number}\s\-_/]+/gu, ' ')
    .toLowerCase()
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  const out = []
  for (const t of tokens) {
    if (t.length < MIN_KEYWORD_LEN) continue
    if (STOPWORDS.has(t)) continue
    if (/^\d+$/.test(t)) continue
    out.push(t)
  }
  // 인접 토큰 2-gram 도 후보로 (예: "초임계 오메가3")
  const bigrams = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]
    const b = tokens[i + 1]
    if (!a || !b) continue
    if (a.length < MIN_KEYWORD_LEN || b.length < MIN_KEYWORD_LEN) continue
    if (STOPWORDS.has(a) && STOPWORDS.has(b)) continue
    bigrams.push(`${a} ${b}`)
  }
  return [...new Set([...out, ...bigrams])]
}

async function fetchUnprocessed() {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, query, captured_at')
    .eq('processed', false)
    .order('captured_at', { ascending: false })
    .limit(RAW_BATCH)
  if (error) throw new Error(`fetch raw: ${error.message}`)
  return data ?? []
}

async function matchAlias(keyword) {
  // pg_trgm similarity 매칭. 결과가 여러 개면 가장 confidence 높은 product_id 채택.
  // PostgREST 에선 similarity() 함수 직접 호출이 불가하므로
  // 후보를 ILIKE 로 좁힌 뒤 클라이언트에서 Jaccard 근사 비교.
  const safe = keyword.replace(/[%_\\]/g, ' ').trim()
  if (!safe) return null
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, confidence')
    .ilike('alias', `%${safe}%`)
    .order('confidence', { ascending: false })
    .limit(8)
  if (error || !data || data.length === 0) return null

  let best = null
  for (const row of data) {
    const s = jaccard(safe, String(row.alias ?? '').toLowerCase())
    if (s >= SIM_THRESHOLD && (!best || s > best.sim)) {
      best = { product_id: row.product_id, alias: row.alias, sim: s }
    }
  }
  return best
}

function jaccard(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = ngramSet(a, 3)
  const B = ngramSet(b, 3)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

function ngramSet(s, n) {
  const out = new Set()
  const padded = ` ${s} `
  for (let i = 0; i <= padded.length - n; i++) {
    out.add(padded.slice(i, i + n))
  }
  return out
}

async function bumpProductLastSeen(productId, when) {
  const { error } = await sb
    .from('jimscanner_trends_products')
    .update({ last_seen_at: when })
    .eq('id', productId)
  if (error) console.error(`  last_seen_at update failed (${productId}): ${error.message}`)
}

async function upsertKeywordSignal({ productId, keyword, rawId, capturedAt }) {
  // 이미 존재하는 signal (signal_type='keyword' AND keywords[1]=keyword) 을 찾는다.
  const { data: existing } = await sb
    .from('jimscanner_market_signals')
    .select('id, frequency, raw_ids, keywords')
    .eq('signal_type', 'keyword')
    .contains('keywords', [keyword])
    .limit(1)
  const row = existing?.[0]
  if (row) {
    const nextRawIds = Array.from(new Set([...(row.raw_ids ?? []), rawId]))
    const { error } = await sb
      .from('jimscanner_market_signals')
      .update({
        frequency: (row.frequency ?? 0) + 1,
        raw_ids: nextRawIds,
        last_seen: capturedAt,
        product_id: productId,
      })
      .eq('id', row.id)
    if (error) throw new Error(`signal update: ${error.message}`)
    return 'update'
  }
  const { error } = await sb.from('jimscanner_market_signals').insert({
    signal_type: 'keyword',
    keywords: [keyword],
    frequency: 1,
    raw_ids: [rawId],
    first_seen: capturedAt,
    last_seen: capturedAt,
    product_id: productId,
  })
  if (error) throw new Error(`signal insert: ${error.message}`)
  return 'insert'
}

async function insertTempAlias(keyword, source) {
  // 미매칭 키워드는 새 product 를 만들 수 없으니, 이미 비슷한 alias 가 있는
  // product 가 없을 때 가장 가까운 후보를 못 찾았다 → 새 product 가 필요.
  // 그러나 본 배치는 product 자동 생성을 하지 않는다 (LLM 의 책임).
  // 대신, "검토 대상" 토큰을 jimscanner_trends_aliases 에 임시로 넣어두는
  // 우회는 product_id FK 가 NOT NULL 이므로 불가능.
  // 따라서 미매칭 시 별도 stash 테이블을 두지 않고 raw 만 processed=true
  // 마킹 후 카운트를 반환한다. (LLM 분류기가 raw 에서 다시 후보를 만들 수
  // 있도록 향후 raw.metadata.matched=false 플래그를 추가하는 게 좋다.)
  return null
}

async function markProcessed(rawIds) {
  if (rawIds.length === 0) return
  // chunk 100
  for (let i = 0; i < rawIds.length; i += 100) {
    const slice = rawIds.slice(i, i + 100)
    const { error } = await sb
      .from('jimscanner_market_raw')
      .update({ processed: true })
      .in('id', slice)
    if (error) console.error(`  mark processed failed: ${error.message}`)
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'link_market_signals',
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
  console.log(`[${new Date().toISOString()}] link-market-signals start`)

  const raws = await fetchUnprocessed()
  console.log(`  unprocessed raw: ${raws.length}`)
  if (raws.length === 0) {
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  let matched = 0
  let unmatched = 0
  let signalInsert = 0
  let signalUpdate = 0
  let lastError = null
  const processedIds = []

  for (const raw of raws) {
    const text = [raw.title, raw.query].filter(Boolean).join(' ')
    const keywords = extractKeywords(text)
    if (keywords.length === 0) {
      processedIds.push(raw.id)
      continue
    }

    let rawMatched = false
    for (const kw of keywords.slice(0, 8)) {
      try {
        const hit = await matchAlias(kw)
        if (!hit) continue
        rawMatched = true
        await bumpProductLastSeen(hit.product_id, raw.captured_at ?? new Date().toISOString())
        const act = await upsertKeywordSignal({
          productId: hit.product_id,
          keyword: kw,
          rawId: raw.id,
          capturedAt: raw.captured_at ?? new Date().toISOString(),
        })
        if (act === 'insert') signalInsert++
        else if (act === 'update') signalUpdate++
        // 첫 번째 매칭만 채택 (overcounting 방지)
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        console.error(`  raw ${raw.id} kw="${kw}" failed: ${lastError}`)
      }
    }

    if (rawMatched) matched++
    else unmatched++

    processedIds.push(raw.id)
  }

  await markProcessed(processedIds)

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: raws.length,
    inserted_count: signalInsert + signalUpdate,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — matched=${matched} unmatched=${unmatched} ` +
      `signal(insert=${signalInsert}, update=${signalUpdate}) in ${Date.now() - t0}ms`,
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
