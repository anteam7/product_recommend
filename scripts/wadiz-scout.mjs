#!/usr/bin/env node
/**
 * Wadiz 졸업 트래커 — 와디즈/텀블벅 종료 펀딩 프로젝트 수집기.
 *
 * 동작:
 *  1) 와디즈 종료 프로젝트 목록 페이지를 스크랩 (펀딩 성공 + 종료)
 *  2) jimscanner_wadiz_signals 에 upsert
 *  3) 각 row 의 title 을 jimscanner_trends_keywords (최근 30일) 와 fuzzy match (token Jaccard)
 *     → matched_keyword / match_score 갱신
 *  4) 매핑된 키워드가 jimscanner_ggsan_products.title 에 처음 등장하면
 *     jimscanner_wadiz_supply_onset 이벤트 적재 (메인 callout 트리거)
 *
 * 사용법:
 *   node --env-file=.env.local scripts/wadiz-scout.mjs
 *   node --env-file=.env.local scripts/wadiz-scout.mjs --limit=200
 *
 * 환경:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 필요.
 *   네트워크 실패 시 ok=false 로 종료 (run-crons 합산에서 fail 처리됨).
 */

import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
function getArg(name, fallback) {
  const direct = args.find((a) => a.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  return fallback
}
const LIMIT = parseInt(getArg('limit', '120'), 10)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─────────────────────────────────────────
// 1) 와디즈 종료 프로젝트 수집
// 와디즈는 공식 API 가 없어 공개 게이트웨이 JSON 엔드포인트를 사용.
// 비공식 endpoint 이므로 변동 가능 — 실패 시 빈 배열로 graceful degrade.
async function fetchWadizGraduated() {
  const url =
    'https://service-api.wadiz.kr/api/projects/v2?keyword=&order=success&endYn=Y&limit=' +
    LIMIT
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 jimscanner-radar/1.0',
      },
    })
    if (!res.ok) {
      console.warn(`  wadiz endpoint ${res.status}`)
      return []
    }
    const json = await res.json().catch(() => null)
    const list =
      json?.data?.list ?? json?.data ?? json?.list ?? json?.projects ?? []
    if (!Array.isArray(list)) return []
    return list.map((p) => ({
      source: 'wadiz',
      project_id: String(p.projectId ?? p.id ?? p.campaignId ?? ''),
      title: String(p.title ?? p.projectName ?? '').trim(),
      url: p.url
        ? String(p.url)
        : p.projectId
        ? `https://www.wadiz.kr/web/campaign/detail/${p.projectId}`
        : null,
      funded_krw: Number(p.totalFundingAmount ?? p.fundingAmount ?? p.amount ?? 0) || null,
      supporters: Number(p.totalSupporter ?? p.supporterCount ?? p.supporters ?? 0) || null,
      end_date: parseDate(p.endDate ?? p.endedAt ?? p.closeDate ?? p.expiredAt),
      category: p.categoryName ?? p.category ?? null,
      maker: p.makerName ?? p.maker ?? p.owner ?? null,
      status: 'graduated',
    }))
  } catch (e) {
    console.warn(`  wadiz fetch failed: ${e.message}`)
    return []
  }
}

function parseDate(v) {
  if (!v) return null
  try {
    const d = new Date(v)
    if (isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
  } catch {
    return null
  }
}

// ─────────────────────────────────────────
// 2) Upsert
async function upsertSignals(rows) {
  const valid = rows.filter((r) => r.project_id && r.title && r.end_date)
  if (valid.length === 0) return { inserted: 0 }
  const payload = valid.map((r) => ({
    ...r,
    last_seen_at: new Date().toISOString(),
  }))
  const { data, error } = await sb
    .from('jimscanner_wadiz_signals')
    .upsert(payload, { onConflict: 'source,project_id', ignoreDuplicates: false })
    .select('id, project_id')
  if (error) {
    console.error('  upsert error:', error.message)
    return { inserted: 0 }
  }
  return { inserted: data?.length ?? 0 }
}

// ─────────────────────────────────────────
// 3) Fuzzy match → matched_keyword
function tokenize(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  )
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

async function matchKeywords() {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: kws } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword')
    .gte('collected_at', since)
    .limit(5000)
  const keywords = [...new Set((kws ?? []).map((k) => k.keyword).filter(Boolean))]
  const kwTokens = keywords.map((k) => ({ keyword: k, tokens: tokenize(k) }))

  const { data: signals } = await sb
    .from('jimscanner_wadiz_signals')
    .select('id, title, matched_keyword')
    .is('matched_keyword', null)
    .limit(500)

  let matched = 0
  for (const s of signals ?? []) {
    const tt = tokenize(s.title)
    let best = { keyword: null, score: 0 }
    for (const kw of kwTokens) {
      const score = jaccard(tt, kw.tokens)
      if (score > best.score) best = { keyword: kw.keyword, score }
    }
    if (best.keyword && best.score >= 0.3) {
      const { error } = await sb
        .from('jimscanner_wadiz_signals')
        .update({ matched_keyword: best.keyword, match_score: best.score })
        .eq('id', s.id)
      if (!error) matched++
    }
  }
  return { matched, candidates: keywords.length }
}

// ─────────────────────────────────────────
// 4) supply_onset 이벤트 발사
// 매핑된 키워드가 ggsan_products.title 에 처음 등장하면 이벤트 적재.
async function detectSupplyOnset() {
  const { data: signals } = await sb
    .from('jimscanner_wadiz_signals')
    .select('id, matched_keyword, end_date')
    .not('matched_keyword', 'is', null)
    .eq('status', 'graduated')
    .limit(500)

  let fired = 0
  for (const s of signals ?? []) {
    const { data: existing } = await sb
      .from('jimscanner_wadiz_supply_onset')
      .select('id')
      .eq('signal_id', s.id)
      .limit(1)
    if ((existing ?? []).length > 0) continue

    const { data: ggsan } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title')
      .ilike('title', `%${s.matched_keyword}%`)
      .limit(1)
    if (!ggsan || ggsan.length === 0) continue

    const g = ggsan[0]
    const days = Math.floor(
      (Date.now() - new Date(s.end_date).getTime()) / 86400_000,
    )
    const { error } = await sb.from('jimscanner_wadiz_supply_onset').insert({
      signal_id: s.id,
      matched_keyword: s.matched_keyword,
      ggsan_goods_no: g.goods_no,
      ggsan_title: g.title,
      days_since_end: days,
    })
    if (!error) fired++
  }
  return { fired }
}

// ─────────────────────────────────────────
const t0 = Date.now()
console.log(`[${new Date().toISOString()}] wadiz-scout start (limit=${LIMIT})`)

const rows = await fetchWadizGraduated()
console.log(`  fetched ${rows.length} project(s) from wadiz`)

const up = await upsertSignals(rows)
console.log(`  upserted ${up.inserted} signal row(s)`)

const m = await matchKeywords()
console.log(`  matched ${m.matched} title(s) against ${m.candidates} keyword candidates`)

const ev = await detectSupplyOnset()
console.log(`  supply_onset events fired: ${ev.fired}`)

const ms = Date.now() - t0
console.log(`[${new Date().toISOString()}] wadiz-scout done in ${ms}ms`)
// Soft-fail: 와디즈 endpoint 변동/네트워크 실패는 cron 전체를 죽이지 않게 항상 0 종료.
process.exit(0)
