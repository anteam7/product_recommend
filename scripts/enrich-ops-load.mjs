#!/usr/bin/env node
/**
 * 위탁 운영부하 게이트 — ops_load enrich (로컬 전용)
 *
 * (a) 카테고리 prior: trends_ops_load_priors(category_mid)
 * (b) 텍스트 신호: jimscanner_trends_raw(82cook/natepan/dcinside/ppomppu) 본문에서
 *     반품/교환/환불/불량/사이즈안맞/호환되나요/어떻게쓰는 류 밀도 추출
 * (a)+(b) → ops_load_score(0~100) → jimscanner_trends_scores.score_components.ops_load
 *
 * recompute 직후 / scores 산출 후에 돌린다. final_score 는 건드리지 않고
 * 최신 score row 의 score_components.ops_load 만 갱신(게이트 표시용).
 *
 * 호출:
 *   node --env-file=.env.local scripts/enrich-ops-load.mjs
 *
 * 로직 원본(타입): src/lib/trend-radar/ops-load.ts — 변경 시 동기화.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const OPS_LOAD_THRESHOLD = 45
const LOW_LOAD_DEFAULT = { return_rate_prior: 0.05, inquiry_rate_prior: 0.08 }
const COMMUNITY_SOURCES = ['82cook', 'natepan', 'dcinside', 'ppomppu']

// src/lib/trend-radar/ops-load.ts FALLBACK_CATEGORY_PRIORS 동기화
const FALLBACK_PRIORS = [
  { match: /의류|옷|패션|티셔츠|바지|원피스|이너|속옷|언더웨어|브라/, return_rate_prior: 0.35, inquiry_rate_prior: 0.15 },
  { match: /신발|운동화|구두|샌들|슬리퍼/, return_rate_prior: 0.4, inquiry_rate_prior: 0.15 },
  { match: /케이블|충전|어댑터|젠더|액세서리|호환|거치대|마운트/, return_rate_prior: 0.12, inquiry_rate_prior: 0.45 },
  { match: /조립|설치|가구|선반|책상|행거|diy|디아이와이/, return_rate_prior: 0.15, inquiry_rate_prior: 0.4 },
  { match: /전자|가전|디지털|이어폰|블루투스|스마트/, return_rate_prior: 0.12, inquiry_rate_prior: 0.3 },
]

const TEXT_PATTERNS = [
  { re: /반품/g, weight: 2 },
  { re: /교환/g, weight: 1.5 },
  { re: /환불/g, weight: 1.5 },
  { re: /불량/g, weight: 2 },
  { re: /파손|깨졌|찢어/g, weight: 1.5 },
  { re: /사이즈\s*안\s*맞|사이즈가\s*안|작아요|커요|크게\s*나/g, weight: 2 },
  { re: /호환\s*되나요|호환되|맞나요|연결\s*되나요/g, weight: 1.5 },
  { re: /어떻게\s*쓰|사용법|사용\s*방법|설명서|작동\s*안/g, weight: 1.5 },
  { re: /설치\s*어떻게|조립\s*어떻|설치가\s*안/g, weight: 1.5 },
  { re: /문의|cs|고객센터|배송\s*언제/gi, weight: 1 },
]

function lookupPrior(priorsMap, categoryMid) {
  if (categoryMid) {
    const exact = priorsMap.get(categoryMid)
    if (exact) return exact
    for (const p of FALLBACK_PRIORS) {
      if (p.match.test(categoryMid)) return { return_rate_prior: p.return_rate_prior, inquiry_rate_prior: p.inquiry_rate_prior }
    }
  }
  return { ...LOW_LOAD_DEFAULT }
}

function computeTextSignal(text) {
  if (!text) return { signal_hits: 0, signal_density: 0 }
  let weighted = 0
  for (const p of TEXT_PATTERNS) {
    const m = text.match(p.re)
    if (m) weighted += m.length * p.weight
  }
  const per1000 = (weighted / Math.max(text.length, 1)) * 1000
  const density = Math.max(0, Math.min(1, per1000 / 10))
  return { signal_hits: Math.round(weighted), signal_density: Number(density.toFixed(3)) }
}

function synthesize({ return_prior, inquiry_prior, signal_density, signal_hits }) {
  const priorAvg = (return_prior + inquiry_prior) / 2
  const score = Math.round(priorAvg * 100 * 0.5 + signal_density * 100 * 0.5)
  return {
    score: Math.max(0, Math.min(100, score)),
    return_prior,
    inquiry_prior,
    signal_density,
    signal_hits,
  }
}

// 커뮤니티 raw payload 에서 텍스트를 추출 (스키마 자유 — title/content/body/text 류 수집)
function extractText(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  const parts = []
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return
    if (typeof v === 'string') { parts.push(v); return }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (/title|content|body|text|subject|comment|post|desc/i.test(k)) walk(v[k], depth + 1)
      }
    }
  }
  walk(payload, 0)
  return parts.join(' ')
}

async function main() {
  // 1) prior 로드
  const priorsMap = new Map()
  {
    const { data, error } = await sb.from('trends_ops_load_priors').select('category_mid, return_rate_prior, inquiry_rate_prior')
    if (error) console.warn('priors load 실패(fallback 사용):', error.message)
    for (const r of data ?? []) priorsMap.set(r.category_mid, { return_rate_prior: Number(r.return_rate_prior), inquiry_rate_prior: Number(r.inquiry_rate_prior) })
  }
  console.log(`prior ${priorsMap.size}건 로드`)

  // 2) 커뮤니티 raw 텍스트 → 전역 신호 밀도 (브랜드 미연결이라 카테고리 무관 base 신호로 사용)
  const { data: rawRows } = await sb
    .from('jimscanner_trends_raw')
    .select('source, payload, collected_at')
    .in('source', COMMUNITY_SOURCES)
    .order('collected_at', { ascending: false })
    .limit(2000)
  let corpus = ''
  for (const r of rawRows ?? []) corpus += ' ' + extractText(r.payload)
  const globalSignal = computeTextSignal(corpus)
  console.log(`커뮤니티 raw ${rawRows?.length ?? 0}건 · 신호 hits=${globalSignal.signal_hits} density=${globalSignal.signal_density}`)

  // 3) 최신 score row 마다 ops_load 합성·upsert
  const { data: products } = await sb.from('jimscanner_trends_products').select('id, category_mid')
  let updated = 0
  for (const p of products ?? []) {
    const { data: scoreRows } = await sb
      .from('jimscanner_trends_scores')
      .select('id, score_components')
      .eq('product_id', p.id)
      .order('computed_at', { ascending: false })
      .limit(1)
    const row = scoreRows?.[0]
    if (!row) continue

    const prior = lookupPrior(priorsMap, p.category_mid)
    const ops = synthesize({
      return_prior: prior.return_rate_prior,
      inquiry_prior: prior.inquiry_rate_prior,
      signal_density: globalSignal.signal_density,
      signal_hits: globalSignal.signal_hits,
    })
    const components = { ...(row.score_components ?? {}), ops_load: ops }
    const { error } = await sb.from('jimscanner_trends_scores').update({ score_components: components }).eq('id', row.id)
    if (error) { console.warn(`update 실패 ${p.id}:`, error.message); continue }
    updated++
  }
  console.log(`ops_load 갱신 완료: ${updated}개 product (임계 ${OPS_LOAD_THRESHOLD})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
