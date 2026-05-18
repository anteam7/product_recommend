#!/usr/bin/env node
/**
 * 트렌드 레이더 감성 극성 분류 — Claude Code CLI 버전 (로컬 전용).
 *
 * jimscanner_market_raw 의 forum/news/blog raw 중 미분류 24h 분량을
 * 가져와 LLM 으로 product 단위 감성 극성(pos/neu/neg/mix) 분류.
 * jimscanner_trends_sentiment(product_id, day, source, counts, samples) 에 누적.
 *
 * scripts/run-crons.mjs 의 마지막 단계로 spawn 된다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-trends-sentiment.mjs
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
const BATCH_SIZE = 15
const MAX_REQ_PER_RUN = 30
const RAW_FETCH_LIMIT = MAX_REQ_PER_RUN * BATCH_SIZE
const LOOKBACK_HOURS = 24

const FORUM_SOURCES = [
  '82cook',
  'ppomppu',
  'dcinside',
  'natepan',
  'daum_news',
  'naver_news',
  'naver_blog',
  'clien_park',
  'quasarzone_sale',
]

const SYSTEM_PROMPT = `한국 위탁 판매 후보 상품에 대한 포럼/뉴스/블로그 텍스트의 감성 극성 분류기.
입력: post 리스트 + 매칭된 product 후보 alias 사전.
출력: JSON 배열. 응답 첫 글자는 '[', 마지막 글자는 ']'. 다른 설명·markdown 금지.

각 post 가 어떤 product 를 언급하는지 alias 사전에서 매칭(있으면 product_id 반환, 없으면 null).
매칭된 경우 그 product 에 대한 감성 극성을 분류:
- positive: 호평·추천·만족·"좋아요"
- neutral: 정보·질문·중립적 언급
- negative: 혹평·불만·리콜·사기·고장 후기·"피하세요"
- mixed: 호평+혹평 공존

각 항목 필드:
- post_id: 입력 그대로
- product_id: alias 사전에서 매칭된 product id (없으면 null)
- polarity: positive | neutral | negative | mixed | none(매칭 안 됨)
- snippet: 판단 근거 30자 이내

예시 입력:
- post_id="p1" source="82cook" title="오메가3 효과 솔직 후기" desc="3개월 먹어보니 진짜 효과 있어요"
- aliases: [{product_id="abc", names=["오메가3","오메가-3"]}]
예시 출력: [{"post_id":"p1","product_id":"abc","polarity":"positive","snippet":"3개월 먹어보니 효과"}]`

function buildUserPrompt(posts, aliases) {
  const aliasJson = JSON.stringify(
    aliases.map((a) => ({ product_id: a.product_id, names: a.names })),
  )
  const postLines = posts.map(
    (p) =>
      `- post_id="${p.id}" source="${p.source}" title="${(p.title ?? '').slice(0, 120)}" desc="${(p.description ?? '').slice(0, 240)}"`,
  )
  return `다음 ${posts.length}개 post 를 분류:\n\naliases=${aliasJson}\n\nposts:\n${postLines.join('\n')}`
}

function tryParseJsonArray(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v
  } catch {}
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

async function fetchUnclassifiedRaw() {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString()
  const { data: raw } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, query, metadata, captured_at')
    .in('source', FORUM_SOURCES)
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(RAW_FETCH_LIMIT * 2)

  if (!raw || raw.length === 0) return []

  const ids = raw.map((r) => r.id)
  const { data: seen } = await sb
    .from('jimscanner_trends_sentiment_seen')
    .select('raw_id')
    .in('raw_id', ids)
  const seenSet = new Set((seen ?? []).map((s) => s.raw_id))

  return raw
    .filter((r) => !seenSet.has(r.id))
    .slice(0, RAW_FETCH_LIMIT)
    .map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title ?? '',
      description:
        (r.metadata && typeof r.metadata === 'object' && 'description' in r.metadata
          ? String(r.metadata.description ?? '')
          : '') || r.query || '',
      captured_at: r.captured_at,
    }))
}

async function fetchAliasDict() {
  // 가장 많이 분류된 상위 product 의 alias 사전.
  // 메모리 제약상 최대 200 product × 평균 3 alias.
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, brand')
    .order('last_seen_at', { ascending: false })
    .limit(200)
  if (!products || products.length === 0) return []
  const ids = products.map((p) => p.id)
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('product_id', ids)
    .limit(1000)
  const byProduct = new Map()
  for (const p of products) {
    byProduct.set(p.id, {
      product_id: p.id,
      names: [p.canonical_name, p.brand].filter(Boolean),
    })
  }
  for (const a of aliases ?? []) {
    const entry = byProduct.get(a.product_id)
    if (!entry) continue
    if (!entry.names.includes(a.alias)) entry.names.push(a.alias)
  }
  return [...byProduct.values()].map((e) => ({
    ...e,
    names: e.names.slice(0, 6),
  }))
}

function dayOf(iso) {
  return new Date(iso).toISOString().slice(0, 10)
}

async function applyResults(results, postsById) {
  if (results.length === 0) return { upserts: 0, skipped: 0 }

  // group by (product_id, day, source) → {pos, neu, neg, mix, samples}
  const bucket = new Map()
  let skipped = 0

  for (const r of results) {
    if (!r.product_id || r.polarity === 'none' || !r.polarity) {
      skipped++
      continue
    }
    const post = postsById.get(r.post_id)
    if (!post) {
      skipped++
      continue
    }
    const day = dayOf(post.captured_at)
    const key = `${r.product_id}|${day}|${post.source}`
    let entry = bucket.get(key)
    if (!entry) {
      entry = {
        product_id: r.product_id,
        day,
        source: post.source,
        pos: 0,
        neu: 0,
        neg: 0,
        mix: 0,
        samples: [],
      }
      bucket.set(key, entry)
    }
    if (r.polarity === 'positive') entry.pos++
    else if (r.polarity === 'neutral') entry.neu++
    else if (r.polarity === 'negative') entry.neg++
    else if (r.polarity === 'mixed') entry.mix++

    if (entry.samples.length < 5) {
      entry.samples.push({
        polarity: r.polarity,
        snippet: String(r.snippet ?? '').slice(0, 120),
        title: post.title.slice(0, 80),
      })
    }
  }

  // upsert: 기존 row 있으면 count 합산
  let upserts = 0
  for (const e of bucket.values()) {
    const { data: existing } = await sb
      .from('jimscanner_trends_sentiment')
      .select('id, pos_count, neu_count, neg_count, mix_count, sample_excerpts')
      .eq('product_id', e.product_id)
      .eq('day', e.day)
      .eq('source', e.source)
      .maybeSingle()

    const merged = {
      product_id: e.product_id,
      day: e.day,
      source: e.source,
      pos_count: (existing?.pos_count ?? 0) + e.pos,
      neu_count: (existing?.neu_count ?? 0) + e.neu,
      neg_count: (existing?.neg_count ?? 0) + e.neg,
      mix_count: (existing?.mix_count ?? 0) + e.mix,
      sample_excerpts: [
        ...((existing?.sample_excerpts ?? []) || []),
        ...e.samples,
      ].slice(0, 8),
      llm_model: MODEL,
      classified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const { error } = await sb
      .from('jimscanner_trends_sentiment')
      .upsert(merged, { onConflict: 'product_id,day,source' })
    if (!error) upserts++
  }

  return { upserts, skipped }
}

async function markSeen(rawIds) {
  if (rawIds.length === 0) return
  const rows = rawIds.map((id) => ({
    raw_id: id,
    classified_at: new Date().toISOString(),
  }))
  await sb.from('jimscanner_trends_sentiment_seen').upsert(rows, { onConflict: 'raw_id' })
}

async function refreshMV() {
  try {
    await sb.rpc('jimscanner_trends_refresh_polarity_daily')
  } catch (e) {
    console.error(`  MV refresh failed: ${e instanceof Error ? e.message : e}`)
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'classify_trends_sentiment',
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
  console.log(`[${new Date().toISOString()}] classify-trends-sentiment start`)

  const aliases = await fetchAliasDict()
  if (aliases.length === 0) {
    console.log('  done: 분류 가능한 product alias 없음')
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  const raws = await fetchUnclassifiedRaw()
  if (raws.length === 0) {
    console.log('  done: 미분류 forum/news/blog raw 없음')
    await refreshMV()
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  console.log(`  raws: ${raws.length}, alias products: ${aliases.length}`)

  const postsById = new Map(raws.map((r) => [r.id, r]))
  const allResults = []
  const processedRawIds = []
  let reqCount = 0
  let totalCostUsd = 0
  let lastError = null

  for (let i = 0; i < raws.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    const batch = raws.slice(i, i + BATCH_SIZE)
    const userPrompt = buildUserPrompt(batch, aliases)
    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`

    try {
      const out = await callClaudeCli(fullPrompt)
      reqCount++
      totalCostUsd += out.costUsd
      const arr = tryParseJsonArray(out.text) ?? []
      for (const r of arr) {
        if (r && typeof r === 'object' && r.post_id) {
          allResults.push({
            post_id: String(r.post_id),
            product_id: r.product_id ? String(r.product_id) : null,
            polarity: typeof r.polarity === 'string' ? r.polarity : 'none',
            snippet: typeof r.snippet === 'string' ? r.snippet : '',
          })
        }
      }
      for (const p of batch) processedRawIds.push(p.id)
      console.log(
        `  batch ${reqCount}: ${batch.length} in → ${arr.length} parsed ($${out.costUsd.toFixed(4)})`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch ${reqCount + 1} failed: ${lastError}`)
      break
    }
  }

  const applied = await applyResults(allResults, postsById)
  await markSeen(processedRawIds)
  await refreshMV()

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: raws.length,
    inserted_count: applied.upserts,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${applied.upserts} buckets upserted, ${applied.skipped} skipped, $${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
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
