#!/usr/bin/env node
// 핫딜 종료 후 수요 스냅백 윈도우 분석 — cron 진입점
//
// 흐름:
//  1. jimscanner_market_deal_cycles 에서 ended=true 사이클 조회
//  2. 각 cycle 의 키워드를 jimscanner_trends_keywords 에서 매칭
//  3. ±14일 윈도우의 volume_relative 시계열 추출
//  4. snapback_ratio = post_end_avg_7d / during_deal_peak
//  5. snapback_score (0~100) 산출 후 jimscanner_deal_snapback_scores 에 upsert
//
// 신규 종속성 X — supabase-js 만 사용 (다른 cron 스크립트와 동일).

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const DAY_MS = 24 * 60 * 60 * 1000

function avg(arr) {
  if (!arr.length) return null
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function peak(arr) {
  if (!arr.length) return null
  return Math.max(...arr)
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

async function fetchEndedCycles() {
  // view 가 아직 마이그레이션 안 됐으면 빈 배열 반환 (graceful)
  const res = await sb
    .from('jimscanner_market_deal_cycles')
    .select('cycle_key, sample_title, sample_site_label, deal_count, first_seen_at, last_seen_at, span_days, ended')
    .eq('ended', true)
    .order('last_seen_at', { ascending: false })
    .limit(200)
  if (res.error) {
    console.warn('[snapback] cycles view 조회 실패 (마이그레이션 미적용?):', res.error.message)
    return []
  }
  return res.data ?? []
}

async function fetchTrendSeries(keyword, fromIso, toIso) {
  const res = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, volume_relative, collected_at')
    .ilike('keyword', `%${keyword}%`)
    .gte('collected_at', fromIso)
    .lte('collected_at', toIso)
    .order('collected_at', { ascending: true })
    .limit(500)
  if (res.error) return []
  return res.data ?? []
}

function buildCurve(series, endedAt) {
  // [-14, +14] 일을 1일 bin 으로 평균.
  const buckets = new Map()
  for (const row of series) {
    if (row.volume_relative == null) continue
    const d = Math.round((new Date(row.collected_at).getTime() - endedAt.getTime()) / DAY_MS)
    if (d < -14 || d > 14) continue
    const cur = buckets.get(d) ?? []
    cur.push(Number(row.volume_relative))
    buckets.set(d, cur)
  }
  const out = []
  for (let d = -14; d <= 14; d++) {
    if (!buckets.has(d)) continue
    out.push({ d, v: Math.round(avg(buckets.get(d)) ?? 0) })
  }
  return out
}

function scoreOf(snapbackRatio, dealSpanDays, postCount) {
  if (snapbackRatio == null) return 0
  // 70% 회복이면 70점, 100% 이상이면 100점, 데이터 충분(post>=5)·짧지 않은 딜(>=2일) 보정.
  const base = clamp(snapbackRatio * 100, 0, 100)
  const dataBonus = clamp(postCount / 7, 0, 1) * 5
  const spanBonus = clamp(dealSpanDays / 5, 0, 1) * 5
  return Math.round(clamp(base + dataBonus + spanBonus, 0, 100))
}

async function upsertScore(row) {
  const res = await sb
    .from('jimscanner_deal_snapback_scores')
    .upsert(row, { onConflict: 'cycle_key' })
  if (res.error) {
    console.warn('[snapback] upsert 실패', row.cycle_key, res.error.message)
  }
}

async function main() {
  const startedAt = Date.now()
  const cycles = await fetchEndedCycles()
  console.log(`[snapback] ended cycles: ${cycles.length}`)
  let processed = 0
  for (const c of cycles) {
    const ended = new Date(c.last_seen_at)
    const started = new Date(c.first_seen_at)
    const fromIso = new Date(started.getTime() - 14 * DAY_MS).toISOString()
    const toIso = new Date(ended.getTime() + 14 * DAY_MS).toISOString()

    // 키워드 매칭 — cycle_key 가 2-token 정규화이므로 첫 토큰만 사용
    const probe = c.cycle_key.split(' ')[0]
    if (!probe || probe.length < 2) continue

    const series = await fetchTrendSeries(probe, fromIso, toIso)
    if (series.length === 0) continue

    const matchedKeyword = series[0]?.keyword ?? probe
    const trendSource = series[0]?.source ?? null

    // 윈도우 슬라이스
    const preStart = new Date(started.getTime() - 7 * DAY_MS).getTime()
    const preEnd = started.getTime()
    const postEnd7 = new Date(ended.getTime() + 7 * DAY_MS).getTime()
    const postEnd14 = new Date(ended.getTime() + 14 * DAY_MS).getTime()

    const preVals = []
    const duringVals = []
    const post7Vals = []
    const post14Vals = []
    for (const row of series) {
      if (row.volume_relative == null) continue
      const t = new Date(row.collected_at).getTime()
      const v = Number(row.volume_relative)
      if (t >= preStart && t < preEnd) preVals.push(v)
      else if (t >= preEnd && t <= ended.getTime()) duringVals.push(v)
      if (t > ended.getTime() && t <= postEnd7) post7Vals.push(v)
      if (t > ended.getTime() && t <= postEnd14) post14Vals.push(v)
    }

    const duringPeak = peak(duringVals)
    const postAvg7 = avg(post7Vals)
    const postAvg14 = avg(post14Vals)
    const snapbackRatio =
      duringPeak && duringPeak > 0 && postAvg7 != null ? postAvg7 / duringPeak : null
    const score = scoreOf(snapbackRatio, Number(c.span_days ?? 0), post7Vals.length)
    const curve = buildCurve(series, ended)

    // 회복 곡선에서 가장 큰 D+n peak 의 day → 진입 D-day
    let entryOffset = null
    let bestV = -1
    for (const p of curve) {
      if (p.d > 0 && p.v > bestV) {
        bestV = p.v
        entryOffset = p.d
      }
    }

    const row = {
      cycle_key: c.cycle_key,
      sample_title: c.sample_title,
      sample_site_label: c.sample_site_label,
      deal_started_at: started.toISOString(),
      deal_ended_at: ended.toISOString(),
      deal_span_days: Number(c.span_days ?? 0),
      matched_trend_keyword: matchedKeyword,
      trend_source: trendSource,
      pre_deal_avg: avg(preVals),
      during_deal_peak: duringPeak,
      post_end_avg_7d: postAvg7,
      post_end_avg_14d: postAvg14,
      recovery_curve: curve,
      snapback_ratio: snapbackRatio,
      snapback_score: score,
      recommended_entry_offset_days: entryOffset,
      computed_at: new Date().toISOString(),
    }
    await upsertScore(row)
    processed++
  }
  console.log(`[snapback] processed=${processed} elapsed=${Date.now() - startedAt}ms`)
}

main().catch((e) => {
  console.error('[snapback] fatal', e)
  process.exit(1)
})
