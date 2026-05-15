#!/usr/bin/env node
/**
 * 커뮤니티 sentiment 분류기 (로컬, 시간당 cron).
 *
 * 입력: jimscanner_market_raw + jimscanner_trends_raw 의 신규 raw row
 *       (sentiment_processed ledger 에 없는 것).
 * 처리: 본문에서 상품/키워드 언급 추출 → claude CLI 로
 *       positive / neutral / negative / claim_risk 분류 + claim 키워드 추출.
 * 출력: jimscanner_trends_sentiment 에 윈도 단위 집계 row 추가.
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-sentiment.mjs
 *
 * 요구:
 *   - claude CLI PATH (구독 인증)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
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
const BATCH_SIZE = 15            // 한 LLM 호출에 묶을 문장 수
const MAX_REQ_PER_RUN = 30
const RAW_FETCH_LIMIT = 600      // 시간당 처리 상한

// 본문에서 가져올 텍스트 후보 키 (jimscanner_market_raw.metadata + jimscanner_trends_raw.payload)
const TEXT_KEYS = ['description', 'body', 'content', 'snippet', 'summary', 'text']
const TITLE_KEYS = ['title', 'subject', 'name']

// 커뮤니티/블로그/뉴스 소스 화이트리스트 (raw_market 측)
const COMMUNITY_SOURCES = new Set([
  '82cook', 'natepan', 'dcinside', 'ppomppu', 'clien_park', 'quasarzone_sale',
  'naver_blog', 'naver_news', 'kca_press',
])

const SYSTEM_PROMPT = `한국 위탁판매 셀러를 위한 상품 sentiment 분류기.
입력은 커뮤니티/블로그/뉴스에서 추출한 한 문장 리스트.
각 문장을 다음 라벨 중 하나로 분류하고, claim 키워드를 1-3개 뽑아라.

라벨:
- positive : 만족·추천·재구매 표현 (예: "써보니 좋다", "강추")
- neutral  : 정보·후기 중립
- negative : 불만·아쉬움 (강한 클레임은 아님)
- claim_risk : CS 폭주 위험 신호. '환불 안 됨/짝퉁/가품/고장/배송지연/사기/AS 불가/터졌다/먹튀' 등.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석·설명·코드펜스 금지
- 입력 id 그대로 유지

각 항목 필드:
- id : 입력 그대로
- label : positive | neutral | negative | claim_risk
- claim_keywords : claim_risk 일 때만 1~3개 키워드 (예: ["환불","고장"]). 그 외엔 []

예시 출력: [{"id":"s1","label":"claim_risk","claim_keywords":["환불","짝퉁"]},{"id":"s2","label":"positive","claim_keywords":[]}]`

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
      try { parsed = JSON.parse(stdout) } catch { return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`)) }
      if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      resolve({ text: typeof parsed.result === 'string' ? parsed.result : '' })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

function pickText(obj, keys) {
  if (!obj || typeof obj !== 'object') return null
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

// 한 raw row 에서 (제목+본문) 문장 N 개를 뽑는다.
function extractMentions(raw, isMarket) {
  const meta = isMarket ? (raw.metadata ?? {}) : (raw.payload ?? {})
  const title = pickText(meta, TITLE_KEYS) ?? raw.title ?? ''
  const body  = pickText(meta, TEXT_KEYS) ?? ''
  const combined = `${title}\n${body}`.trim()
  if (!combined) return []
  // 한국어 문장 분리 (대충)
  const sentences = combined
    .split(/(?<=[\.!?。…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 240)
  // 너무 많으면 앞쪽 3개만 (예: 댓글 도배 방지)
  return sentences.slice(0, 3)
}

// product / keyword 후보 매칭: alias 사전을 메모리 캐시.
let aliasCachePromise = null
async function getAliasIndex() {
  if (aliasCachePromise) return aliasCachePromise
  aliasCachePromise = (async () => {
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias')
      .limit(10000)
    const list = (data ?? [])
      .filter((r) => typeof r.alias === 'string' && r.alias.length >= 2)
      .map((r) => ({ product_id: r.product_id, alias: r.alias }))
    list.sort((a, b) => b.alias.length - a.alias.length)
    return list
  })()
  return aliasCachePromise
}

async function matchProducts(text, aliasIdx) {
  const hits = new Map() // product_id -> first matched alias
  const lower = text.toLowerCase()
  for (const a of aliasIdx) {
    if (hits.size >= 5) break
    if (!a.product_id) continue
    if (lower.includes(a.alias.toLowerCase())) {
      if (!hits.has(a.product_id)) hits.set(a.product_id, a.alias)
    }
  }
  return Array.from(hits.entries()).map(([product_id, alias]) => ({ product_id, alias }))
}

async function fetchUnprocessedMarket(limit) {
  const { data } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, metadata, captured_at')
    .order('captured_at', { ascending: false })
    .limit(limit)
  return (data ?? []).filter((r) => COMMUNITY_SOURCES.has(r.source))
}

async function fetchUnprocessedTrends(limit) {
  const { data } = await sb
    .from('jimscanner_trends_raw')
    .select('id, source, request_label, payload, collected_at')
    .order('collected_at', { ascending: false })
    .limit(limit)
  return (data ?? []).filter((r) => COMMUNITY_SOURCES.has(r.source))
}

async function filterAlreadyProcessed(rows, table) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const { data } = await sb
    .from('jimscanner_trends_sentiment_processed')
    .select('raw_id')
    .eq('raw_table', table)
    .in('raw_id', ids)
  const done = new Set((data ?? []).map((r) => r.raw_id))
  return rows.filter((r) => !done.has(r.id))
}

async function markProcessed(table, rawId, sentimentCount) {
  await sb.from('jimscanner_trends_sentiment_processed').upsert(
    {
      raw_table: table,
      raw_id: rawId,
      processed_at: new Date().toISOString(),
      sentiment_count: sentimentCount,
    },
    { onConflict: 'raw_table,raw_id' },
  )
}

function aggregateByProductSource(items) {
  // items: [{ product_id, source, label, claim_keywords, sample }]
  const groups = new Map()
  for (const it of items) {
    const key = `${it.product_id ?? '__nokw__'}::${it.source}`
    let g = groups.get(key)
    if (!g) {
      g = {
        product_id: it.product_id ?? null,
        keyword: it.keyword ?? null,
        source: it.source,
        mention: 0, pos: 0, neu: 0, neg: 0, claim: 0,
        claimKeywords: new Map(),
        samples: [],
      }
      groups.set(key, g)
    }
    g.mention += 1
    if (it.label === 'positive') g.pos += 1
    else if (it.label === 'neutral') g.neu += 1
    else if (it.label === 'negative') g.neg += 1
    else if (it.label === 'claim_risk') g.claim += 1
    for (const k of it.claim_keywords ?? []) {
      g.claimKeywords.set(k, (g.claimKeywords.get(k) ?? 0) + 1)
    }
    if (g.samples.length < 5) g.samples.push({ text: it.sample, label: it.label })
  }
  return Array.from(groups.values())
}

async function writeSentiment(groups, windowStart, windowEnd) {
  if (groups.length === 0) return
  const rows = groups.map((g) => {
    const total = Math.max(1, g.mention)
    const topClaim = Array.from(g.claimKeywords.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => k)
    return {
      product_id: g.product_id,
      keyword: g.keyword,
      source: g.source,
      window_start: windowStart,
      window_end: windowEnd,
      mention_count: g.mention,
      pos_count: g.pos,
      neu_count: g.neu,
      neg_count: g.neg,
      claim_count: g.claim,
      pos_ratio: g.pos / total,
      neg_ratio: g.neg / total,
      claim_ratio: g.claim / total,
      claim_keywords: topClaim,
      sample_sentences: g.samples,
      classified_by: 'llm_haiku',
      model: MODEL,
    }
  })
  // chunk
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const { error } = await sb.from('jimscanner_trends_sentiment').insert(chunk)
    if (error) console.error('  insert error:', error.message)
  }
}

async function main() {
  const t0 = Date.now()
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] classify-sentiment start`)

  const aliasIdx = await getAliasIndex()
  console.log(`  alias index: ${aliasIdx.length}`)

  const [marketRaw, trendsRaw] = await Promise.all([
    fetchUnprocessedMarket(RAW_FETCH_LIMIT),
    fetchUnprocessedTrends(RAW_FETCH_LIMIT),
  ])
  const [marketTodo, trendsTodo] = await Promise.all([
    filterAlreadyProcessed(marketRaw, 'jimscanner_market_raw'),
    filterAlreadyProcessed(trendsRaw, 'jimscanner_trends_raw'),
  ])
  console.log(`  unprocessed: market=${marketTodo.length} trends=${trendsTodo.length}`)

  // 문장 추출 + 상품 매칭
  const sentenceInputs = []  // { id, text, source, productMatches:[{product_id,alias}], rawTable, rawId }
  let sid = 0

  for (const r of marketTodo) {
    const sentences = extractMentions(r, true)
    for (const s of sentences) {
      const matches = await matchProducts(s, aliasIdx)
      sid++
      sentenceInputs.push({
        id: `m${sid}`,
        text: s,
        source: r.source,
        productMatches: matches,
        rawTable: 'jimscanner_market_raw',
        rawId: r.id,
      })
    }
  }
  for (const r of trendsTodo) {
    const sentences = extractMentions(r, false)
    for (const s of sentences) {
      const matches = await matchProducts(s, aliasIdx)
      sid++
      sentenceInputs.push({
        id: `t${sid}`,
        text: s,
        source: r.source,
        productMatches: matches,
        rawTable: 'jimscanner_trends_raw',
        rawId: r.id,
      })
    }
  }

  console.log(`  candidate sentences: ${sentenceInputs.length}`)
  if (sentenceInputs.length === 0) {
    console.log('  done — nothing to classify')
    return
  }

  const classified = []
  let reqCount = 0
  for (let i = 0; i < sentenceInputs.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    const batch = sentenceInputs.slice(i, i + BATCH_SIZE)
    const lines = batch.map((b) => `- id="${b.id}" text="${b.text.replace(/"/g, "'").slice(0, 220)}"`)
    const userPrompt = `다음 ${batch.length}개 문장을 분류해 JSON 배열로 응답:\n\n${lines.join('\n')}`
    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`

    try {
      const out = await callClaudeCli(fullPrompt)
      reqCount++
      const arr = tryParseJsonArray(out.text) ?? []
      const byId = new Map(arr.map((o) => [String(o.id ?? ''), o]))
      for (const b of batch) {
        const o = byId.get(b.id)
        const label = ['positive', 'neutral', 'negative', 'claim_risk'].includes(o?.label) ? o.label : 'neutral'
        const claim_keywords = Array.isArray(o?.claim_keywords)
          ? o.claim_keywords.filter((k) => typeof k === 'string').slice(0, 3)
          : []
        classified.push({ input: b, label, claim_keywords })
      }
      console.log(`  batch ${reqCount}: ${batch.length} sentences classified`)
    } catch (e) {
      console.error(`  batch failed: ${e instanceof Error ? e.message : e}`)
      break
    }
  }

  // 상품 매칭이 있는 분류 결과만 집계 대상
  const flat = []
  for (const c of classified) {
    if (c.input.productMatches.length === 0) {
      // 키워드 레벨 집계도 가능하지만 일단 product 매칭만 적재 (alias 풍부도 의존)
      continue
    }
    for (const m of c.input.productMatches) {
      flat.push({
        product_id: m.product_id,
        keyword: m.alias,
        source: c.input.source,
        label: c.label,
        claim_keywords: c.claim_keywords,
        sample: c.input.text,
      })
    }
  }

  const groups = aggregateByProductSource(flat)

  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000)  // 1h
  await writeSentiment(groups, windowStart.toISOString(), windowEnd.toISOString())

  // mark raw rows processed (모든 입력 raw 를 ledger 에 기록)
  const rawSeen = new Map()
  for (const b of sentenceInputs) {
    rawSeen.set(`${b.rawTable}::${b.rawId}`, { table: b.rawTable, id: b.rawId, count: 0 })
  }
  for (const c of classified) {
    const key = `${c.input.rawTable}::${c.input.rawId}`
    const r = rawSeen.get(key)
    if (r) r.count += c.input.productMatches.length
  }
  for (const r of rawSeen.values()) {
    await markProcessed(r.table, r.id, r.count)
  }

  console.log(`[${new Date().toISOString()}] done — ${reqCount} req, ${classified.length} sentences, ${groups.length} sentiment rows, ${Date.now() - t0}ms`)
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
