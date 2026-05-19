#!/usr/bin/env node
/**
 * 리뷰 페인포인트 마이닝 cron — 로컬 전용.
 *
 * 흐름:
 *   1) jimscanner_trends_products 에서 검색량 상위 키워드 N개 선정
 *   2) 각 키워드에 대해 네이버 스마트스토어/쿠팡/올리브영 리뷰를 스크레이프
 *      (Phase 0: 스크레이프 어댑터는 stub — 환경에 따라 fetch+selector 로 확장)
 *   3) Claude Code CLI 로 부정 토픽 클러스터링 (품질/사이즈/내구성/포장/사용감 등)
 *   4) jimscanner_review_pains UPSERT + history snapshot
 *   5) ggsan_match_goods_no = 같은 키워드 카테고리의 ggsan 변형 SKU (가장 가까운 1개)
 *
 * 호출:
 *   node --env-file=.env.local scripts/mine-review-pains.mjs
 *   node --env-file=.env.local scripts/mine-review-pains.mjs --keyword "오메가3"
 *   node --env-file=.env.local scripts/mine-review-pains.mjs --dry
 *
 * 요구 사항:
 *   - claude CLI (PATH, 인증 완료)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - DDL: supabase/trends_v4_review_pains.sql 적용됨
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
const DRY = args.includes('--dry')
const KEYWORD_ARG = (() => {
  const i = args.indexOf('--keyword')
  return i >= 0 ? args[i + 1] : null
})()

const TOP_KEYWORDS_PER_RUN = 5             // 한 run 에 처리할 키워드 수 (LLM 비용 가드)
const REVIEWS_PER_KEYWORD = 60             // 토픽 추출에 넣을 리뷰 샘플 수
const SOURCES = ['naver_smartstore', 'coupang', 'oliveyoung']

const PAIN_TOPICS = [
  'quality',
  'size',
  'durability',
  'packaging',
  'usability',
  'smell',
  'taste',
  'price',
  'shipping',
  'effect',
  'etc',
]

const SYSTEM_PROMPT = `한국 쇼핑몰 리뷰 부정 토픽 클러스터링기. 입력은 한 키워드의 리뷰 텍스트 모음.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 설명·코드펜스(\`\`\`)·markdown 출력 금지

각 토픽 객체:
- pain_topic: ${PAIN_TOPICS.join(' | ')}
- pain_label: 한국어 5-15자 (예: "캡슐이 너무 큼")
- frequency: 리뷰에서 본 횟수 (int, ≥1)
- repr_quote: 가장 대표성 있는 1문장 인용 (원문 그대로, 80자 이내)
- confidence: 0.00 ~ 1.00 (해당 토픽이 실제 부정 신호인지)

긍정/중립 리뷰는 제외. 같은 의미의 불만은 한 토픽으로 합쳐 frequency 누적.
최대 8개 토픽까지.`

function buildUserPrompt(keyword, reviews) {
  const blob = reviews
    .map((r, i) => `[${i + 1}] (${r.source}) ${r.text.replace(/\s+/g, ' ').slice(0, 280)}`)
    .join('\n')
  return `키워드: "${keyword}"\n\n리뷰 ${reviews.length}건:\n${blob}\n\nJSON 배열로 부정 토픽만 응답.`
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
      })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

/**
 * Phase 0 스크레이프 어댑터 — stub.
 *
 * 실제 운영에서는:
 *   - 네이버 스마트스토어: 검색 API → 상위 상품 review fetch (search.shopping.naver.com)
 *   - 쿠팡: 검색 결과 → 상품 페이지 review pane (playwright 필요할 수도)
 *   - 올리브영: 검색 → review 탭
 *
 * Phase 0 에서는 외부 어댑터가 stdin 으로 JSONL 을 넘기거나, 보조 .json fixture 로 빠르게
 * 부트스트랩 가능하도록 인터페이스만 마련.  현재는 빈 배열을 돌려준다 — cron 은 0건으로
 * 종료되고, 사용자가 fixture 를 채워 넣거나 어댑터를 구현하면 동작.
 */
async function fetchReviewsForKeyword(keyword) {
  // TODO(scrape): 실제 스크레이프 어댑터 구현.
  //   현재는 process.env.REVIEW_FIXTURE_DIR 가 있으면 거기서 ${keyword}.json 을 읽음.
  const dir = process.env.REVIEW_FIXTURE_DIR
  if (!dir) return []
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const file = path.join(dir, `${keyword}.json`)
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (r) =>
          r &&
          typeof r.text === 'string' &&
          typeof r.source === 'string' &&
          SOURCES.includes(r.source),
      )
      .slice(0, REVIEWS_PER_KEYWORD)
  } catch (e) {
    console.log(`  fixture for "${keyword}" missing or unreadable (${e.message})`)
    return []
  }
}

async function fetchTopKeywords() {
  if (KEYWORD_ARG) return [{ keyword: KEYWORD_ARG, score: 0 }]

  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('canonical_name, alias_count, last_seen_at')
    .order('alias_count', { ascending: false })
    .limit(200)
  const seen = new Set()
  const out = []
  for (const r of data ?? []) {
    const k = (r.canonical_name ?? '').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push({ keyword: k, score: r.alias_count ?? 0 })
    if (out.length >= TOP_KEYWORDS_PER_RUN) break
  }
  return out
}

async function findGgsanMatch(keyword) {
  // pg_trgm similarity — 가장 가까운 ggsan 상품 1개.
  const { data } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title')
    .ilike('title', `%${keyword}%`)
    .eq('status', 'active')
    .limit(1)
  return data?.[0]?.goods_no ?? null
}

function normalizeTopic(o) {
  if (!o || typeof o !== 'object') return null
  const topic = PAIN_TOPICS.includes(o.pain_topic) ? o.pain_topic : 'etc'
  const label = typeof o.pain_label === 'string' ? o.pain_label.trim().slice(0, 40) : null
  const quote = typeof o.repr_quote === 'string' ? o.repr_quote.trim().slice(0, 300) : null
  let freq = parseInt(o.frequency, 10)
  if (!Number.isFinite(freq) || freq < 1) freq = 1
  let conf = parseFloat(o.confidence)
  if (!Number.isFinite(conf)) conf = 0.5
  conf = Math.max(0, Math.min(1, conf))
  return { pain_topic: topic, pain_label: label, frequency: freq, repr_quote: quote, confidence: conf }
}

async function upsertPains(keyword, topics, ggsanGoodsNo) {
  if (topics.length === 0) return 0
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  const rows = topics.map((t) => ({
    keyword,
    product_ref: null,
    product_title: null,
    source: 'aggregated',
    pain_topic: t.pain_topic,
    pain_label: t.pain_label,
    frequency: t.frequency,
    repr_quote: t.repr_quote,
    confidence: t.confidence,
    ggsan_match_goods_no: ggsanGoodsNo,
    observed_at: now,
  }))

  if (DRY) {
    console.log(`  [dry] would upsert ${rows.length} rows for "${keyword}"`)
    for (const r of rows) {
      console.log(
        `    ${r.pain_topic} freq=${r.frequency} conf=${r.confidence.toFixed(2)} "${r.repr_quote?.slice(0, 60) ?? ''}"`,
      )
    }
    return rows.length
  }

  const { error: upErr } = await sb
    .from('jimscanner_review_pains')
    .upsert(rows, { onConflict: 'keyword,product_ref,source,pain_topic' })
  if (upErr) {
    console.error(`  upsert error: ${upErr.message}`)
    return 0
  }

  // history snapshot (per day)
  const histRows = topics.map((t) => ({
    keyword,
    pain_topic: t.pain_topic,
    frequency: t.frequency,
    observed_on: today,
  }))
  const { error: histErr } = await sb
    .from('jimscanner_review_pains_history')
    .upsert(histRows, { onConflict: 'keyword,pain_topic,observed_on' })
  if (histErr) console.error(`  history upsert error: ${histErr.message}`)

  return rows.length
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] mine-review-pains start (dry=${DRY})`)

  const top = await fetchTopKeywords()
  if (top.length === 0) {
    console.log('  no candidate keywords — exiting')
    return
  }
  console.log(`  keywords: ${top.map((t) => t.keyword).join(', ')}`)

  let totalUpserted = 0
  let totalReqs = 0
  for (const { keyword } of top) {
    const reviews = await fetchReviewsForKeyword(keyword)
    if (reviews.length < 3) {
      console.log(`  skip "${keyword}" — only ${reviews.length} reviews (need ≥3)`)
      continue
    }
    const ggsan = await findGgsanMatch(keyword)
    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(keyword, reviews)}`
    try {
      const out = await callClaudeCli(prompt)
      totalReqs++
      const arr = tryParseJsonArray(out.text) ?? []
      const topics = arr.map(normalizeTopic).filter((t) => t !== null)
      console.log(
        `  "${keyword}": ${reviews.length} reviews → ${topics.length} topics (${out.inputTokens}/${out.outputTokens} tok)${
          ggsan ? `, ggsan=${ggsan}` : ''
        }`,
      )
      totalUpserted += await upsertPains(keyword, topics, ggsan)
    } catch (e) {
      console.error(`  "${keyword}" failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(
    `[${new Date().toISOString()}] done — ${totalReqs} req, ${totalUpserted} rows in ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
