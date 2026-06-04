#!/usr/bin/env node
/**
 * 자동완성 수요 트리 수집기 — 휴면 소스 google_suggest 본격 가동.
 *
 * 추천 상위 · 핀 · 미커버 시드 키워드를 google/naver 자동완성에 2단 재귀 질의해
 * 롱테일 suffix 를 jimscanner_market_raw(source=google_suggest)에 dedup 적재한다.
 *
 *   1단: seed 자체로 자동완성 → suffix 목록
 *   2단: 각 suffix 를 다시 seed 로 자동완성 (구체 SKU·구매의도 발굴)
 *
 * dedup_key = `${seed}::${suggestion}` (market_raw 가 이미 지원하는 구조).
 *
 * 사용법:
 *   node --env-file=.env.local scripts/collect-autocomplete.mjs
 *   node --env-file=.env.local scripts/collect-autocomplete.mjs --depth 1
 *   node --env-file=.env.local scripts/collect-autocomplete.mjs --limit 30
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
  console.error('Run with --env-file=.env.local')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
function argVal(name, def) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const DEPTH = Number(argVal('--depth', '2'))
const SEED_LIMIT = Number(argVal('--limit', '40'))
const SLEEP_MS = 220

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

/** Google 자동완성 (firefox client → [query, [suggestions...]]) */
async function fetchGoogle(query) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&q=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) return []
    return json[1].filter((x) => typeof x === 'string').slice(0, 10)
  } catch {
    return []
  }
}

/** Naver 자동완성 (ac.search.naver — JSON.items[0] = [[suggestion, ...], ...]) */
async function fetchNaver(query) {
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(query)}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&st=100`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    const items = json?.items?.[0]
    if (!Array.isArray(items)) return []
    return items
      .map((row) => (Array.isArray(row) ? row[0] : null))
      .filter((x) => typeof x === 'string')
      .slice(0, 10)
  } catch {
    return []
  }
}

async function suggest(query) {
  const [g, n] = await Promise.all([fetchGoogle(query), fetchNaver(query)])
  return [...new Set([...g, ...n])]
}

/** 추천 상위(ggsan 카탈로그 제목) · 핀 · 미커버 시드 수집 */
async function loadSeeds() {
  const seeds = new Set()

  // 핀(고정 관심 상품) 제목 → seed
  try {
    const { data } = await sb
      .from('jimscanner_trends_pins')
      .select('label')
      .limit(SEED_LIMIT)
    for (const p of data ?? []) {
      if (p?.label) seeds.add(String(p.label).trim())
    }
  } catch {
    /* 테이블/컬럼 차이는 무시 */
  }

  // trends_products 제목 (canonical 상품명) → seed
  try {
    const { data } = await sb
      .from('jimscanner_trends_products')
      .select('canonical_name')
      .limit(SEED_LIMIT)
    for (const p of data ?? []) {
      if (p?.canonical_name) seeds.add(String(p.canonical_name).trim())
    }
  } catch {
    /* 컬럼명 차이 무시 */
  }

  // alias 키워드 일부 → seed (미커버 발굴 후보)
  try {
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('alias')
      .eq('alias_type', 'keyword')
      .limit(SEED_LIMIT)
    for (const a of data ?? []) {
      if (a?.alias) seeds.add(String(a.alias).trim())
    }
  } catch {
    /* 무시 */
  }

  const list = [...seeds].filter((s) => s && s.length >= 2).slice(0, SEED_LIMIT)
  return list
}

async function main() {
  const t0 = Date.now()
  let seeds = await loadSeeds()
  if (seeds.length === 0) {
    console.warn('동적 시드가 비어 있음 — fallback 시드 사용.')
    seeds = ['수면영양제', '멜라토닌', '마그네슘', '루테인', '단백질보충제']
  }
  console.log(`[autocomplete] seeds=${seeds.length} depth=${DEPTH}`)

  const rows = []
  const seen = new Set()
  const queue = seeds.map((s) => ({ q: s, seed: s, level: 1 }))

  while (queue.length) {
    const { q, seed, level } = queue.shift()
    const sugs = await suggest(q)
    for (const s of sugs) {
      const key = `${seed}::${s}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        source: 'google_suggest',
        dedup_key: key,
        title: s,
        query: seed,
        metadata: { suggestion: s, level, engine: 'google+naver' },
      })
      // 2단 재귀: suffix 를 다음 질의어로 (seed 는 원래 seed 유지)
      if (level < DEPTH) {
        queue.push({ q: s, seed, level: level + 1 })
      }
    }
    await sleep(SLEEP_MS)
  }

  if (rows.length === 0) {
    console.log('수집된 자동완성 없음.')
    process.exit(0)
  }

  const payload = rows.map((r) => ({
    source: r.source,
    dedup_key: r.dedup_key,
    title: r.title,
    query: r.query,
    metadata: r.metadata,
  }))

  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .upsert(payload, { onConflict: 'source,dedup_key', ignoreDuplicates: true })
    .select('id')

  if (error) {
    console.error('upsert error:', error.message)
    process.exit(1)
  }

  console.log(
    `[autocomplete] fetched=${rows.length} inserted=${data?.length ?? 0} in ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
