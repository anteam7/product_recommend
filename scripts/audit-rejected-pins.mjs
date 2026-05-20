#!/usr/bin/env node
/**
 * Rejected Pin 사후 후회 감사 (False-Negative Audit)
 *
 * 거절된 키워드/canonical product 를 30/60/90일 후 재평가:
 *   (a) naver_tvtime 재편성        — collect-naver-tvtime 결과에서 키워드 재출현
 *   (b) ggsan 재입고/가격 인하     — jimscanner_ggsan_* 카탈로그 시그널
 *   (c) SERP 경쟁자 진입 증가      — google_suggest / serp 결과 (있으면)
 *   (d) news/blog 인입 속도 가속   — collect-naver-news / collect-naver-blog 카운트
 *
 * 호출:
 *   node --env-file=.env.local scripts/audit-rejected-pins.mjs
 *
 * 결과:
 *   jimscanner_trends_regret_audits 에 audited_at=now() 로 upsert.
 *   동일 (target_type, target_key, age_days) 가 24시간 내 있으면 skip.
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

const AGE_BUCKETS = [30, 60, 90] // days
const TOLERANCE_DAYS = 7         // 30±7, 60±7, 90±7

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
}

function pickBucket(ageDays) {
  for (const bucket of AGE_BUCKETS) {
    if (Math.abs(ageDays - bucket) <= TOLERANCE_DAYS) return bucket
  }
  return null
}

/** 0~100 점수 산출. 시그널 가중치 합. */
function computeRegretScore(signals) {
  let score = 0
  if (signals.tvtime_reappearance > 0) score += Math.min(35, signals.tvtime_reappearance * 12)
  if (signals.ggsan_restock) score += 15
  if (signals.ggsan_price_drop_pct > 0) score += Math.min(15, signals.ggsan_price_drop_pct)
  if (signals.serp_competitor_growth > 0) score += Math.min(15, signals.serp_competitor_growth * 5)
  if (signals.news_velocity > 0) score += Math.min(10, signals.news_velocity * 2)
  if (signals.blog_velocity > 0) score += Math.min(10, signals.blog_velocity * 2)
  return Math.max(0, Math.min(100, Math.round(score)))
}

/** keyword 단위: 거절 이후의 신호 카운트. */
async function evaluateKeyword(keyword, decidedAt) {
  const sinceISO = decidedAt.toISOString()
  const signals = {}

  // (a) naver_tvtime 재편성 — keyword 가 product_name/keyword 컬럼에 등장
  const tvRes = await sb
    .from('jimscanner_naver_tvtime_pushes')
    .select('id', { count: 'exact', head: true })
    .gte('aired_at', sinceISO)
    .ilike('product_name', `%${keyword}%`)
  signals.tvtime_reappearance = tvRes.count ?? 0

  // (b) ggsan 시그널 — 재입고/가격 인하. 테이블 존재 여부 모르므로 try/catch.
  try {
    const ggRes = await sb
      .from('jimscanner_ggsan_products')
      .select('id, in_stock, price_krw, updated_at')
      .ilike('product_name', `%${keyword}%`)
      .gte('updated_at', sinceISO)
      .limit(5)
    if (ggRes.data && ggRes.data.length > 0) {
      signals.ggsan_restock = ggRes.data.some((r) => r.in_stock)
      signals.ggsan_price_drop_pct = 0 // 가격 이력 테이블 없으면 0
    } else {
      signals.ggsan_restock = false
      signals.ggsan_price_drop_pct = 0
    }
  } catch {
    signals.ggsan_restock = false
    signals.ggsan_price_drop_pct = 0
  }

  // (c) SERP 경쟁자 — google_suggest 결과 증가 비율 (간단히 카운트 차이 비율)
  try {
    const gsRes = await sb
      .from('jimscanner_google_suggest')
      .select('id', { count: 'exact', head: true })
      .ilike('seed', `%${keyword}%`)
      .gte('collected_at', sinceISO)
    signals.serp_competitor_growth = (gsRes.count ?? 0) > 5 ? 1.5 : (gsRes.count ?? 0) > 1 ? 0.5 : 0
  } catch {
    signals.serp_competitor_growth = 0
  }

  // (d) news/blog 인입 속도
  try {
    const newsRes = await sb
      .from('jimscanner_naver_news')
      .select('id', { count: 'exact', head: true })
      .ilike('title', `%${keyword}%`)
      .gte('published_at', sinceISO)
    const ageDays = Math.max(1, daysBetween(decidedAt, new Date()))
    signals.news_velocity = +(((newsRes.count ?? 0) / ageDays).toFixed(2))
  } catch {
    signals.news_velocity = 0
  }
  try {
    const blogRes = await sb
      .from('jimscanner_naver_blog')
      .select('id', { count: 'exact', head: true })
      .ilike('title', `%${keyword}%`)
      .gte('published_at', sinceISO)
    const ageDays = Math.max(1, daysBetween(decidedAt, new Date()))
    signals.blog_velocity = +(((blogRes.count ?? 0) / ageDays).toFixed(2))
  } catch {
    signals.blog_velocity = 0
  }

  return signals
}

async function loadDecisions() {
  // 1) 명시적 reject 결정 (있으면)
  const explicit = await sb
    .from('jimscanner_trends_pin_decisions')
    .select('id, target_type, target_key, source, decision, reason_code, decided_at')
    .eq('decision', 'reject')
    .order('decided_at', { ascending: false })
    .limit(500)

  const explicitRows = (explicit.data ?? []).map((d) => ({
    decision_id: d.id,
    target_type: d.target_type,
    target_key: d.target_key,
    source: d.source,
    decided_at: new Date(d.decided_at),
    reason_code: d.reason_code,
    via: 'explicit',
  }))

  // 2) proxy reject — 분류됐는데 pinned=false. view 가 없을 수도 있으므로 직접 쿼리.
  const proxy = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, classified_intent, collected_at, pinned')
    .eq('pinned', false)
    .not('classified_intent', 'is', null)
    .order('collected_at', { ascending: false })
    .limit(2000)

  const seen = new Set(explicitRows.map((r) => `${r.target_type}::${r.target_key}`))
  const proxyRows = []
  const proxyDedup = new Set()
  for (const r of proxy.data ?? []) {
    const k = `keyword::${r.keyword}::${r.source}`
    if (proxyDedup.has(k)) continue
    proxyDedup.add(k)
    if (seen.has(`keyword::${r.keyword}`)) continue
    proxyRows.push({
      decision_id: null,
      target_type: 'keyword',
      target_key: r.keyword,
      source: r.source,
      decided_at: new Date(r.collected_at),
      reason_code: null,
      via: 'proxy',
    })
  }

  return [...explicitRows, ...proxyRows]
}

async function recentAuditExists(targetType, targetKey, ageDays) {
  const sinceISO = new Date(Date.now() - DAY_MS).toISOString()
  const { count } = await sb
    .from('jimscanner_trends_regret_audits')
    .select('id', { count: 'exact', head: true })
    .eq('target_type', targetType)
    .eq('target_key', targetKey)
    .eq('age_days', ageDays)
    .gte('audited_at', sinceISO)
  return (count ?? 0) > 0
}

async function main() {
  const t0 = Date.now()
  console.log('[audit-rejected-pins] start')

  const decisions = await loadDecisions()
  console.log(`  decisions loaded: ${decisions.length}`)

  const now = new Date()
  let evaluated = 0
  let inserted = 0
  let skippedAge = 0
  let skippedRecent = 0

  for (const d of decisions) {
    const ageDays = daysBetween(d.decided_at, now)
    const bucket = pickBucket(ageDays)
    if (bucket === null) {
      skippedAge++
      continue
    }

    if (await recentAuditExists(d.target_type, d.target_key, bucket)) {
      skippedRecent++
      continue
    }

    let signals = {}
    if (d.target_type === 'keyword') {
      signals = await evaluateKeyword(d.target_key, d.decided_at)
    } else {
      // product 단위는 후속 PR. 우선 keyword 만.
      continue
    }
    const regretScore = computeRegretScore(signals)
    evaluated++

    const { error } = await sb
      .from('jimscanner_trends_regret_audits')
      .insert({
        decision_id: d.decision_id,
        target_type: d.target_type,
        target_key: d.target_key,
        age_days: bucket,
        regret_score: regretScore,
        signals,
        notes: d.via === 'proxy' ? 'proxy: keywords.pinned=false' : null,
      })
    if (error) {
      console.warn(`  insert error for ${d.target_key}:`, error.message)
    } else {
      inserted++
    }
  }

  const dt = Date.now() - t0
  console.log(
    `[audit-rejected-pins] done: evaluated=${evaluated} inserted=${inserted} skippedAge=${skippedAge} skippedRecent=${skippedRecent} duration=${dt}ms`,
  )
}

main().catch((e) => {
  console.error('[audit-rejected-pins] fatal:', e)
  process.exit(1)
})
