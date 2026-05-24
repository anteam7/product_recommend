#!/usr/bin/env node
/**
 * Gift Modifier Margin Window — gift_share 산출 cron.
 *
 * 입력:
 *   1) jimscanner_market_raw (source IN ('naver_blog','naver_news','google_suggest'))
 *      title + metadata 의 description/snippet 문자열에서 occasion 어휘 매칭
 *   2) jimscanner_trends_products.canonical_name 도 함께 스캔
 *
 * 출력:
 *   jimscanner_gift_intent_scores 에 (keyword, gift_share, occasion_breakdown jsonb, sample_count, computed_at) insert.
 *
 * 키워드 매핑: 각 raw row 의 query 필드를 우선 키워드로 사용,
 * 없으면 title 첫 토큰 fallback. trends_products 는 canonical_name 자체가 키워드.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/compute-gift-intent.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const OCCASION_VOCAB = [
  '선물',
  '기념일',
  '집들이',
  '졸업',
  '입학',
  '어버이날',
  '발렌타인',
  '화이트데이',
  '빼빼로데이',
  '생일',
  '돌잔치',
  '웨딩',
]

const SINCE_DAYS = Number(process.env.GIFT_INTENT_SINCE_DAYS ?? '30')

function extractText(row) {
  const meta = row.metadata ?? {}
  const parts = [row.title, row.query, meta.description, meta.snippet, meta.content]
  return parts.filter(Boolean).join(' ')
}

function pickKeyword(row) {
  if (row.query && typeof row.query === 'string') return row.query.trim()
  if (row.title && typeof row.title === 'string') {
    // 첫 단어 토큰 (한글/영문/숫자 연속) 사용
    const m = row.title.match(/[\p{L}\p{N}]+/u)
    if (m) return m[0]
  }
  return null
}

async function loadRawDocs() {
  const since = new Date(Date.now() - SINCE_DAYS * 86400 * 1000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('source, query, title, metadata, captured_at')
    .in('source', ['naver_blog', 'naver_news', 'google_suggest'])
    .gte('captured_at', since)
    .limit(20000)
  if (error) throw error
  return data ?? []
}

async function loadProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('canonical_name, description, last_seen_at')
    .limit(5000)
  if (error) throw error
  return data ?? []
}

function emptyBuckets() {
  const o = {}
  for (const v of OCCASION_VOCAB) o[v] = 0
  return o
}

function bumpMatches(text, buckets) {
  let any = false
  for (const v of OCCASION_VOCAB) {
    if (text.includes(v)) {
      buckets[v] = (buckets[v] ?? 0) + 1
      any = true
    }
  }
  return any
}

async function main() {
  console.log(`[gift-intent] window=${SINCE_DAYS}d`)
  const [raw, products] = await Promise.all([loadRawDocs(), loadProducts()])
  console.log(`[gift-intent] raw=${raw.length} products=${products.length}`)

  // 키워드 → { docs: count, buckets: {occasion: count} }
  const agg = new Map()

  function addDoc(keyword, text) {
    if (!keyword) return
    const k = keyword.trim()
    if (!k) return
    let entry = agg.get(k)
    if (!entry) {
      entry = { docs: 0, buckets: emptyBuckets() }
      agg.set(k, entry)
    }
    entry.docs += 1
    bumpMatches(text, entry.buckets)
  }

  for (const row of raw) {
    const kw = pickKeyword(row)
    const text = extractText(row)
    if (!text) continue
    addDoc(kw, text)
  }

  for (const p of products) {
    const text = [p.canonical_name, p.description].filter(Boolean).join(' ')
    if (!text) continue
    addDoc(p.canonical_name, text)
  }

  const computedAt = new Date().toISOString()
  const rows = []
  for (const [keyword, { docs, buckets }] of agg.entries()) {
    if (docs < 1) continue
    const totalMatches = Object.values(buckets).reduce((a, b) => a + b, 0)
    if (totalMatches === 0) continue
    const breakdown = {}
    for (const [k, v] of Object.entries(buckets)) {
      if (v > 0) breakdown[k] = Number((v / docs).toFixed(4))
    }
    const giftShare = Math.min(1, Number((totalMatches / docs).toFixed(4)))
    rows.push({
      keyword,
      gift_share: giftShare,
      occasion_breakdown: breakdown,
      sample_count: docs,
      computed_at: computedAt,
    })
  }

  // gift_share 큰 순 상위 N 만 저장 (잡음 줄이기)
  rows.sort((a, b) => b.gift_share - a.gift_share)
  const top = rows.slice(0, 1000)
  console.log(`[gift-intent] candidates=${rows.length} writing=${top.length}`)

  if (top.length === 0) {
    console.log('[gift-intent] nothing to write.')
    return
  }

  // 배치 insert
  const CHUNK = 200
  for (let i = 0; i < top.length; i += CHUNK) {
    const slice = top.slice(i, i + CHUNK)
    const { error } = await sb.from('jimscanner_gift_intent_scores').insert(slice)
    if (error) {
      console.error('[gift-intent] insert error:', error.message)
      process.exit(1)
    }
  }
  console.log(`[gift-intent] done. computed_at=${computedAt}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
