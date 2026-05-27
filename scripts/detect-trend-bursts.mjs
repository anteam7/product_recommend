#!/usr/bin/env node
/**
 * detect-trend-bursts — 1회/일 cron.
 *
 * jimscanner_trends_keywords 시계열 (최근 60일) 을 키워드별로 묶어
 *   - 직전 28일 (burst_date 제외) 평균/표준편차 산출
 *   - 가장 최근 수집일의 volume_relative 에 대한 Z-score 계산
 *   - Z > 2.5 인 키워드를 burst 로 판정
 * 후
 *   - burst_date - 72h ~ burst_date+1d 윈도우의 jimscanner_market_raw
 *     (naver_news / naver_blog / quasarzone_sale) 와 LIKE 매칭
 *   - 소스 가중치(news 1.0, deal 0.8, blog 0.5) × 매칭 강도 → cause_score
 *   - 분포에 따라 burst_type 분류
 * 결과를 jimscanner_trends_bursts 에 upsert.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/detect-trend-bursts.mjs
 *   node --env-file=.env.local scripts/detect-trend-bursts.mjs --dry-run
 *   node --env-file=.env.local scripts/detect-trend-bursts.mjs --z 2.0
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const zIdx = args.indexOf('--z')
const Z_THRESHOLD = zIdx >= 0 ? parseFloat(args[zIdx + 1]) : 2.5

const HISTORY_DAYS = 60
const BASELINE_DAYS = 28
const WINDOW_HOURS = 72
const MIN_BASELINE_POINTS = 7

const SOURCE_WEIGHTS = {
  naver_news: 1.0,
  quasarzone_sale: 0.8,
  naver_blog: 0.5,
}

function dayKey(ts) {
  // ts 는 ISO. KST 기준으로 일자 묶기 (UTC+9)
  const d = new Date(ts)
  d.setUTCHours(d.getUTCHours() + 9)
  return d.toISOString().slice(0, 10)
}

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}
function stddev(arr, m) {
  if (arr.length < 2) return 0
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1)
  return Math.sqrt(v)
}

// 단순 매칭 점수: keyword 가 title 안에 부분문자열로 포함되는지.
function matchScore(title, keyword) {
  if (!title || !keyword) return 0
  const t = title.toLowerCase()
  const k = keyword.toLowerCase()
  if (t.includes(k)) {
    // 키워드가 차지하는 비중에 따라 보정 (짧은 제목 = 강한 시그널)
    return Math.min(1.0, 0.6 + 0.4 * Math.min(1, k.length / Math.max(t.length, 1)))
  }
  // 부분일치: keyword 의 공백 분리 토큰 중 하나라도 등장
  const toks = k.split(/\s+/).filter((x) => x.length >= 2)
  let hit = 0
  for (const tok of toks) if (t.includes(tok)) hit++
  if (hit > 0) return 0.3 * (hit / toks.length)
  return 0
}

function classifyBurstType(causeSources, topCauseScore) {
  if (topCauseScore <= 0) return 'unexplained'
  const total = Object.values(causeSources).reduce((a, b) => a + b, 0)
  if (total === 0) return 'unexplained'
  const share = (s) => (causeSources[s] ?? 0) / total
  const news = share('naver_news')
  const deal = share('quasarzone_sale')
  const blog = share('naver_blog')
  if (news >= deal && news >= blog) return 'news_driven'
  if (deal >= news && deal >= blog) return 'deal_driven'
  return 'viral_blog'
}

const started = Date.now()
console.log(`[detect-trend-bursts] z=${Z_THRESHOLD} dryRun=${dryRun}`)

// 1) 시계열 로드 (60일)
const sinceTs = new Date(Date.now() - HISTORY_DAYS * 86400_000).toISOString()
const PAGE = 1000
let all = []
let offset = 0
while (true) {
  const { data, error } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, volume_relative, collected_at')
    .gte('collected_at', sinceTs)
    .not('volume_relative', 'is', null)
    .order('collected_at', { ascending: true })
    .range(offset, offset + PAGE - 1)
  if (error) {
    console.error('trends_keywords fetch error', error)
    process.exit(1)
  }
  if (!data || data.length === 0) break
  all.push(...data)
  if (data.length < PAGE) break
  offset += PAGE
}
console.log(`  loaded ${all.length} trends_keywords rows (${HISTORY_DAYS}d)`)

// 2) keyword × day 집계 (같은 날 여러 source/수집 → 최대값을 일자 대표)
const byKw = new Map() // keyword -> { source, days: Map<dayKey, max_volume> }
for (const r of all) {
  const k = r.keyword
  if (!k) continue
  let entry = byKw.get(k)
  if (!entry) {
    entry = { source: r.source, days: new Map() }
    byKw.set(k, entry)
  }
  const dk = dayKey(r.collected_at)
  const v = Number(r.volume_relative) || 0
  const prev = entry.days.get(dk)
  if (prev == null || v > prev) entry.days.set(dk, v)
}

// 3) burst 후보 산출
const bursts = []
for (const [keyword, { source, days }] of byKw.entries()) {
  if (days.size < MIN_BASELINE_POINTS + 1) continue
  const sortedDays = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const [latestDay, latestVol] = sortedDays[sortedDays.length - 1]
  // baseline = 가장 최근 28일 (latestDay 제외)
  const baselineRows = sortedDays
    .slice(-(BASELINE_DAYS + 1), -1) // 마지막 latestDay 제외
    .map(([, v]) => v)
  if (baselineRows.length < MIN_BASELINE_POINTS) continue
  const m = mean(baselineRows)
  const s = stddev(baselineRows, m)
  if (s <= 0 || m <= 0) continue
  const z = (latestVol - m) / s
  if (z < Z_THRESHOLD) continue
  bursts.push({
    keyword,
    source,
    burst_date: latestDay,
    baseline_mean: m,
    baseline_std: s,
    latest_volume: latestVol,
    z_score: z,
    spike_ratio: latestVol / m,
  })
}

console.log(`  ${bursts.length} burst candidate(s) (z >= ${Z_THRESHOLD})`)

if (bursts.length === 0) {
  console.log('[detect-trend-bursts] no bursts — exit')
  process.exit(0)
}

// 4) market_raw 후보 풀 로드 (전체 burst 의 유니온 윈도우)
const earliestBurst = bursts.reduce(
  (m, b) => (b.burst_date < m ? b.burst_date : m),
  bursts[0].burst_date,
)
const rawSince = new Date(
  new Date(earliestBurst + 'T00:00:00Z').getTime() - WINDOW_HOURS * 3600_000,
).toISOString()

let raws = []
offset = 0
while (true) {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, source_url, captured_at')
    .in('source', ['naver_news', 'naver_blog', 'quasarzone_sale'])
    .gte('captured_at', rawSince)
    .order('captured_at', { ascending: false })
    .range(offset, offset + PAGE - 1)
  if (error) {
    console.error('market_raw fetch error', error)
    process.exit(1)
  }
  if (!data || data.length === 0) break
  raws.push(...data)
  if (data.length < PAGE) break
  offset += PAGE
}
console.log(`  loaded ${raws.length} market_raw rows for cause attribution`)

// 5) cluster 멤버 lookup — 키워드가 cluster member 면 그 cluster 의 모든 표면형도 매칭에 사용
const { data: clusterMaps } = await sb
  .from('jimscanner_signal_cluster_map')
  .select('cluster_id, surface_term, signal_kind')
  .eq('signal_kind', 'trends_keyword')

const kwToCluster = new Map() // keyword(surface) -> cluster_id
for (const m of clusterMaps ?? []) {
  kwToCluster.set(m.surface_term, m.cluster_id)
}
// cluster_id -> list of surface_terms
const clusterMembers = new Map()
const allClusterMembers = await sb
  .from('jimscanner_signal_cluster_map')
  .select('cluster_id, surface_term')
let memberRows = allClusterMembers.data ?? []
for (const m of memberRows) {
  let arr = clusterMembers.get(m.cluster_id)
  if (!arr) {
    arr = []
    clusterMembers.set(m.cluster_id, arr)
  }
  arr.push(m.surface_term)
}

// 6) 각 burst 에 대해 원인 후보 점수화
const rowsToUpsert = []
for (const b of bursts) {
  const clusterId = kwToCluster.get(b.keyword) ?? null
  const matchTerms = new Set([b.keyword])
  if (clusterId && clusterMembers.has(clusterId)) {
    for (const t of clusterMembers.get(clusterId)) matchTerms.add(t)
  }

  const burstStart = new Date(b.burst_date + 'T00:00:00+09:00').getTime() - WINDOW_HOURS * 3600_000
  const burstEnd = new Date(b.burst_date + 'T23:59:59+09:00').getTime()

  const scored = []
  for (const r of raws) {
    const ts = new Date(r.captured_at).getTime()
    if (ts < burstStart || ts > burstEnd) continue
    // 매칭 강도
    let best = 0
    for (const term of matchTerms) {
      const m = matchScore(r.title ?? '', term)
      if (m > best) best = m
    }
    if (best <= 0) continue
    const w = SOURCE_WEIGHTS[r.source] ?? 0.3
    const score = w * best
    scored.push({ raw: r, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top3 = scored.slice(0, 3)

  // 소스 분포 (전체 매칭 기준)
  const causeSources = {}
  for (const s of scored) {
    causeSources[s.raw.source] = (causeSources[s.raw.source] ?? 0) + 1
  }
  const topCauseScore = top3[0]?.score ?? 0
  const burstType = classifyBurstType(causeSources, topCauseScore)

  rowsToUpsert.push({
    keyword: b.keyword,
    source: b.source,
    cluster_id: clusterId,
    burst_date: b.burst_date,
    detected_at: new Date().toISOString(),
    baseline_mean: b.baseline_mean,
    baseline_std: b.baseline_std,
    latest_volume: b.latest_volume,
    z_score: Number(b.z_score.toFixed(3)),
    spike_ratio: Number(b.spike_ratio.toFixed(3)),
    burst_type: burstType,
    top_cause_score: Number(topCauseScore.toFixed(3)),
    cause_sources: causeSources,
    top_cause_ids: top3.map((x) => x.raw.id),
    top_cause_payload: top3.map((x) => ({
      id: x.raw.id,
      source: x.raw.source,
      title: x.raw.title,
      source_url: x.raw.source_url,
      captured_at: x.raw.captured_at,
      score: Number(x.score.toFixed(3)),
    })),
  })
}

const summary = rowsToUpsert.reduce((acc, r) => {
  acc[r.burst_type] = (acc[r.burst_type] ?? 0) + 1
  return acc
}, {})
console.log('  type breakdown:', summary)

if (dryRun) {
  console.log('[detect-trend-bursts] dry-run — printing first 5')
  for (const r of rowsToUpsert.slice(0, 5)) {
    console.log(
      `  ${r.keyword}  z=${r.z_score}  spike=${r.spike_ratio}x  type=${r.burst_type}  top=${r.top_cause_payload[0]?.title ?? '(none)'}`,
    )
  }
  process.exit(0)
}

// 7) upsert (keyword + burst_date 유니크)
const { error: upErr } = await sb
  .from('jimscanner_trends_bursts')
  .upsert(rowsToUpsert, { onConflict: 'keyword,burst_date' })
if (upErr) {
  console.error('upsert error', upErr)
  process.exit(1)
}

console.log(
  `[detect-trend-bursts] ok — upserted ${rowsToUpsert.length} burst(s) in ${Date.now() - started}ms`,
)
