#!/usr/bin/env node
/**
 * 코멘션 마이닝 — naver_blog/news 본문에서 alias 동시언급 페어 추출.
 *
 * 입력: jimscanner_market_raw (source IN ('naver_blog','naver_news'))
 * 출력: jimscanner_trends_cobuy_raw + jimscanner_trends_bundle_candidates 집계
 *
 * 호출:
 *   node --env-file=.env.local scripts/mine-cobuy.mjs [--limit=500]
 *
 * 로직:
 *   1) 미처리 raw 본문(title + metadata.description) 로드
 *   2) alias 매칭 — 본문에 등장하는 product alias 추출
 *   3) 코바이 패턴('같이 샀어요'|'세트'|'함께 쓰는'|'추천 조합') 발견 시 페어 가중치↑
 *   4) (a<b) 정렬 후 cobuy_raw 적재
 *   5) bundle_candidates 에 co_mention_count 증분 upsert
 *
 * 보완 vs 대체 분류는 별도 단계 (classify-trends-llm.mjs 확장) 에서 처리.
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

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']
  }),
)

const LIMIT = parseInt(args.limit ?? '500', 10)

const COBUY_PATTERNS = [
  { pattern: /같이\s*샀어요|함께\s*샀어요/g, label: 'co_buy', weight: 3.0 },
  { pattern: /세트로?\s*(쓰|사용|판매|구매)/g, label: 'set', weight: 2.5 },
  { pattern: /함께\s*(쓰|사용)/g, label: 'co_use', weight: 2.0 },
  { pattern: /추천\s*조합|조합\s*추천/g, label: 'recommend_combo', weight: 2.0 },
  { pattern: /궁합|어울리는/g, label: 'pairing', weight: 1.5 },
]

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a]
}

async function loadAliases() {
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, product_id')
    .order('alias', { ascending: false })
  if (error) throw error
  // 긴 alias 우선 매칭으로 중복 방지
  return (data ?? [])
    .filter((a) => a.alias && a.alias.length >= 3)
    .sort((x, y) => y.alias.length - x.alias.length)
}

async function loadRaw() {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, metadata, captured_at')
    .in('source', ['naver_blog', 'naver_news'])
    .eq('processed', false)
    .order('captured_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  return data ?? []
}

function findAliasHits(text, aliases) {
  const hits = new Map() // product_id -> true
  const used = new Set()
  for (const { alias, product_id } of aliases) {
    if (used.has(alias.toLowerCase())) continue
    if (text.includes(alias)) {
      hits.set(product_id, true)
      used.add(alias.toLowerCase())
    }
  }
  return [...hits.keys()]
}

function detectCobuy(text) {
  let weight = 1.0
  let matched = null
  let snippet = null
  for (const p of COBUY_PATTERNS) {
    const m = text.match(p.pattern)
    if (m) {
      weight = Math.max(weight, p.weight)
      matched = p.label
      const idx = text.search(p.pattern)
      snippet = text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + 80))
      break
    }
  }
  return { weight, matched, snippet }
}

async function main() {
  console.log(`[mine-cobuy] loading aliases...`)
  const aliases = await loadAliases()
  console.log(`[mine-cobuy] aliases=${aliases.length}`)

  console.log(`[mine-cobuy] loading raw (limit=${LIMIT})...`)
  const rows = await loadRaw()
  console.log(`[mine-cobuy] raw=${rows.length}`)

  const pairCounts = new Map() // 'a::b' -> { a, b, count, weight, signal_source, raw_id, snippet, pattern }
  let scanned = 0
  for (const r of rows) {
    const text = [r.title ?? '', r.metadata?.description ?? '', r.metadata?.content ?? '']
      .filter(Boolean)
      .join(' ')
    if (!text || text.length < 20) continue
    scanned++
    const productIds = findAliasHits(text, aliases)
    if (productIds.length < 2) continue
    const cobuy = detectCobuy(text)
    for (let i = 0; i < productIds.length; i++) {
      for (let j = i + 1; j < productIds.length; j++) {
        const [a, b] = orderPair(productIds[i], productIds[j])
        const key = `${a}::${b}`
        const cur = pairCounts.get(key) ?? {
          product_a_id: a,
          product_b_id: b,
          count: 0,
          weight_sum: 0,
          signal_source: r.source,
          raw_id: r.id,
          snippet: cobuy.snippet ?? text.slice(0, 100),
          pattern: cobuy.matched ?? 'co_mention',
        }
        cur.count++
        cur.weight_sum += cobuy.weight
        pairCounts.set(key, cur)
      }
    }
  }

  console.log(`[mine-cobuy] scanned=${scanned} pairs=${pairCounts.size}`)

  let inserted = 0
  for (const v of pairCounts.values()) {
    // cobuy_raw 적재 (집계 1줄)
    const { error: rawErr } = await sb.from('jimscanner_trends_cobuy_raw').insert({
      product_a_id: v.product_a_id,
      product_b_id: v.product_b_id,
      signal_source: v.signal_source,
      raw_id: v.raw_id,
      snippet: v.snippet,
      pattern_matched: v.pattern,
      weight: v.weight_sum,
    })
    if (rawErr) {
      console.warn(`[mine-cobuy] raw insert failed`, rawErr.message)
      continue
    }
    // bundle_candidates upsert (count 증분)
    const { data: existing } = await sb
      .from('jimscanner_trends_bundle_candidates')
      .select('id, co_mention_count')
      .eq('product_a_id', v.product_a_id)
      .eq('product_b_id', v.product_b_id)
      .maybeSingle()
    if (existing) {
      await sb
        .from('jimscanner_trends_bundle_candidates')
        .update({
          co_mention_count: (existing.co_mention_count ?? 0) + v.count,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
    } else {
      await sb.from('jimscanner_trends_bundle_candidates').insert({
        product_a_id: v.product_a_id,
        product_b_id: v.product_b_id,
        co_mention_count: v.count,
      })
    }
    inserted++
  }

  // 처리 완료 표시
  const processedIds = rows.map((r) => r.id)
  if (processedIds.length > 0) {
    await sb
      .from('jimscanner_market_raw')
      .update({ processed: true })
      .in('id', processedIds)
  }

  console.log(`[mine-cobuy] done. pairs_upserted=${inserted} raw_processed=${processedIds.length}`)
}

main().catch((e) => {
  console.error('[mine-cobuy] fatal', e)
  process.exit(1)
})
