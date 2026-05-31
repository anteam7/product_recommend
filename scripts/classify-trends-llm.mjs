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

// 커뮤니티 출처 — 게시글 제목의 감정 극성을 읽어야 하는 소스
const COMMUNITY_SOURCES = ['natepan_ranking', '82cook_talk', 'dcinside_realtime', 'ppomppu_main']
// sentiment 패스 한도 (메인 분류 패스와 별도로 소비)
const SENTIMENT_BATCH_SIZE = 15
const SENTIMENT_MAX_REQ = 20
// 같은 상품을 N시간 내 재분류하지 않음
const SENTIMENT_TTL_HOURS = 24

const SENTIMENT_SYSTEM_PROMPT = `한국 커뮤니티(82쿡·네이트판·디시·뽐뿌) 게시글 제목으로 상품 감정 극성을 판정. 입력 리스트를 JSON 배열로 변환.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석 과정·설명·코드펜스(\`\`\`)·markdown 출력 금지
- 입력 id 그대로 유지

각 항목 필드:
- id: 입력 id 그대로
- polarity: positive | negative | neutral
  · positive: 추천·만족·입소문·재구매·가성비 호평
  · negative: 불만·하자·고장·반품·환불·AS지연·악성리뷰
  · neutral : 정보·질문·단순 언급
- defect_terms: 하자/문제 키워드 배열 (예: ["고장","반품","터짐","환불","AS"]). 없으면 []
- evidence_snippet: 극성 판정 근거가 된 제목 1개 인용 (30자 이내)

예시 입력: - id="x1" name="무선 청소기" mentions=[샤오미 핸디 샀는데 한달만에 고장 환불받음 | 무선청소기 추천좀]
예시 출력: [{"id":"x1","polarity":"negative","defect_terms":["고장","환불"],"evidence_snippet":"한달만에 고장 환불받음"}]`

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

예시 입력: - id="abc" name="닥터린 초임계 알티지 오메가3 60캡슐" cur_top=health aliases=2 samples=[종근당 오메가3 | 일양 오메가3] sources=[naver_shopping_hot,musinsa_best]
예시 출력: [{"id":"abc","canonical_name":"오메가3","brand":"닥터린","category_top":"health","category_mid":"오메가3","intent_label":"예방건강","description":"혈행건강 영양제"}]`

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
  return {
    id,
    canonical_name: cn,
    brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim() : null,
    category_top: top,
    category_mid: typeof o.category_mid === 'string' ? o.category_mid.trim().slice(0, 30) : '',
    intent_label: typeof o.intent_label === 'string' ? o.intent_label.trim().slice(0, 20) : '',
    description: typeof o.description === 'string' ? o.description.trim().slice(0, 80) : '',
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

// ── 커뮤니티 감성 극성 패스 ──────────────────────────────────

function buildSentimentPrompt(items) {
  const lines = items.map(
    (it) => `- id="${it.id}" name="${it.name}" mentions=[${it.mentions.slice(0, 6).join(' | ')}]`,
  )
  return `다음 ${items.length}개 상품의 커뮤니티 언급을 극성 판정해서 JSON 배열로 응답:\n\n${lines.join('\n')}`
}

function normalizeSentiment(o, fallbackId) {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? fallbackId).trim()
  if (!id) return null
  const polarity = ['positive', 'negative', 'neutral'].includes(o.polarity) ? o.polarity : 'neutral'
  const defect = Array.isArray(o.defect_terms)
    ? o.defect_terms.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    : []
  const snippet =
    typeof o.evidence_snippet === 'string' ? o.evidence_snippet.trim().slice(0, 120) : ''
  return { id, polarity, defect_terms: defect, evidence_snippet: snippet }
}

// 커뮤니티 alias 가 있고 아직(또는 오래전) sentiment 가 없는 상품 후보.
async function fetchSentimentCandidates() {
  const { data: aliasRows } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, source')
    .in('source', COMMUNITY_SOURCES)
    .order('created_at', { ascending: false })
    .limit(SENTIMENT_MAX_REQ * SENTIMENT_BATCH_SIZE * 4)
  if (!aliasRows || aliasRows.length === 0) return []

  // product_id → 언급(제목) 리스트
  const byProduct = new Map()
  for (const r of aliasRows) {
    const e = byProduct.get(r.product_id) ?? { mentions: [], sources: new Set() }
    if (e.mentions.length < 8) e.mentions.push(r.alias)
    if (r.source) e.sources.add(r.source)
    byProduct.set(r.product_id, e)
  }

  const ids = [...byProduct.keys()]
  // 최근 sentiment 가 있는 상품 제외 (TTL)
  const cutoff = new Date(Date.now() - SENTIMENT_TTL_HOURS * 3600 * 1000).toISOString()
  const { data: recent } = await sb
    .from('jimscanner_trends_sentiment')
    .select('product_id, computed_at')
    .in('product_id', ids)
    .gte('computed_at', cutoff)
  const fresh = new Set((recent ?? []).map((r) => r.product_id))

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .in('id', ids)
  const nameById = new Map((prods ?? []).map((p) => [p.id, p.canonical_name]))

  const candidates = []
  for (const [pid, e] of byProduct) {
    if (fresh.has(pid)) continue
    const name = nameById.get(pid)
    if (!name) continue
    candidates.push({
      id: pid,
      name,
      mentions: e.mentions,
      source: [...e.sources][0] ?? null,
    })
  }
  return candidates
}

async function runSentimentPass(counter, reqBudget) {
  const candidates = await fetchSentimentCandidates()
  if (candidates.length === 0) {
    console.log('  sentiment: 대상 없음 (0 community candidates)')
    return { req: 0, inserted: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, error: null }
  }
  console.log(`  sentiment candidates: ${candidates.length}`)

  const rows = []
  let req = 0
  let totalIn = 0
  let totalOut = 0
  let totalCost = 0
  let lastError = null
  const now = new Date().toISOString()

  for (let i = 0; i < candidates.length; i += SENTIMENT_BATCH_SIZE) {
    if (req >= SENTIMENT_MAX_REQ) break
    if (counter.requestCount + reqBudget + req >= DAILY_REQ_HARD_CAP) break

    const batch = candidates.slice(i, i + SENTIMENT_BATCH_SIZE)
    const prompt = `${SENTIMENT_SYSTEM_PROMPT}\n\n---\n\n${buildSentimentPrompt(batch)}`
    try {
      const out = await callClaudeCli(prompt)
      req++
      totalIn += out.inputTokens
      totalOut += out.outputTokens
      totalCost += out.costUsd
      const arr = tryParseJsonArray(out.text) ?? []
      const byId = new Map()
      for (let j = 0; j < arr.length; j++) {
        const r = normalizeSentiment(arr[j], batch[j]?.id ?? '')
        if (r) byId.set(r.id, r)
      }
      for (const it of batch) {
        const r = byId.get(it.id)
        if (!r) continue
        rows.push({
          product_id: it.id,
          polarity: r.polarity,
          defect_terms: r.defect_terms,
          evidence_snippet: r.evidence_snippet,
          source: it.source,
          mention_count: it.mentions.length,
          classified_by: MODEL,
          computed_at: now,
        })
      }
      console.log(
        `  sentiment batch ${req}: ${batch.length} in → ${byId.size} labeled (${out.inputTokens}/${out.outputTokens} tok)`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  sentiment batch ${req + 1} failed: ${lastError}`)
      break
    }
  }

  if (rows.length > 0) {
    const { error } = await sb.from('jimscanner_trends_sentiment').insert(rows)
    if (error) {
      lastError = lastError ?? error.message
      console.error(`  sentiment insert failed: ${error.message}`)
    }
  }

  return {
    req,
    inserted: rows.length,
    inputTokens: totalIn,
    outputTokens: totalOut,
    costUsd: totalCost,
    error: lastError,
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

  // ── 커뮤니티 감성 극성 패스 (메인 분류와 별도 한도) ──
  let sentiment = { req: 0, inserted: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, error: null }
  if (counter.requestCount + reqCount < DAILY_REQ_HARD_CAP) {
    try {
      sentiment = await runSentimentPass(counter, reqCount)
      totalCostUsd += sentiment.costUsd
      if (sentiment.error && !lastError) lastError = sentiment.error
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  sentiment pass failed: ${msg}`)
      if (!lastError) lastError = msg
    }
  }

  const totalReq = reqCount + sentiment.req
  if (totalReq > 0) {
    await bumpCounter(counter.day, {
      req: totalReq,
      products: allResults.length + sentiment.inserted,
      inputTokens: totalIn + sentiment.inputTokens,
      outputTokens: totalOut + sentiment.outputTokens,
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
    `[${new Date().toISOString()}] done — ${reqCount} req, ${allResults.length} classified, ` +
      `${sentiment.req} sentiment req, ${sentiment.inserted} sentiment labeled, ` +
      `$${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
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
