#!/usr/bin/env node
/**
 * Co-search graph 수집 — Naver 자동완성 + 연관검색어 → jimscanner_trends_query_edges
 *
 * 호출:
 *   node --env-file=.env.local scripts/collect-naver-related-keywords.mjs
 *
 * 추천 cron: KST 03:40 (scripts/run-crons.mjs 에서 spawn)
 *
 * 시드 keyword 풀:
 *   1) 최근 30일 jimscanner_trends_aliases 의 alias (alias_type='keyword' 우선)
 *   2) 상한 200개 / 회 (Naver suggest unauthenticated 호출 부담 고려)
 *
 * 또한 같은 product 의 alias 끼리 source='co_alias' 엣지 동시 적재.
 *
 * 모든 엣지는 (keyword_a < keyword_b) 정규화.
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

const MAX_SEEDS_PER_RUN = 200
const SUGGEST_BASE_WEIGHT = 1.0
const RELATED_BASE_WEIGHT = 1.5
const COALIAS_BASE_WEIGHT = 2.0
const FETCH_DELAY_MS = 350

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function normPair(a, b) {
  const x = (a ?? '').trim()
  const y = (b ?? '').trim()
  if (!x || !y || x === y) return null
  return x < y ? [x, y] : [y, x]
}

async function fetchNaverSuggest(query) {
  // Public AC endpoint — best effort, no key required.
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(query)}&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (jimscanner co-search collector)',
        Accept: 'application/json,text/plain,*/*',
      },
    })
    if (!res.ok) return []
    const text = await res.text()
    // Naver AC 응답은 JSON 이지만 종종 jsonp 형태로 옴. 보호 처리.
    const json = JSON.parse(text)
    // shape: { items: [ [ [ "kw", ... ], ... ] ] }
    const items = json?.items?.[0]
    if (!Array.isArray(items)) return []
    const out = []
    for (const row of items) {
      const kw = Array.isArray(row) ? row[0] : null
      if (typeof kw === 'string' && kw.trim()) out.push(kw.trim())
    }
    return out
  } catch (e) {
    console.warn(`[suggest] ${query}: ${e.message}`)
    return []
  }
}

async function fetchNaverRelated(query) {
  // SERP HTML 의 연관검색어 블록 파싱. 가장 안정적인 셀렉터는
  // related_srch 영역의 keyword 들이지만 마크업이 자주 바뀜 — best effort.
  const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    })
    if (!res.ok) return []
    const html = await res.text()
    // 가장 흔한 셀렉터: a class="keyword" 또는 related_srch li > a > .tit
    const out = new Set()
    const re1 = /<a[^>]+class="[^"]*related_srch[^"]*"[^>]*>([^<]+)<\/a>/g
    const re2 = /<a[^>]+class="[^"]*keyword[^"]*"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g
    const re3 = /class="tit"[^>]*>([^<]{1,40})<\/span>/g
    for (const re of [re1, re2, re3]) {
      let m
      while ((m = re.exec(html)) !== null) {
        const kw = m[1].replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim()
        if (kw && kw.length <= 40 && !kw.includes('\n')) out.add(kw)
      }
    }
    return [...out]
  } catch (e) {
    console.warn(`[related] ${query}: ${e.message}`)
    return []
  }
}

async function loadSeedKeywords() {
  // 최근 60일 alias 중 alias_type='keyword' 우선, fallback 으로 product_title
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, alias_type, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) throw new Error(`seeds: ${error.message}`)
  const uniq = new Map()
  for (const row of data ?? []) {
    if (!row?.alias) continue
    const k = row.alias.trim()
    if (!k || k.length > 30) continue
    if (!uniq.has(k)) uniq.set(k, row.alias_type)
  }
  return [...uniq.keys()].slice(0, MAX_SEEDS_PER_RUN)
}

async function loadCoAliasPairs() {
  const { data, error } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .limit(10000)
  if (error) throw new Error(`co_alias: ${error.message}`)
  const byProduct = new Map()
  for (const row of data ?? []) {
    if (!row?.product_id || !row?.alias) continue
    const a = row.alias.trim()
    if (!a) continue
    let arr = byProduct.get(row.product_id)
    if (!arr) {
      arr = []
      byProduct.set(row.product_id, arr)
    }
    arr.push(a)
  }
  const pairs = []
  for (const arr of byProduct.values()) {
    if (arr.length < 2) continue
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const p = normPair(arr[i], arr[j])
        if (p) pairs.push(p)
      }
    }
  }
  return pairs
}

async function upsertEdges(rows) {
  if (rows.length === 0) return 0
  // chunked upsert
  const CHUNK = 200
  let n = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_trends_query_edges')
      .upsert(slice, { onConflict: 'keyword_a,keyword_b,source', ignoreDuplicates: false })
    if (error) {
      console.error(`upsert error: ${error.message}`)
      break
    }
    n += slice.length
  }
  return n
}

async function main() {
  const startedAt = Date.now()
  console.log('[co-search] loading seeds…')
  const seeds = await loadSeedKeywords()
  console.log(`[co-search] ${seeds.length} seeds`)

  const now = new Date().toISOString()
  const edges = []

  // 1) co_alias pairs (싸고 빠름 — 먼저)
  const coPairs = await loadCoAliasPairs()
  console.log(`[co-search] ${coPairs.length} co_alias pairs`)
  for (const [a, b] of coPairs) {
    edges.push({
      keyword_a: a,
      keyword_b: b,
      source: 'co_alias',
      weight: COALIAS_BASE_WEIGHT,
      observed_at: now,
    })
  }

  // 2) Naver suggest + related (HTTP — 천천히)
  for (const seed of seeds) {
    const [sugg, rel] = await Promise.all([fetchNaverSuggest(seed), fetchNaverRelated(seed)])
    for (const kw of sugg) {
      const p = normPair(seed, kw)
      if (!p) continue
      edges.push({
        keyword_a: p[0],
        keyword_b: p[1],
        source: 'naver_suggest',
        weight: SUGGEST_BASE_WEIGHT,
        observed_at: now,
      })
    }
    for (const kw of rel) {
      const p = normPair(seed, kw)
      if (!p) continue
      edges.push({
        keyword_a: p[0],
        keyword_b: p[1],
        source: 'naver_related',
        weight: RELATED_BASE_WEIGHT,
        observed_at: now,
      })
    }
    await sleep(FETCH_DELAY_MS)
  }

  // dedup within batch: 같은 (a,b,source) 중복이면 weight 누적
  const dedup = new Map()
  for (const e of edges) {
    const k = `${e.keyword_a}${e.keyword_b}${e.source}`
    const existing = dedup.get(k)
    if (existing) {
      existing.weight += e.weight
    } else {
      dedup.set(k, { ...e })
    }
  }
  const finalRows = [...dedup.values()]
  console.log(`[co-search] upserting ${finalRows.length} unique edges`)

  const inserted = await upsertEdges(finalRows)
  const durationMs = Date.now() - startedAt
  console.log(`[co-search] done — inserted=${inserted} duration=${durationMs}ms`)

  // log run
  await sb.from('jimscanner_trends_runs').insert({
    source: 'naver_related_keywords',
    status: inserted === finalRows.length ? 'ok' : 'partial',
    fetched_count: seeds.length,
    inserted_count: inserted,
    duration_ms: durationMs,
    triggered_by: 'cli',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
