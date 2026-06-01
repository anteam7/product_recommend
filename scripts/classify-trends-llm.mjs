#!/usr/bin/env node
/**
 * 트렌드 레이더 v4 LLM 분류 — Claude Code CLI 버전 (로컬 전용).
 *
 * 기존 /api/cron/classify-trends-llm 라우트의 대체. Vercel 에선 못 돌고
 * (claude 바이너리 없음) 로컬에서만 동작. scripts/run-crons.mjs 가
 * 마지막 단계로 이 스크립트를 spawn 한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-trends-llm.mjs
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료된 상태
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env)
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

const MODEL = 'claude-code-cli'
const BATCH_SIZE = 20
const MAX_REQ_PER_RUN = 60
const PRODUCT_FETCH_LIMIT = MAX_REQ_PER_RUN * BATCH_SIZE
const DAILY_REQ_HARD_CAP = 800

const SYSTEM_PROMPT = `한국 위탁 판매 상품 분류기. 입력 리스트를 JSON 배열로 변환.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석 과정·설명·코드펜스(\`\`\`)·markdown 출력 금지
- 입력 id 그대로 유지

각 항목 필드:
- canonical_name: 브랜드·용량·수식어 제거 후 상품 본질 (한국어, 예: "닥터린 초임계 알티지 오메가3 60캡슐" → "오메가3")
- brand: 명확한 브랜드만, 없으면 null
- category_top: health | living | digital | other
  · health: 건강기능식품·영양제·식품
  · living: 생활·주방·청소·뷰티·패션·차량
  · digital: 디지털·가전·액세서리·조명
  · other: 위 3종 외
- category_mid: 5-10자 한국어 (예: "오메가3", "수납용품")
- intent_label: 5-7자 (예: "예방건강", "문제해결", "소모품")
- description: 15자 이내 1문장 (위탁 판매 의사결정 단서)
- logistics: 위탁(드롭십) 물리적 운영 난이도 객체
  · dim_class: small | medium | large | furniture (가구급 대형)
  · fragility: 유리·세라믹 등 파손 위험 (true/false)
  · cold_chain: 냉장/냉동 필요 (true/false)
  · liquid: 액체·누액 위험 (true/false)
  · hazmat_battery: 리튬배터리 포함·항공불가 (true/false)
  · oversize_surcharge: 부피무게 할증 대상 (true/false)

예시 입력: - id="abc" name="닥터린 초임계 알티지 오메가3 60캡슐" cur_top=health aliases=2 samples=[종근당 오메가3 | 일양 오메가3] sources=[naver_shopping_hot,musinsa_best]
예시 출력: [{"id":"abc","canonical_name":"오메가3","brand":"닥터린","category_top":"health","category_mid":"오메가3","intent_label":"예방건강","description":"혈행건강 영양제","logistics":{"dim_class":"small","fragility":false,"cold_chain":false,"liquid":false,"hazmat_battery":false,"oversize_surcharge":false}}]`

// ── 위탁 물류 적합성 게이트 (src/lib/trend-radar/logistics.ts JS 미러) ──
// 카테고리 키워드 룰을 1차, LLM 결과를 2차로 합쳐 suitability 도출.
const LG_RULES = [
  { key: 'hazmat_battery', words: ['리튬', '배터리', '보조배터리', '충전지', '건전지', '파워뱅크', '전동', '드론', '스쿠터', '킥보드'] },
  { key: 'cold_chain', words: ['냉장', '냉동', '신선', '아이스', '밀키트', '생물', '회', '육류', '해산물', '아이스크림'] },
  { key: 'liquid', words: ['액상', '액체', '음료', '세제', '워시', '샴푸', '오일', '스프레이', '토너', '에센스', '주스', '워터', '클렌징'] },
  { key: 'fragility', words: ['유리', '세라믹', '도자기', '거울', '액자', '유리병', '머그', '와인잔', '전구', '도기', '크리스탈'] },
]
const LG_FURNITURE = ['가구', '소파', '침대', '매트리스', '책상', '식탁', '옷장', '장롱', '서랍장', '책장', '수납장']
const LG_LARGE = ['대형', '캐리어', '텐트', '러그', '카페트', '카펫', '안마의자', '자전거', '러닝머신', '트램폴린', '선반', '행거', '의자']
const LG_OVERSIZE = ['대용량', '점보', '특대', '롤매트', '플레이매트', '범퍼침대', '에어매트']

function lgHas(text, words) {
  return words.some((w) => text.includes(w))
}

function lgRuleFlags(name, description, categoryMid) {
  const text = [name ?? '', description ?? '', categoryMid ?? ''].join(' ')
  const flags = {
    dim_class: 'small',
    fragility: false,
    cold_chain: false,
    liquid: false,
    hazmat_battery: false,
    oversize_surcharge: false,
  }
  for (const r of LG_RULES) if (lgHas(text, r.words)) flags[r.key] = true
  if (lgHas(text, LG_FURNITURE)) {
    flags.dim_class = 'furniture'
    flags.oversize_surcharge = true
  } else if (lgHas(text, LG_LARGE)) {
    flags.dim_class = 'large'
    flags.oversize_surcharge = true
  } else if (lgHas(text, LG_OVERSIZE)) {
    flags.dim_class = 'medium'
    flags.oversize_surcharge = true
  }
  return flags
}

function lgFinalize(flags) {
  const reasons = []
  if (flags.hazmat_battery) reasons.push('🔋 리튬배터리·항공불가')
  if (flags.cold_chain) reasons.push('❄️ 냉장/냉동')
  if (flags.dim_class === 'furniture') reasons.push('🛋 가구급 대형')
  if (flags.liquid) reasons.push('💧 액체·누액')
  if (flags.fragility) reasons.push('🥃 파손 위험')
  if (flags.oversize_surcharge && flags.dim_class !== 'furniture') reasons.push('📦 부피무게 할증')
  if (flags.dim_class === 'large') reasons.push('📐 대형')

  const unfit = flags.hazmat_battery || flags.cold_chain || flags.dim_class === 'furniture'
  const caution = flags.liquid || flags.fragility || flags.oversize_surcharge || flags.dim_class === 'large'
  const suitability = unfit ? 'unfit' : caution ? 'caution' : 'fit'
  if (suitability === 'fit') reasons.push('✅ 위탁 적합')
  return { ...flags, suitability, reasons }
}

// 룰(1차) OR LLM(2차) — 어느 한쪽이라도 true 면 위험으로 본다 (보수적).
function lgMerge(ruleFlags, llm) {
  const out = { ...ruleFlags }
  if (llm && typeof llm === 'object') {
    const DIM = ['small', 'medium', 'large', 'furniture']
    if (DIM.includes(llm.dim_class)) {
      // 더 큰 등급 채택
      if (DIM.indexOf(llm.dim_class) > DIM.indexOf(out.dim_class)) out.dim_class = llm.dim_class
    }
    for (const k of ['fragility', 'cold_chain', 'liquid', 'hazmat_battery', 'oversize_surcharge']) {
      if (llm[k] === true) out[k] = true
    }
    if (out.dim_class === 'large' || out.dim_class === 'furniture') out.oversize_surcharge = true
  }
  return lgFinalize(out)
}

function buildUserPrompt(items) {
  const lines = items.map(
    (it) =>
      `- id="${it.id}" name="${it.name}" cur_top=${it.category_top} aliases=${it.alias_count} samples=[${it.sample_aliases.slice(0, 3).join(' | ')}] sources=[${it.sample_sources.join(',')}]`,
  )
  return `다음 ${items.length}개 상품 후보를 분류·정제해서 JSON 배열로 응답:\n\n${lines.join('\n')}`
}

function tryParseJsonArray(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      const v = JSON.parse(fence[1])
      if (Array.isArray(v)) return v
    } catch {}
  }
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a !== -1 && b !== -1 && b > a) {
    try {
      const v = JSON.parse(text.slice(a, b + 1))
      if (Array.isArray(v)) return v
    } catch {}
  }
  return null
}

function normalizeResult(o, fallbackId) {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? fallbackId).trim()
  if (!id) return null
  const cn = typeof o.canonical_name === 'string' ? o.canonical_name.trim() : ''
  if (!cn) return null
  const top = ['health', 'living', 'digital', 'other'].includes(o.category_top)
    ? o.category_top
    : 'other'
  const category_mid = typeof o.category_mid === 'string' ? o.category_mid.trim().slice(0, 30) : ''
  const description = typeof o.description === 'string' ? o.description.trim().slice(0, 80) : ''

  // 물류 적합성: 키워드 룰(1차) + LLM logistics(2차) 병합
  const ruleFlags = lgRuleFlags(cn, description, category_mid)
  const logistics = lgMerge(ruleFlags, o.logistics)
  logistics.source = o.logistics && typeof o.logistics === 'object' ? 'rule+llm' : 'rule'

  return {
    id,
    canonical_name: cn,
    brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim() : null,
    category_top: top,
    category_mid,
    intent_label: typeof o.intent_label === 'string' ? o.intent_label.trim().slice(0, 20) : '',
    description,
    logistics,
  }
}

function callClaudeCli(prompt) {
  // claude CLI 가 ANTHROPIC_API_KEY 를 보면 구독(Max) 대신 API 키로 인증.
  // 자식 env 에서 API 키류를 제거해서 claude.ai 구독으로 동작하게 한다.
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
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 500)}`))
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed.is_error) {
        return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      }
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        costUsd: parsed.total_cost_usd ?? 0,
      })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

async function fetchTodayCounter() {
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await sb
    .from('jimscanner_trends_llm_calls')
    .select('day, request_count, product_count, input_token_count, output_token_count')
    .eq('day', today)
    .maybeSingle()
  return {
    day: today,
    requestCount: data?.request_count ?? 0,
    productCount: data?.product_count ?? 0,
    inputTokens: data?.input_token_count ?? 0,
    outputTokens: data?.output_token_count ?? 0,
  }
}

async function bumpCounter(day, delta) {
  const { data: existing } = await sb
    .from('jimscanner_trends_llm_calls')
    .select('request_count, product_count, input_token_count, output_token_count')
    .eq('day', day)
    .maybeSingle()
  await sb.from('jimscanner_trends_llm_calls').upsert(
    {
      day,
      model: MODEL,
      request_count: (existing?.request_count ?? 0) + delta.req,
      product_count: (existing?.product_count ?? 0) + delta.products,
      input_token_count: (existing?.input_token_count ?? 0) + delta.inputTokens,
      output_token_count: (existing?.output_token_count ?? 0) + delta.outputTokens,
      last_call_at: new Date().toISOString(),
    },
    { onConflict: 'day' },
  )
}

async function fetchCandidates() {
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, llm_classified_at, updated_at')
    .is('llm_classified_at', null)
    .order('updated_at', { ascending: false })
    .limit(PRODUCT_FETCH_LIMIT)
  return data ?? []
}

async function fetchSampleAliases(productIds) {
  if (productIds.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, source')
    .in('product_id', productIds)
    .order('confidence', { ascending: false })
    .limit(productIds.length * 5)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    if (list.length < 3) list.push(r)
    map.set(r.product_id, list)
  }
  return map
}

async function applyResults(results) {
  if (results.length === 0) return
  const now = new Date().toISOString()
  await Promise.all(
    results.map((r) =>
      sb
        .from('jimscanner_trends_products')
        .update({
          canonical_name: r.canonical_name,
          brand: r.brand,
          category_top: r.category_top,
          category_mid: r.category_mid,
          intent_label: r.intent_label,
          description: r.description,
          llm_classified_at: now,
          llm_model: MODEL,
          // 위탁 물류 적합성 게이트 (trends_v4_logistics_gate.sql)
          dim_class: r.logistics.dim_class,
          lg_fragility: r.logistics.fragility,
          lg_cold_chain: r.logistics.cold_chain,
          lg_liquid: r.logistics.liquid,
          lg_hazmat_battery: r.logistics.hazmat_battery,
          lg_oversize_surcharge: r.logistics.oversize_surcharge,
          logistics_suitability: r.logistics.suitability,
          logistics_reasons: r.logistics.reasons,
          logistics_tagged_at: now,
          logistics_source: r.logistics.source ?? 'rule',
        })
        .eq('id', r.id),
    ),
  )
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'classify_trends_llm',
      triggered_by: 'local_cli',
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

async function main() {
  const t0 = Date.now()
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] classify-trends-llm (claude CLI) start`)

  const counter = await fetchTodayCounter()
  if (counter.requestCount >= DAILY_REQ_HARD_CAP) {
    console.log(`  skip: daily cap reached (${counter.requestCount} req)`)
    return
  }

  const candidates = await fetchCandidates()
  if (candidates.length === 0) {
    console.log('  done: 분류 대상 없음 (0 candidates)')
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  console.log(`  candidates: ${candidates.length}`)

  const aliasMap = await fetchSampleAliases(candidates.map((c) => c.id))

  const allResults = []
  let reqCount = 0
  let totalIn = 0
  let totalOut = 0
  let totalCostUsd = 0
  let lastError = null

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    if (counter.requestCount + reqCount >= DAILY_REQ_HARD_CAP) break

    const batch = candidates.slice(i, i + BATCH_SIZE)
    const inputs = batch.map((c) => {
      const sample = aliasMap.get(c.id) ?? []
      return {
        id: c.id,
        name: c.canonical_name,
        category_top: c.category_top,
        alias_count: c.alias_count,
        sample_aliases: sample.map((a) => a.alias),
        sample_sources: [...new Set(sample.map((a) => a.source ?? '').filter(Boolean))],
      }
    })

    const userPrompt = buildUserPrompt(inputs)
    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`

    try {
      const out = await callClaudeCli(fullPrompt)
      reqCount++
      totalIn += out.inputTokens
      totalOut += out.outputTokens
      totalCostUsd += out.costUsd
      const arr = tryParseJsonArray(out.text) ?? []
      const byId = new Map()
      for (let j = 0; j < arr.length; j++) {
        const r = normalizeResult(arr[j], inputs[j]?.id ?? '')
        if (r) byId.set(r.id, r)
      }
      for (const it of inputs) {
        const r = byId.get(it.id)
        if (r) allResults.push(r)
      }
      console.log(
        `  batch ${reqCount}: ${batch.length} in → ${byId.size} classified (${out.inputTokens}/${out.outputTokens} tok, $${out.costUsd.toFixed(4)})`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch ${reqCount + 1} failed: ${lastError}`)
      break
    }
  }

  if (allResults.length > 0) await applyResults(allResults)

  if (reqCount > 0) {
    await bumpCounter(counter.day, {
      req: reqCount,
      products: allResults.length,
      inputTokens: totalIn,
      outputTokens: totalOut,
    })
  }

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: candidates.length,
    inserted_count: allResults.length,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${allResults.length} classified, $${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({
    status: 'error',
    fetched_count: 0,
    inserted_count: 0,
    duration_ms: 0,
    error_message: msg,
  })
  process.exit(1)
})
