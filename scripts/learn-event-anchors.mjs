#!/usr/bin/env node
/**
 * 연·반복 이벤트 캘린더 D-day 플래너 — 다년치 학습 스크립트.
 *
 * jimscanner_trends_keywords (source='naver_search_trend') 의 다년치 데이터로
 * 각 이벤트의 related_keywords 가 실제로 발생시키는 피크 day-of-year 와
 * 피크/평균 lift 를 학습한 뒤 jimscanner_event_calendar 의
 *   yoy_lift_median / yoy_lift_stddev / learned_peak_doy / learned_peak_stddev / sample_years
 * 컬럼을 갱신한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/learn-event-anchors.mjs
 *   node --env-file=.env.local scripts/learn-event-anchors.mjs --dry  # 갱신 없이 출력만
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const DRY = process.argv.includes('--dry')
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// ─────────────────────────────────────────────────────────────────────────────
// 1) 이벤트 캘린더 로드
// ─────────────────────────────────────────────────────────────────────────────
const { data: events, error: evErr } = await sb
  .from('jimscanner_event_calendar')
  .select('id, event_key, event_name, anchor_month, anchor_day, related_keywords')
  .eq('is_active', true)

if (evErr) {
  console.error('event_calendar fetch error:', evErr.message)
  process.exit(1)
}
console.log(`📅 활성 이벤트 ${events.length}개 학습 시작 (DRY=${DRY})`)

// ─────────────────────────────────────────────────────────────────────────────
// 2) 다년치 naver_search_trend 키워드 시계열 수집
//    (최근 36개월; collected_at + volume_relative 기반)
// ─────────────────────────────────────────────────────────────────────────────
const SINCE = new Date()
SINCE.setMonth(SINCE.getMonth() - 36)

// 키워드 별 일자별 volume_relative 누적 (page through; supabase limit 1000)
async function fetchKeywordSeries(keyword) {
  const PAGE = 1000
  const rows = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('jimscanner_trends_keywords')
      .select('collected_at, volume_relative')
      .eq('source', 'naver_search_trend')
      .eq('keyword', keyword)
      .gte('collected_at', SINCE.toISOString())
      .order('collected_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return rows
}

function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0)
  const diff = d.getTime() - start
  return Math.floor(diff / 86400000)
}
function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function stddev(arr) {
  if (arr.length < 2) return 0
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length
  const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length
  return Math.sqrt(v)
}
// 원형(연주기) 거리 — 1월1일과 12월31일은 가까움
function circularStddev(doys) {
  if (doys.length < 2) return 0
  const rad = doys.map((d) => (d / 366) * 2 * Math.PI)
  const sin = rad.reduce((s, r) => s + Math.sin(r), 0) / rad.length
  const cos = rad.reduce((s, r) => s + Math.cos(r), 0) / rad.length
  const R = Math.sqrt(sin * sin + cos * cos)
  if (R >= 1) return 0
  return Math.sqrt(-2 * Math.log(R)) * (366 / (2 * Math.PI))
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 이벤트별 학습
// ─────────────────────────────────────────────────────────────────────────────
const updates = []
for (const ev of events) {
  const kws = ev.related_keywords ?? []
  if (!kws.length) {
    console.log(`  · ${ev.event_key.padEnd(18)} keywords 없음 — 스킵`)
    continue
  }
  // 각 키워드의 series → 연도별 피크 doy 와 lift 수집
  const allLifts = []
  const allPeakDoys = []
  const yearsSeen = new Set()
  for (const kw of kws) {
    let series
    try {
      series = await fetchKeywordSeries(kw)
    } catch (e) {
      console.error(`    fetch error (${kw}):`, e.message)
      continue
    }
    if (series.length < 30) continue
    // 연도별 그룹
    const byYear = new Map()
    for (const r of series) {
      const d = new Date(r.collected_at)
      const y = d.getUTCFullYear()
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y).push({ doy: dayOfYear(d), vol: Number(r.volume_relative ?? 0) })
    }
    for (const [y, pts] of byYear) {
      if (pts.length < 10) continue
      const mean = pts.reduce((s, p) => s + p.vol, 0) / pts.length
      if (mean <= 0) continue
      const peak = pts.reduce((a, b) => (b.vol > a.vol ? b : a))
      const lift = peak.vol / mean
      // 피크 day-of-year 가 이벤트 anchor 근방(±45일)에 있는 경우만 채택
      const anchorDoy = ev.anchor_month && ev.anchor_day
        ? dayOfYear(new Date(Date.UTC(y, ev.anchor_month - 1, ev.anchor_day)))
        : null
      if (anchorDoy != null) {
        const dist = Math.min(
          Math.abs(peak.doy - anchorDoy),
          366 - Math.abs(peak.doy - anchorDoy),
        )
        if (dist > 45) continue
      }
      allLifts.push(lift)
      allPeakDoys.push(peak.doy)
      yearsSeen.add(y)
    }
  }

  const liftMedian = median(allLifts)
  const liftStd = stddev(allLifts)
  const peakDoy = allPeakDoys.length ? Math.round(median(allPeakDoys)) : null
  const peakStd = circularStddev(allPeakDoys)
  const sampleYears = yearsSeen.size

  console.log(
    `  · ${ev.event_key.padEnd(18)} years=${sampleYears} liftMed=${liftMedian?.toFixed(2) ?? '—'} ±${liftStd.toFixed(2)} peakDoy=${peakDoy ?? '—'} ±${peakStd.toFixed(1)}`,
  )

  if (sampleYears === 0) continue
  updates.push({
    id: ev.id,
    event_key: ev.event_key,
    yoy_lift_median: liftMedian,
    yoy_lift_stddev: liftStd,
    learned_peak_doy: peakDoy,
    learned_peak_stddev: peakStd,
    sample_years: sampleYears,
    last_learned_at: new Date().toISOString(),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 갱신
// ─────────────────────────────────────────────────────────────────────────────
if (DRY) {
  console.log(`\n📝 DRY — ${updates.length}건 갱신 예정 (저장 안함)`)
  process.exit(0)
}
for (const u of updates) {
  const { error } = await sb
    .from('jimscanner_event_calendar')
    .update({
      yoy_lift_median: u.yoy_lift_median,
      yoy_lift_stddev: u.yoy_lift_stddev,
      learned_peak_doy: u.learned_peak_doy,
      learned_peak_stddev: u.learned_peak_stddev,
      sample_years: u.sample_years,
      last_learned_at: u.last_learned_at,
    })
    .eq('id', u.id)
  if (error) console.error(`update fail (${u.event_key}):`, error.message)
}
console.log(`\n✅ ${updates.length}건 학습값 갱신 완료`)
