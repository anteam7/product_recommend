#!/usr/bin/env node
/**
 * UGC Latent Purchase Intent 마이닝 — claude CLI 배치 분류 (로컬 전용).
 *
 * jimscanner_market_raw(naver_blog/naver_news/quasarzone_sale) 본문에서
 * '어디서 사', '추천 부탁', '대체상품' 같은 구매의향 발화를 LLM 으로 추출해
 * jimscanner_ugc_intent 에 적재.
 *
 * 호출:
 *   node --env-file=.env.local scripts/mine-ugc-intent.mjs
 *
 * 요구: claude CLI 가 PATH 에 있고 인증 완료.
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
const BATCH_SIZE = 8
const MAX_REQ_PER_RUN = 40
const TARGET_SOURCES = ['naver_blog', 'naver_news', 'quasarzone_sale']

const SYSTEM_PROMPT = `한국 UGC 본문에서 *구매의향(latent purchase intent)* 발화만 추출하는 분류기.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 설명·코드펜스·markdown 금지
- 의향 발화가 없는 문서는 빈 배열 []로 응답 (id 만 포함)

각 입력 문서당 0~3개의 intent 4-tuple 을 추출. 의향 발화가 전혀 없으면 그 id 에 대해 항목을 만들지 말 것.

추출 대상 발화 패턴:
- where_to_buy: "어디서 사", "어디서 파는", "구매처", "판매처"
- recommend_request: "추천해 주세요", "추천 좀", "뭐가 좋아요", "어떤 게 좋을까"
- want_to_buy: "사고싶은데", "구매할까", "지를까", "고민중"
- alternative: "대체상품", "비슷한 거", "○○ 대신"

각 추출 항목 필드:
- raw_id: 입력 id 그대로
- keyword: 의향 대상 상품 키워드 (5-15자 한국어, 브랜드·수량 제거. 예: "무선이어폰", "오메가3")
- intent_type: where_to_buy | recommend_request | want_to_buy | alternative
- price_band: "저가" | "중가" | "고가" | null (가격 언급 있을 때만)
- user_context: 사용자 상황 5-15자 한국어 (예: "대학생 자취", "선물용"), 없으면 null
- quote: 원문 인용 1-2문장 (최대 200자)
- confidence: 0.0~1.0

예시 입력:
- id="r1" title="무선이어폰 추천 좀" body="대학생인데 5만원대 무선이어폰 어디서 사야 좋을까요? 갤럭시 버즈 살까 고민중..."
예시 출력:
[{"raw_id":"r1","keyword":"무선이어폰","intent_type":"where_to_buy","price_band":"저가","user_context":"대학생","quote":"5만원대 무선이어폰 어디서 사야 좋을까요","confidence":0.9}]

의향 발화가 없는 일반 뉴스/홍보 글이면 그 id 에 대해 항목을 만들지 말 것.`

function buildUserPrompt(docs) {
  const lines = docs.map((d) => {
    const body = (d.body ?? '').replace(/\s+/g, ' ').slice(0, 1200)
    const title = (d.title ?? '').replace(/\s+/g, ' ').slice(0, 200)
    return `- id="${d.id}" source=${d.source} title="${title}" body="${body}"`
  })
  return `다음 ${docs.length}개 UGC 문서에서 구매의향 발화를 추출해 JSON 배열로 응답:\n\n${lines.join('\n\n')}`
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

const VALID_INTENT_TYPES = new Set([
  'where_to_buy',
  'recommend_request',
  'want_to_buy',
  'alternative',
])
const VALID_PRICE_BANDS = new Set(['저가', '중가', '고가'])

function normalizeIntent(o, rawMap) {
  if (!o || typeof o !== 'object') return null
  const raw_id = String(o.raw_id ?? '').trim()
  if (!raw_id || !rawMap.has(raw_id)) return null
  const keyword = typeof o.keyword === 'string' ? o.keyword.trim().slice(0, 60) : ''
  if (!keyword) return null
  const intent_type = VALID_INTENT_TYPES.has(o.intent_type) ? o.intent_type : null
  if (!intent_type) return null
  const quote = typeof o.quote === 'string' ? o.quote.trim().slice(0, 400) : ''
  if (!quote) return null
  const price_band =
    typeof o.price_band === 'string' && VALID_PRICE_BANDS.has(o.price_band)
      ? o.price_band
      : null
  const user_context =
    typeof o.user_context === 'string' && o.user_context.trim()
      ? o.user_context.trim().slice(0, 40)
      : null
  let confidence = Number(o.confidence)
  if (!Number.isFinite(confidence)) confidence = 0.7
  if (confidence < 0) confidence = 0
  if (confidence > 1) confidence = 1

  const rawMeta = rawMap.get(raw_id)
  return {
    raw_id,
    source: rawMeta.source,
    source_url: rawMeta.source_url,
    captured_at: rawMeta.captured_at,
    keyword,
    intent_type,
    price_band,
    user_context,
    quote,
    confidence,
    llm_model: MODEL,
  }
}

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

async function fetchUnmined() {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, source_url, title, metadata, captured_at')
    .in('source', TARGET_SOURCES)
    .is('ugc_intent_mined_at', null)
    .order('captured_at', { ascending: false })
    .limit(MAX_REQ_PER_RUN * BATCH_SIZE)
  if (error) throw new Error(`fetchUnmined: ${error.message}`)
  return data ?? []
}

function extractBody(meta) {
  if (!meta || typeof meta !== 'object') return ''
  const candidates = [
    meta.description,
    meta.content,
    meta.body,
    meta.summary,
    meta.snippet,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return ''
}

async function insertIntents(rows) {
  if (rows.length === 0) return
  const chunks = []
  for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100))
  for (const chunk of chunks) {
    const { error } = await sb.from('jimscanner_ugc_intent').insert(chunk)
    if (error) console.error(`  insert intents failed: ${error.message}`)
  }
}

async function markMined(rawIds) {
  if (rawIds.length === 0) return
  const now = new Date().toISOString()
  const chunks = []
  for (let i = 0; i < rawIds.length; i += 200) chunks.push(rawIds.slice(i, i + 200))
  for (const chunk of chunks) {
    const { error } = await sb
      .from('jimscanner_market_raw')
      .update({ ugc_intent_mined_at: now })
      .in('id', chunk)
    if (error) console.error(`  mark mined failed: ${error.message}`)
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'mine_ugc_intent',
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
  console.log(`[${stamp}] mine-ugc-intent (claude CLI) start`)

  const candidates = await fetchUnmined()
  if (candidates.length === 0) {
    console.log('  done: 마이닝 대상 없음 (0 docs)')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }
  console.log(`  candidates: ${candidates.length}`)

  const allIntents = []
  const minedIds = []
  let reqCount = 0
  let totalIn = 0
  let totalOut = 0
  let totalCostUsd = 0
  let lastError = null

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const rawMap = new Map()
    const docs = batch.map((c) => {
      rawMap.set(c.id, {
        source: c.source,
        source_url: c.source_url,
        captured_at: c.captured_at,
      })
      return {
        id: c.id,
        source: c.source,
        title: c.title ?? '',
        body: extractBody(c.metadata),
      }
    })

    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(docs)}`

    try {
      const out = await callClaudeCli(prompt)
      reqCount++
      totalIn += out.inputTokens
      totalOut += out.outputTokens
      totalCostUsd += out.costUsd
      const arr = tryParseJsonArray(out.text) ?? []
      let batchIntents = 0
      for (const o of arr) {
        const norm = normalizeIntent(o, rawMap)
        if (norm) {
          allIntents.push(norm)
          batchIntents++
        }
      }
      for (const c of batch) minedIds.push(c.id)
      console.log(
        `  batch ${reqCount}: ${batch.length} docs → ${batchIntents} intents (${out.inputTokens}/${out.outputTokens} tok, $${out.costUsd.toFixed(4)})`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch ${reqCount + 1} failed: ${lastError}`)
      break
    }
  }

  await insertIntents(allIntents)
  await markMined(minedIds)

  console.log(
    `  done: ${minedIds.length} docs scanned, ${allIntents.length} intents inserted, ` +
      `${reqCount} req, $${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
  )

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: candidates.length,
    inserted_count: allIntents.length,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
