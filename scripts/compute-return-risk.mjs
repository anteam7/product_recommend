#!/usr/bin/env node
/**
 * 예상 반품률 리스크 게이트 — 후보별 return_risk_score(0~100) 산출 (로컬 cron).
 *
 * 입력:
 *   ① jimscanner_category_return_rates  — 카테고리 베이스율 + 위험 수식어 가중치
 *   ② jimscanner_trends_aliases / jimscanner_trends_keywords — 위험 수식어 빈도 신호
 *   ③ jimscanner_market_signals (pain_point / 하자·리콜) — 가산
 * 출력:
 *   jimscanner_return_risk (시계열 insert)
 *
 * 호출:
 *   node --env-file=.env.local scripts/compute-return-risk.mjs
 *
 * 규칙 엔진 기본. LLM 보강은 선택(아직 미구현 — 규칙 점수로 충분히 게이트 가능).
 * run-crons.mjs 마지막 단계에 spawn 추가 권장.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const PRODUCT_LIMIT = 2000
const MAX_RETURN_RATE = 25 // score=100 → 반품률 25% 상한 (src/lib/coupang/price.ts 와 동일 가정)

function gateOf(score) {
  if (score >= 65) return 'high'
  if (score >= 35) return 'medium'
  return 'low'
}

async function fetchCategoryConfig() {
  const { data } = await sb
    .from('jimscanner_category_return_rates')
    .select('category_top, category_mid, base_return_rate, risk_label, modifier_weights')
  const exact = new Map() // `${top}|${mid}` → cfg
  const topDefault = new Map() // top → cfg
  for (const r of data ?? []) {
    if (r.category_mid) exact.set(`${r.category_top}|${r.category_mid}`, r)
    else topDefault.set(r.category_top, r)
  }
  return { exact, topDefault }
}

function pickConfig(cfg, top, mid) {
  return (
    (mid && cfg.exact.get(`${top}|${mid}`)) ||
    cfg.topDefault.get(top) ||
    cfg.topDefault.get('other') || {
      base_return_rate: 6,
      risk_label: 'low',
      modifier_weights: {},
    }
  )
}

async function fetchProducts() {
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid')
    .order('last_seen_at', { ascending: false })
    .limit(PRODUCT_LIMIT)
  return data ?? []
}

async function fetchAliasText(productIds) {
  const map = new Map() // product_id → 합친 텍스트
  const CHUNK = 200
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const ids = productIds.slice(i, i + CHUNK)
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias')
      .in('product_id', ids)
    for (const r of data ?? []) {
      map.set(r.product_id, `${map.get(r.product_id) ?? ''} ${r.alias ?? ''}`)
    }
  }
  return map
}

// market_signals 의 pain_point/하자/리콜 키워드 → 카테고리별 가산 점수
async function fetchSignalBoost() {
  const { data } = await sb
    .from('jimscanner_market_signals')
    .select('signal_type, category, keywords, description, frequency')
    .in('signal_type', ['pain_point', 'gov_notice'])
    .limit(1000)
  // category 별 누적 가산 (최대 20)
  const boost = new Map()
  const RISK_WORDS = ['하자', '불량', '리콜', '반품', '교환', '변질', '고장', '환불']
  for (const s of data ?? []) {
    const text = `${s.description ?? ''} ${(s.keywords ?? []).join(' ')}`
    const hit = RISK_WORDS.some((w) => text.includes(w))
    if (!hit) continue
    const key = s.category ?? '_'
    boost.set(key, Math.min(20, (boost.get(key) ?? 0) + 4 + Math.min(6, (s.frequency ?? 1))))
  }
  return boost
}

function computeRow(p, cfg, aliasText, signalBoost) {
  const c = pickConfig(cfg, p.category_top, p.category_mid)
  // ① 베이스: 반품률(%) → 0~55 스케일 (25% 반품률을 55점에 매핑, 상한)
  const baseComponent = Math.min(55, (Number(c.base_return_rate) / MAX_RETURN_RATE) * 55)

  // ② 위험 수식어 빈도 가산 (검색어/별칭 텍스트에서 매칭)
  const text = `${p.canonical_name ?? ''} ${aliasText ?? ''}`
  const weights = c.modifier_weights ?? {}
  const matched = {}
  let modifierComponent = 0
  for (const [word, w] of Object.entries(weights)) {
    if (text.includes(word)) {
      matched[word] = (matched[word] ?? 0) + 1
      modifierComponent += Number(w)
    }
  }
  modifierComponent = Math.min(35, modifierComponent)

  // ③ 시장 시그널 가산 (해당 카테고리 또는 전체)
  const signalComponent = Math.min(
    20,
    (signalBoost.get(p.category_mid) ?? 0) +
      (signalBoost.get(p.category_top) ?? 0) +
      (signalBoost.get('_') ?? 0) * 0.5,
  )

  const score = Math.round(Math.min(100, baseComponent + modifierComponent + signalComponent))
  const expectedReturnRate = +((score / 100) * MAX_RETURN_RATE).toFixed(1)

  return {
    product_id: p.id,
    return_risk_score: score,
    base_component: +baseComponent.toFixed(1),
    modifier_component: +modifierComponent.toFixed(1),
    signal_component: +signalComponent.toFixed(1),
    gate: gateOf(score),
    expected_return_rate: expectedReturnRate,
    risk_label: c.risk_label ?? null,
    risk_components: { matched_modifiers: matched, category_mid: p.category_mid ?? null },
    computed_by: 'rule_engine',
  }
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] compute-return-risk start`)

  const cfg = await fetchCategoryConfig()
  if (cfg.topDefault.size === 0 && cfg.exact.size === 0) {
    console.error('  설정 없음 — supabase/return_risk_gate.sql 먼저 적용 필요')
    process.exit(1)
  }

  const products = await fetchProducts()
  if (products.length === 0) {
    console.log('  대상 상품 없음')
    return
  }
  console.log(`  products: ${products.length}`)

  const aliasText = await fetchAliasText(products.map((p) => p.id))
  const signalBoost = await fetchSignalBoost()

  const rows = products.map((p) => computeRow(p, cfg, aliasText.get(p.id), signalBoost))

  // 배치 insert
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    const { error } = await sb.from('jimscanner_return_risk').insert(batch)
    if (error) {
      console.error(`  insert 실패: ${error.message}`)
      break
    }
    inserted += batch.length
  }

  const high = rows.filter((r) => r.gate === 'high').length
  const med = rows.filter((r) => r.gate === 'medium').length
  console.log(
    `[${new Date().toISOString()}] done — ${inserted} rows (high=${high}, medium=${med}), ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
