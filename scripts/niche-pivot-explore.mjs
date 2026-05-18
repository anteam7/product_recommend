#!/usr/bin/env node
/**
 * 속성 피벗 Niche-Down 자동탐색 — 로컬 전용.
 *
 * 입력: parent product_id (또는 미지정 시 final_score 상위 N개 head 후보)
 * 출력: jimscanner_trends_niche_pivots 에 derived_query 5~10개 / parent
 *
 * 호출:
 *   node --env-file=.env.local scripts/niche-pivot-explore.mjs [product_id?] [--limit=5]
 *
 * 1) parent product 의 canonical_name + intent_label + aliases 를 LLM 에 던져
 *    5~10개 axis × value 피벗 후보를 받음
 * 2) 각 피벗 → derived_query 생성
 * 3) derived_query 별 미니 신호 산출 (naver autocomplete BFS 1-hop + alias hit + heuristic)
 * 4) sub_competition / sub_volume_est / sub_intent / score_delta 계산
 * 5) jimscanner_trends_niche_pivots 에 upsert (parent_product_id, derived_query) UNIQUE
 *
 * 미니 재실행은 비용을 낮추기 위해:
 *   - autocomplete: naver suggest API 1-hop (max 10 suggestion)
 *   - SERP density: jimscanner_trends_keywords 안에서 like 매칭으로 row 수
 *   - intent: LLM 결과 그대로 (별도 호출 없이 같은 응답에 포함)
 *
 * 즉, 실제 SERP/autocomplete 풀스캔은 정식 v4 score 파이프라인에 위임하고
 * 본 스크립트는 후보 트리만 빠르게 생성한다.
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const explicitProductId = args.find((a) => /^[0-9a-f]{8}-/i.test(a))
const limitArg = args.find((a) => a.startsWith('--limit='))
const PARENT_LIMIT = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 5) : 5
const MODEL = 'niche_pivot_v1'

const SYSTEM_PROMPT = `한국 위탁 판매 셀러를 위한 niche-down 분기 생성기.
포화된 head 키워드를 5~8개의 narrow-niche 로 쪼개라.

❗ 절대 규칙:
- 응답 첫 글자 '[' 마지막 글자 ']'
- 분석·설명·코드펜스 금지
- 각 항목은 axis × value 조합 1개

각 항목 필드:
- pivot_axis: 'persona' | 'usage_context' | 'spec' | 'channel' | 'price_band'
- pivot_value: 5~12자 한국어 분기명 (예: '임산부', '야간 외출', '무향 스틱', '오피스')
- derived_query: parent 키워드 + pivot 자연어 결합 (예: '임산부 수면영양제', '야간 외출용 차량 청소기')
- sub_intent: 'commerce' | 'info' | 'mixed'
- sub_competition: 0~100 정수 (낮을수록 진입 유리, niche 일수록 낮음)
- sub_volume_est:  0~100 정수 (검색량 추정, niche 일수록 작음)
- rationale: 10자 이내 진입 이유

예시 입력:
parent_name="수면영양제" intent="예방건강" category_top=health aliases=[멜라토닌|글리신|GABA]
예시 출력:
[
 {"pivot_axis":"persona","pivot_value":"임산부","derived_query":"임산부 수면영양제","sub_intent":"info","sub_competition":25,"sub_volume_est":35,"rationale":"안전성 우려"},
 {"pivot_axis":"usage_context","pivot_value":"야간 외출","derived_query":"야간 외출 수면영양제","sub_intent":"commerce","sub_competition":40,"sub_volume_est":20,"rationale":"시차 회복"},
 {"pivot_axis":"spec","pivot_value":"무향 스틱","derived_query":"무향 스틱 수면영양제","sub_intent":"commerce","sub_competition":30,"sub_volume_est":15,"rationale":"휴대성"}
]`

function callClaudeCli(prompt) {
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: childEnv,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 500)}`))
      let parsed
      try { parsed = JSON.parse(stdout) } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed.is_error) {
        return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      }
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

function tryParseJsonArray(text) {
  if (!text) return null
  try { const v = JSON.parse(text); if (Array.isArray(v)) return v } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { try { const v = JSON.parse(fence[1]); if (Array.isArray(v)) return v } catch {} }
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a !== -1 && b !== -1 && b > a) {
    try { const v = JSON.parse(text.slice(a, b + 1)); if (Array.isArray(v)) return v } catch {}
  }
  return null
}

function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(lo, Math.min(hi, n))
}

const VALID_AXIS = new Set(['persona', 'usage_context', 'spec', 'channel', 'price_band'])
const VALID_INTENT = new Set(['commerce', 'info', 'mixed'])

function normalizePivot(o, parentName) {
  if (!o || typeof o !== 'object') return null
  const axis = VALID_AXIS.has(o.pivot_axis) ? o.pivot_axis : null
  const value = typeof o.pivot_value === 'string' ? o.pivot_value.trim().slice(0, 30) : ''
  let derived = typeof o.derived_query === 'string' ? o.derived_query.trim().slice(0, 100) : ''
  if (!axis || !value) return null
  if (!derived) derived = `${value} ${parentName}`.trim()
  const sub_competition = clamp(o.sub_competition, 0, 100)
  const sub_volume_est = clamp(o.sub_volume_est, 0, 100)
  const sub_intent = VALID_INTENT.has(o.sub_intent) ? o.sub_intent : null
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 40) : ''
  return {
    pivot_axis: axis,
    pivot_value: value,
    derived_query: derived,
    sub_competition,
    sub_volume_est,
    sub_intent,
    rationale,
  }
}

async function fetchParentProducts() {
  if (explicitProductId) {
    const { data } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, intent_label, brand, description, alias_count')
      .eq('id', explicitProductId)
      .limit(1)
    return data ?? []
  }
  // final_score 상위 head 후보 — 분류 완료된 것만
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(500)
  const latest = new Map()
  for (const s of scores ?? []) {
    if (!latest.has(s.product_id)) latest.set(s.product_id, s)
  }
  const topIds = [...latest.values()]
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, PARENT_LIMIT)
    .map((s) => s.product_id)
  if (topIds.length === 0) return []
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, intent_label, brand, description, alias_count')
    .in('id', topIds)
    .not('llm_classified_at', 'is', null)
  return data ?? []
}

async function fetchSampleAliases(productId) {
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias')
    .eq('product_id', productId)
    .order('confidence', { ascending: false })
    .limit(5)
  return (data ?? []).map((r) => r.alias)
}

async function computeMiniSignals(derivedQuery, parentScore) {
  // 외부 호출 없이 빠른 미니 신호: jimscanner_trends_keywords like 매칭으로
  // SERP density 대용을 만들고, 거기서 sub_volume_est 보정.
  const like = `%${derivedQuery}%`
  const { count } = await sb
    .from('jimscanner_trends_keywords')
    .select('id', { count: 'exact', head: true })
    .ilike('keyword', like)
  return {
    serp_density_rows: count ?? 0,
    parent_final_score: parentScore ?? null,
  }
}

async function fetchParentLatestScore(productId) {
  const { data } = await sb
    .from('jimscanner_trends_scores')
    .select('final_score')
    .eq('product_id', productId)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.final_score ?? null
}

function estimateScoreDelta(parentFinal, pivot, density) {
  // 진입성 = (100 - sub_competition) 가중 + (sub_volume_est) 가중
  // niche 일수록 sub_competition 낮음 → score 높음
  if (parentFinal == null || pivot.sub_competition == null) return null
  const entryEase = 100 - pivot.sub_competition
  const volume = pivot.sub_volume_est ?? 30
  const densityBoost = Math.min(20, density * 2) // 검색 흔적이 있으면 +up to 20
  const subFinal = Math.round(0.55 * entryEase + 0.30 * volume + 0.15 * densityBoost)
  return Math.round(subFinal - parentFinal)
}

async function explorePivots(parent) {
  const aliases = await fetchSampleAliases(parent.id)
  const parentFinal = await fetchParentLatestScore(parent.id)

  const userPrompt = `parent_name="${parent.canonical_name}" intent="${parent.intent_label ?? '-'}" category_top=${parent.category_top} aliases=[${aliases.slice(0, 5).join(' | ')}]
설명: ${parent.description ?? '-'}

위 head 키워드를 5~8개 narrow-niche 로 분기해라. JSON 배열만 응답.`

  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`
  const out = await callClaudeCli(fullPrompt)
  const arr = tryParseJsonArray(out.text) ?? []
  const pivots = []
  for (const o of arr) {
    const n = normalizePivot(o, parent.canonical_name)
    if (n) pivots.push(n)
  }
  if (pivots.length === 0) {
    return { inserted: 0, pivots: [], tokens: { i: out.inputTokens, o: out.outputTokens } }
  }

  const now = new Date().toISOString()
  let inserted = 0
  for (const p of pivots) {
    const signals = await computeMiniSignals(p.derived_query, parentFinal)
    const score_delta = estimateScoreDelta(parentFinal, p, signals.serp_density_rows)
    const { error } = await sb
      .from('jimscanner_trends_niche_pivots')
      .upsert(
        {
          parent_product_id: parent.id,
          pivot_axis: p.pivot_axis,
          pivot_value: p.pivot_value,
          derived_query: p.derived_query,
          sub_competition: p.sub_competition,
          sub_volume_est: p.sub_volume_est,
          sub_intent: p.sub_intent,
          score_delta,
          details: {
            rationale: p.rationale,
            serp_density_rows: signals.serp_density_rows,
            parent_final_score: parentFinal,
          },
          classified_by: MODEL,
          computed_at: now,
        },
        { onConflict: 'parent_product_id,derived_query' },
      )
    if (!error) inserted++
    else console.error(`  upsert error (${p.derived_query}): ${error.message}`)
  }
  return { inserted, pivots, tokens: { i: out.inputTokens, o: out.outputTokens } }
}

async function main() {
  const t0 = Date.now()
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] niche-pivot-explore start`)

  const parents = await fetchParentProducts()
  if (parents.length === 0) {
    console.log('  done: parent 후보 없음 (분류 완료 + 점수 있는 product 가 필요)')
    return
  }
  console.log(`  parents: ${parents.length} (${parents.map((p) => p.canonical_name).join(', ')})`)

  let totalInserted = 0
  let totalIn = 0
  let totalOut = 0
  for (const parent of parents) {
    try {
      const r = await explorePivots(parent)
      totalInserted += r.inserted
      totalIn += r.tokens.i
      totalOut += r.tokens.o
      console.log(`  ${parent.canonical_name}: ${r.inserted}/${r.pivots.length} 피벗 upsert`)
    } catch (e) {
      console.error(`  ${parent.canonical_name} failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(
    `[${new Date().toISOString()}] done — ${totalInserted} pivots, ${totalIn}/${totalOut} tok, ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
