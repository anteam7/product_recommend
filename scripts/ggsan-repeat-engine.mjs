#!/usr/bin/env node
/**
 * 재구매 엔진 점수 적재 — 소진주기 × 수요안정성 × 함량당가성비
 * (supabase/ggsan_repeat_engine.sql 의 jimscanner_ggsan_repeat 채움)
 *
 * 파이프라인:
 *   ① consumption_cycle_days = content_units / content_per_day
 *        - content_units: 제목/디테일에서 '60정·90캡슐·30포·30회분' 추출
 *        - content_per_day: '1일 1~2정/회' 추출, 기본 1
 *   ② demand_cv = stddev/mean ( jimscanner_trends_keywords.volume_relative 시계열 )
 *        - ggsan 제목과 trigram 으로 매칭되는 수요 키워드의 일자별 volume_relative
 *   ③ repeat_engine_score = est_monthly_reorder × (demand_stability/100) × value_factor
 *
 * 사용법:
 *   node --env-file=.env.local scripts/ggsan-repeat-engine.mjs
 *   node --env-file=.env.local scripts/ggsan-repeat-engine.mjs --limit 50
 *
 * run-crons.mjs 의 classify 단계 뒤에 로컬로 호출됨.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = readFileSync('.env.local', 'utf-8')
  .split('\n')
  .reduce((acc, line) => {
    const m = line.match(/^([A-Z_0-9]+)\s*=\s*"?([^"]+)"?$/)
    if (m) acc[m[1]] = m[2]
    return acc
  }, {})

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 1000 : 1000

// ── 용량/입수량 추출 ─────────────────────────────────────────
// '60정', '90 캡슐', '30포', '120 tablets', '30회분' 등에서 최댓값(=1통 입수량) 채택.
function extractContentUnits(text) {
  if (!text) return null
  const units = []
  const re = /(\d{1,4})\s*(정|캡슐|capsule|tablets?|포|스틱|회분|개입|환)/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1])
    if (n >= 5 && n <= 2000) units.push(n) // 5~2000 범위만 (단가/날짜 오탐 방지)
  }
  if (units.length === 0) return null
  return Math.max(...units)
}

// '1일 1~2정', '하루 2회', '1일 1회 1정' → 일일 섭취 단위 수. 기본 1.
function extractPerDay(text) {
  if (!text) return 1
  const m = text.match(/(?:1일|하루)\s*(\d)\s*(?:~|-|회|번)?\s*(\d)?/)
  if (m) {
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    const avg = (a + b) / 2
    if (avg >= 1 && avg <= 6) return avg
  }
  return 1
}

// 수요 시계열의 변동계수(CV)
function cv(values) {
  const xs = values.filter((v) => typeof v === 'number' && !Number.isNaN(v))
  if (xs.length < 2) return null
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  if (mean <= 0) return null
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length
  return Math.sqrt(variance) / mean
}

// trigram 유사 매칭 (간이): 키워드의 글자 중 절반 이상이 제목에 포함되면 매칭
function looseMatch(keyword, title) {
  if (!keyword || !title) return false
  const k = keyword.replace(/\s+/g, '')
  if (k.length < 2) return false
  if (title.includes(k)) return true
  const chars = [...new Set(k.split(''))]
  const hit = chars.filter((c) => title.includes(c)).length
  return hit / chars.length >= 0.7
}

async function main() {
  console.log(`[repeat-engine] start (limit=${LIMIT})`)

  // 1) ggsan 상품
  const { data: products, error: pErr } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, raw_payload, status')
    .neq('status', 'removed')
    .limit(LIMIT)
  if (pErr) throw pErr
  console.log(`[repeat-engine] products: ${products.length}`)

  // 2) 수요 키워드 시계열 (검색·쇼핑 시그널, 최근 60일)
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString()
  const { data: kws, error: kErr } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative, collected_at')
    .in('source', ['naver_search_trend', 'naver_shopping_hot'])
    .gte('collected_at', since)
    .not('volume_relative', 'is', null)
    .limit(20000)
  if (kErr) throw kErr

  // 키워드별 시계열 집계
  const seriesByKw = new Map()
  for (const r of kws ?? []) {
    if (!seriesByKw.has(r.keyword)) seriesByKw.set(r.keyword, [])
    seriesByKw.get(r.keyword).push(Number(r.volume_relative))
  }
  // 키워드별 CV 사전계산
  const kwStats = [...seriesByKw.entries()].map(([keyword, vals]) => ({
    keyword,
    cv: cv(vals),
    samples: vals.length,
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
  }))
  console.log(`[repeat-engine] demand keywords: ${kwStats.length}`)

  const rows = []
  for (const p of products) {
    const text = `${p.title ?? ''} ${typeof p.raw_payload === 'string' ? p.raw_payload : JSON.stringify(p.raw_payload ?? '')}`
    const contentUnits = extractContentUnits(text)
    const perDay = extractPerDay(text)
    const cycleDays = contentUnits ? Math.round((contentUnits / perDay) * 10) / 10 : null
    const estMonthly = cycleDays && cycleDays > 0 ? Math.round((30 / cycleDays) * 100) / 100 : null

    // 수요 안정성: 제목과 매칭되는 키워드 중 mean 이 가장 큰 것 채택
    let best = null
    for (const s of kwStats) {
      if (s.cv == null) continue
      if (!looseMatch(s.keyword, p.title ?? '')) continue
      if (!best || s.mean > best.mean) best = s
    }
    const demandCv = best ? Math.round(best.cv * 1000) / 1000 : null
    const demandStability = demandCv != null ? Math.round(100 * (1 - Math.min(demandCv, 1)) * 10) / 10 : null

    // 함량당 가성비 (#13 proxy): 정수 / 가격 * 1000
    const valuePerContent =
      contentUnits && p.price_krw ? Math.round((contentUnits / p.price_krw) * 1000 * 1000) / 1000 : null

    // value_factor: 가성비를 0.5~1.5 범위로 완만 보정 (없으면 1)
    const valueFactor = valuePerContent != null ? Math.min(1.5, Math.max(0.5, 0.5 + valuePerContent)) : 1
    const stabilityFactor = demandStability != null ? demandStability / 100 : 0.5

    const repeatScore =
      estMonthly != null
        ? Math.round(estMonthly * stabilityFactor * valueFactor * 100) / 100
        : null

    rows.push({
      goods_no: p.goods_no,
      content_units: contentUnits,
      content_per_day: perDay,
      consumption_cycle_days: cycleDays,
      est_monthly_reorder: estMonthly,
      demand_cv: demandCv,
      demand_samples: best ? best.samples : null,
      demand_stability: demandStability,
      demand_top_keyword: best ? best.keyword : null,
      value_per_content: valuePerContent,
      repeat_engine_score: repeatScore,
      components: {
        per_day: perDay,
        value_factor: Math.round(valueFactor * 1000) / 1000,
        stability_factor: Math.round(stabilityFactor * 1000) / 1000,
      },
      computed_at: new Date().toISOString(),
    })
  }

  // 점수 산출 가능한(=소진주기 추출된) 것만 upsert
  const upsertable = rows.filter((r) => r.consumption_cycle_days != null)
  console.log(`[repeat-engine] computed: ${rows.length}, upsertable(주기추출): ${upsertable.length}`)

  // 배치 upsert
  for (let i = 0; i < upsertable.length; i += 200) {
    const chunk = upsertable.slice(i, i + 200)
    const { error } = await sb.from('jimscanner_ggsan_repeat').upsert(chunk, { onConflict: 'goods_no' })
    if (error) throw error
  }

  const withDemand = upsertable.filter((r) => r.demand_stability != null).length
  console.log(`[repeat-engine] done — upserted ${upsertable.length} (수요안정성 매칭 ${withDemand})`)
}

main().catch((e) => {
  console.error('[repeat-engine] FATAL', e)
  process.exit(1)
})
