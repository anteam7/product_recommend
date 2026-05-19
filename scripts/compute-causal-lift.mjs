#!/usr/bin/env node
/**
 * 핀 행동 인과효과 컴퓨트 — Synthetic Control Lift (Diff-in-Differences)
 *
 * jimscanner_admin_actions 중 핀과 연결된 action 마다:
 *   1. t0 (action_at) 시점에 매칭 가능한 비핀 키워드 합성대조군 N≤20 을 추출 (같은 category_top,
 *      유사 trend volume_relative ±5)
 *   2. t0 전/후 7일, 28일 윈도우의 평균 volume_relative 를 핀 / 대조군 양쪽에서 계산
 *   3. DiD lift = (pin_post - pin_pre) - (ctrl_post - ctrl_pre)
 *   4. control 키워드별 DiD 의 bootstrap (1000 iter) 으로 95% CI
 *   5. jimscanner_actions_lift_cache 에 upsert.
 *
 * 사용:
 *   node --env-file=.env.local scripts/compute-causal-lift.mjs
 *   node --env-file=.env.local scripts/compute-causal-lift.mjs --limit 50
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
  process.exit(1)
}

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? '200') : 200
const N_CONTROLS = 20
const BOOTSTRAP_ITERS = 800
const VOLUME_TOLERANCE = 5

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── helpers ───────────────────────────────────────────────
function mean(arr) {
  if (!arr.length) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

function quantile(sorted, q) {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function classifyAction(row) {
  const a = (row.action ?? '').toLowerCase()
  const t = (row.target_type ?? '').toLowerCase()
  if (a.includes('publish') && t.includes('blog')) return 'blog_publish'
  if (t.includes('blog')) return 'blog_edit'
  if (a.includes('pin')) return 'pin'
  if (a.includes('category') || t.includes('category')) return 'category_change'
  if (a.includes('community') || a.includes('push') || a.includes('promo')) return 'community_push'
  if (a.includes('ad') || a.includes('expose')) return 'ad_expose'
  return a || 'other'
}

function plcStage(series) {
  if (!series || series.length < 4) return null
  const half = Math.floor(series.length / 2)
  const left = mean(series.slice(0, half))
  const right = mean(series.slice(half))
  if (right > left * 1.25) return 'emerging'
  if (right < left * 0.75) return 'declining'
  return 'mature'
}

function meanInWindow(rows, from, to) {
  const vals = []
  for (const r of rows) {
    const t = new Date(r.collected_at).getTime()
    if (t >= from && t < to) {
      const v = Number(r.volume_relative)
      if (Number.isFinite(v)) vals.push(v)
    }
  }
  return vals.length ? mean(vals) : null
}

function didLift(pinRows, ctrlRows, t0, days) {
  const ms = days * 86400_000
  const pinPre = meanInWindow(pinRows, t0 - ms, t0)
  const pinPost = meanInWindow(pinRows, t0, t0 + ms)
  const ctrlPre = meanInWindow(ctrlRows, t0 - ms, t0)
  const ctrlPost = meanInWindow(ctrlRows, t0, t0 + ms)
  if (pinPre == null || pinPost == null || ctrlPre == null || ctrlPost == null) return null
  return (pinPost - pinPre) - (ctrlPost - ctrlPre)
}

function bootstrapCI(controlPerKwDiffs, pinDelta) {
  // controlPerKwDiffs: 각 control 키워드의 (post-pre) — pinDelta 와 차이의 표본분포로 CI 추정
  if (!controlPerKwDiffs.length) return [null, null]
  const lifts = []
  for (let i = 0; i < BOOTSTRAP_ITERS; i++) {
    const sample = []
    for (let j = 0; j < controlPerKwDiffs.length; j++) {
      sample.push(controlPerKwDiffs[Math.floor(Math.random() * controlPerKwDiffs.length)])
    }
    lifts.push(pinDelta - mean(sample))
  }
  lifts.sort((a, b) => a - b)
  return [quantile(lifts, 0.025), quantile(lifts, 0.975)]
}

// ── main ──────────────────────────────────────────────────
async function main() {
  const t0all = Date.now()

  // 1) 핀 키워드 목록 (target 후보)
  const { data: pinRows, error: pinErr } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, pinned_at')
  if (pinErr) {
    console.error('pin fetch failed:', pinErr.message)
    process.exit(1)
  }
  const pinSet = new Set((pinRows ?? []).map((p) => p.keyword))
  console.log(`pinned keywords: ${pinSet.size}`)

  if (pinSet.size === 0) {
    console.log('no pins — nothing to compute')
    process.exit(0)
  }

  // 2) admin_actions 중 핀 키워드와 연결된 항목 (target_id == keyword 또는 metadata.keyword)
  const since = new Date(Date.now() - 90 * 86400_000).toISOString()
  const { data: actions, error: actErr } = await sb
    .from('jimscanner_admin_actions')
    .select('id, created_at, action, target_type, target_id, summary, metadata')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(LIMIT * 4)
  if (actErr) {
    console.error('action fetch failed:', actErr.message)
    process.exit(1)
  }

  const candidates = []
  for (const a of actions ?? []) {
    const meta = (a.metadata ?? {})
    const kw = pinSet.has(a.target_id ?? '') ? a.target_id
      : (typeof meta === 'object' && pinSet.has(meta.keyword ?? '') ? meta.keyword : null)
    if (!kw) continue
    candidates.push({ ...a, pin_keyword: kw })
    if (candidates.length >= LIMIT) break
  }
  console.log(`candidate actions: ${candidates.length}`)

  if (candidates.length === 0) {
    console.log('no pin-linked actions in last 90d — done')
    process.exit(0)
  }

  // 3) 핀 키워드 시계열 (한 번에 fetch)
  const pinKeywords = [...new Set(candidates.map((c) => c.pin_keyword))]
  const earliestT0 = Math.min(...candidates.map((c) => new Date(c.created_at).getTime()))
  const windowSince = new Date(earliestT0 - 35 * 86400_000).toISOString()

  const { data: pinSeries } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category_top, volume_relative, collected_at')
    .in('keyword', pinKeywords)
    .gte('collected_at', windowSince)
    .limit(50_000)

  const pinSeriesByKw = new Map()
  for (const r of pinSeries ?? []) {
    if (!pinSeriesByKw.has(r.keyword)) pinSeriesByKw.set(r.keyword, [])
    pinSeriesByKw.get(r.keyword).push(r)
  }

  // 4) 각 후보에 대해 합성대조군 + DiD
  let upserted = 0
  for (const cand of candidates) {
    const t0 = new Date(cand.created_at).getTime()
    const pinRowsKw = pinSeriesByKw.get(cand.pin_keyword) ?? []
    if (pinRowsKw.length < 3) continue

    const category_top = pinRowsKw[0]?.category_top ?? null

    // 핀 키워드의 pre-period 평균 volume — 매칭 기준
    const preMean = meanInWindow(pinRowsKw, t0 - 28 * 86400_000, t0)
    if (preMean == null) continue

    // 합성대조군: 같은 category_top, 비핀, volume_relative pre 평균이 ±5 이내인 N=20
    const ctrlFrom = new Date(t0 - 35 * 86400_000).toISOString()
    const ctrlTo = new Date(t0 + 35 * 86400_000).toISOString()
    let ctrlQuery = sb
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top, volume_relative, collected_at')
      .gte('collected_at', ctrlFrom)
      .lte('collected_at', ctrlTo)
      .limit(20_000)
    if (category_top) ctrlQuery = ctrlQuery.eq('category_top', category_top)
    const { data: ctrlCandidates } = await ctrlQuery

    const byKw = new Map()
    for (const r of ctrlCandidates ?? []) {
      if (pinSet.has(r.keyword)) continue
      if (r.keyword === cand.pin_keyword) continue
      if (!byKw.has(r.keyword)) byKw.set(r.keyword, [])
      byKw.get(r.keyword).push(r)
    }

    const matched = []
    for (const [kw, rows] of byKw) {
      const m = meanInWindow(rows, t0 - 28 * 86400_000, t0)
      if (m == null) continue
      if (Math.abs(m - preMean) > VOLUME_TOLERANCE) continue
      matched.push({ keyword: kw, rows, preMean: m })
      if (matched.length >= N_CONTROLS) break
    }

    if (matched.length < 3) continue // 합성대조군 부족

    const ctrlAllRows = matched.flatMap((m) => m.rows)

    const lift7 = didLift(pinRowsKw, ctrlAllRows, t0, 7)
    const lift28 = didLift(pinRowsKw, ctrlAllRows, t0, 28)

    // bootstrap CI: 각 control 키워드의 28d delta 표본
    const ctrlDeltas = []
    for (const m of matched) {
      const pre = meanInWindow(m.rows, t0 - 28 * 86400_000, t0)
      const post = meanInWindow(m.rows, t0, t0 + 28 * 86400_000)
      if (pre != null && post != null) ctrlDeltas.push(post - pre)
    }
    const pinPre = meanInWindow(pinRowsKw, t0 - 28 * 86400_000, t0)
    const pinPost = meanInWindow(pinRowsKw, t0, t0 + 28 * 86400_000)
    const pinDelta = pinPre != null && pinPost != null ? pinPost - pinPre : null

    let ci_lo = null
    let ci_hi = null
    let is_significant = false
    if (pinDelta != null) {
      ;[ci_lo, ci_hi] = bootstrapCI(ctrlDeltas, pinDelta)
      if (ci_lo != null && ci_hi != null) {
        is_significant = (ci_lo > 0) || (ci_hi < 0)
      }
    }

    const series = pinRowsKw
      .slice()
      .sort((a, b) => a.collected_at.localeCompare(b.collected_at))
      .map((r) => Number(r.volume_relative))
      .filter((v) => Number.isFinite(v))

    const row = {
      action_id: cand.id,
      pin_id: cand.pin_keyword,
      action_type: classifyAction(cand),
      action_at: cand.created_at,
      category_top,
      plc_stage: plcStage(series),
      lift_volume_7d: lift7,
      lift_volume_28d: lift28,
      ci_lo,
      ci_hi,
      is_significant,
      control_set: matched.map((m) => m.keyword),
      control_size: matched.length,
      computed_at: new Date().toISOString(),
    }

    const { error: upErr } = await sb
      .from('jimscanner_actions_lift_cache')
      .upsert(row, { onConflict: 'action_id' })
    if (upErr) {
      console.warn(`  upsert failed for action ${cand.id}: ${upErr.message}`)
      continue
    }
    upserted++
  }

  console.log(`done — upserted ${upserted}/${candidates.length} in ${Date.now() - t0all}ms`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
