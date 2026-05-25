#!/usr/bin/env node
/**
 * 자동완성 드리프트 cron — 매일 KST 05:30 (로컬 cron runner 가 호출).
 *
 *   node --env-file=.env.local scripts/autocomplete-drift-cron.mjs
 *
 * 동일 seed 접두어(카테고리 top + 핀 keyword) 로 google_suggest / naver_autocomplete 를
 * 호출해 top-N 완성어 시계열을 jimscanner_autocomplete_snapshots 에 적재한다.
 *
 * 적재 후, 지난 14일 내 first_seen 인 commercial/transactional intent 완성어 중
 * 아직 jimscanner_trends_pins 에 없는 것을 핀 후보 큐에 자동 enqueue.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

const FALLBACK_SEEDS = [
  '미국 직구', '일본 직구', '중국 직구', '유럽 직구',
  '아마존 직구', '알리익스프레스', '타오바오 직구',
  '직구 관세', '직구 통관', '직구 한도',
  '아이폰 직구', '맥북 직구', '영양제 직구', '비타민 직구',
  '블랙프라이데이 직구',
]

const TOP_N = 10
const SLEEP_MS = 200

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchGoogleSuggest(query) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&q=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    if (!Array.isArray(json) || json.length < 2) return []
    const list = json[1]
    if (!Array.isArray(list)) return []
    return list.filter((x) => typeof x === 'string').slice(0, TOP_N)
  } catch {
    return []
  }
}

async function fetchNaverAutocomplete(query) {
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(query)}&con=0&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.naver.com/' },
    })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    if (!json || !Array.isArray(json.items)) return []
    // items 구조: items[0] = [["keyword",...], ...]
    const flat = []
    for (const block of json.items) {
      if (!Array.isArray(block)) continue
      for (const row of block) {
        if (Array.isArray(row) && typeof row[0] === 'string') flat.push(row[0])
      }
    }
    // dedupe + top-N
    const seen = new Set()
    const out = []
    for (const s of flat) {
      if (seen.has(s)) continue
      seen.add(s)
      out.push(s)
      if (out.length >= TOP_N) break
    }
    return out
  } catch {
    return []
  }
}

async function loadSeeds() {
  // 1) 핀된 키워드를 seed 로 사용
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .limit(50)
  const pinSeeds = (pins ?? []).map((r) => r.keyword).filter(Boolean)

  // 2) 카테고리 top 시드 — FALLBACK_SEEDS 와 합쳐 unique
  const seeds = [...new Set([...FALLBACK_SEEDS, ...pinSeeds])]
  return seeds
}

async function alreadyCollectedToday(source, seed) {
  // 같은 day 안에 같은 (source, seed) 가 이미 적재됐는지 확인 — 재실행 방지.
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const { count } = await sb
    .from('jimscanner_autocomplete_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('source', source)
    .eq('seed', seed)
    .gte('captured_at', startOfDay.toISOString())
  return (count ?? 0) > 0
}

async function ingestSeed(source, seed, suggestions) {
  if (suggestions.length === 0) return 0
  const rows = suggestions.map((s, i) => ({
    source,
    seed,
    suggestion: s,
    rank: i + 1,
  }))
  const { error, data } = await sb
    .from('jimscanner_autocomplete_snapshots')
    .insert(rows)
    .select('id')
  if (error) {
    console.error(`  insert error (${source}/${seed}): ${error.message}`)
    return 0
  }
  return data?.length ?? 0
}

async function enqueueNewPinCandidates() {
  // v_autocomplete_drift 에서 first_seen 14일 이내인 신규 완성어 중,
  // intent_label 이 commercial/transactional 인 것만 핀 큐(jimscanner_trends_pins) 에 자동 enqueue.
  // — 분류기 결과는 jimscanner_trends_keywords.classified_intent 에 존재.

  // drift view 조회
  const { data: drift, error: driftErr } = await sb
    .from('v_autocomplete_drift')
    .select('source, seed, suggestion, first_seen_at, days_since_first_seen, latest_rank')
    .lte('days_since_first_seen', 14)
    .order('latest_rank', { ascending: true })
    .limit(200)
  if (driftErr) {
    console.error(`  drift view error: ${driftErr.message}`)
    return 0
  }
  if (!drift || drift.length === 0) return 0

  // 이미 핀된 키워드는 skip
  const sugs = [...new Set(drift.map((r) => r.suggestion))]
  const { data: existingPins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .in('keyword', sugs)
  const pinned = new Set((existingPins ?? []).map((r) => r.keyword))

  // intent 가 commercial/transactional 인 키워드만 통과
  const { data: classified } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, classified_intent')
    .in('keyword', sugs)
    .in('classified_intent', ['commercial', 'transactional'])
  const intentful = new Set((classified ?? []).map((r) => r.keyword))

  const candidates = drift.filter(
    (r) => !pinned.has(r.suggestion) && intentful.has(r.suggestion),
  )

  let enq = 0
  for (const c of candidates.slice(0, 20)) {
    const { error } = await sb.from('jimscanner_trends_pins').upsert(
      {
        keyword: c.suggestion,
        source: c.source,
        notes: `auto-pinned from autocomplete drift (first_seen=${c.first_seen_at?.slice(0, 10)}, rank=${c.latest_rank})`,
        pinned_at: new Date().toISOString(),
      },
      { onConflict: 'keyword,source' },
    )
    if (!error) enq++
  }
  return enq
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] autocomplete-drift-cron start`)

  const seeds = await loadSeeds()
  console.log(`  seeds=${seeds.length}`)

  let totalIns = 0
  let totalCalls = 0
  for (const seed of seeds) {
    for (const source of ['google_suggest', 'naver_autocomplete']) {
      if (await alreadyCollectedToday(source, seed)) {
        continue
      }
      const fetcher = source === 'google_suggest' ? fetchGoogleSuggest : fetchNaverAutocomplete
      const sugs = await fetcher(seed)
      totalCalls++
      const ins = await ingestSeed(source, seed, sugs)
      totalIns += ins
      await sleep(SLEEP_MS)
    }
  }

  const enqueued = await enqueueNewPinCandidates()

  const ms = Date.now() - t0
  console.log(
    `[${new Date().toISOString()}] done — calls=${totalCalls} inserted=${totalIns} pin_enqueued=${enqueued} in ${ms}ms`,
  )
}

main().catch((e) => {
  console.error('autocomplete-drift-cron fatal', e)
  process.exit(1)
})
