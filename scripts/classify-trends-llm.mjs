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

❗ 구매의도(bottom-of-funnel) 추출 — samples 원문(커뮤니티 글제목)을 분석:
- purchase_intent_count: samples 중 "능동 구매의도 발화" 개수 (정수).
  능동 구매의도 = 어디서 사요/사고싶다/추천 좀/링크 좀/품번·모델명 질문/대체템 뭐 있어요/얼마예요/구매처/직구 가능?
  단순 후기·자랑·뉴스·정보 공유는 제외 (구매하려는 의지가 드러나야 함).
- intent_quotes: 구매의도 발화 최대 2개를 인용. 각 {"quote": 원문(30자 이내), "type": where_to_buy|recommend_request|link_request|model_query|alternative|price_query}
  구매의도 발화가 없으면 빈 배열 [].

예시 입력: - id="abc" name="닥터린 초임계 알티지 오메가3 60캡슐" cur_top=health aliases=2 samples=[오메가3 어디서 사요? | 종근당 오메가3 후기 | 알티지 추천 좀요] sources=[natepan,musinsa_best]
예시 출력: [{"id":"abc","canonical_name":"오메가3","brand":"닥터린","category_top":"health","category_mid":"오메가3","intent_label":"예방건강","description":"혈행건강 영양제","purchase_intent_count":2,"intent_quotes":[{"quote":"오메가3 어디서 사요?","type":"where_to_buy"},{"quote":"알티지 추천 좀요","type":"recommend_request"}]}]`

function buildUserPrompt(items) {
  const lines = items.map(
    (it) =>
      `- id="${it.id}" name="${it.name}" cur_top=${it.category_top} aliases=${it.alias_count} samples=[${it.sample_aliases.join(' | ')}] sources=[${it.sample_sources.join(',')}]`,
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
  // 구매의도 발화 추출 (samples 표본 기준) — sampleCount 로 density 계산
  const intentCount = Number.isFinite(o.purchase_intent_count)
    ? Math.max(0, Math.round(o.purchase_intent_count))
    : 0
  const VALID_TYPES = [
    'where_to_buy',
    'recommend_request',
    'link_request',
    'model_query',
    'alternative',
    'price_query',
  ]
  const quotes = Array.isArray(o.intent_quotes)
    ? o.intent_quotes
        .filter((q) => q && typeof q.quote === 'string' && q.quote.trim())
        .slice(0, 2)
        .map((q) => ({
          quote: q.quote.trim().slice(0, 60),
          type: VALID_TYPES.includes(q.type) ? q.type : 'where_to_buy',
        }))
    : []
  return {
    id,
    canonical_name: cn,
    brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim() : null,
    category_top: top,
    category_mid: typeof o.category_mid === 'string' ? o.category_mid.trim().slice(0, 30) : '',
    intent_label: typeof o.intent_label === 'string' ? o.intent_label.trim().slice(0, 20) : '',
    description: typeof o.description === 'string' ? o.description.trim().slice(0, 80) : '',
    purchase_intent_count: intentCount,
    intent_quotes: quotes,
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
    .limit(productIds.length * 8)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    // 구매의도 밀도 표본 — alias 원문 최대 8개까지 본다.
    if (list.length < 8) list.push(r)
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
          purchase_intent_count: r.purchase_intent_count,
          intent_density: r.intent_density,
          intent_quotes: r.intent_quotes,
          intent_classified_at: now,
          llm_classified_at: now,
          llm_model: MODEL,
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
        if (!r) continue
        // intent_density: 본 표본(sample_aliases) 대비 구매의도 발화 비율 (0~1)
        const base = it.sample_aliases.length
        const density = base > 0 ? Math.min(1, r.purchase_intent_count / base) : 0
        r.intent_density = Math.round(density * 1000) / 1000
        allResults.push(r)
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
