#!/usr/bin/env node
/**
 * 트렌드 레이더 — 비교/대체 발화 마이닝 (로컬 전용, claude CLI).
 *
 * 커뮤니티·검색 raw 텍스트(jimscanner_market_raw)에서 '비교·대체 발화'를
 * LLM 으로 추출해 방향성 그래프(challenger → incumbent)를 만든다.
 *   · 'A vs B', 'A랑 B 중에'  → relation='vs'
 *   · 'A 말고 B', 'A 대신 B'   → relation='replace'  (from=B 챌린저, to=A 인커번트)
 * 결과는 jimscanner_trends_rivalry 에 (from_name,to_name,relation,window) 단위로 누적.
 *
 * 호출:
 *   node --env-file=.env.local scripts/mine-trends-rivalry.mjs
 *
 * 요구: claude CLI(PATH·인증) + NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * classify-trends-llm.mjs 의 callClaudeCli / JSON 파싱 패턴을 재사용.
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// 비교 발화가 자주 등장하는 소스 (커뮤니티 우선). 없으면 전체.
const COMMUNITY_SOURCES = ['clien_park', 'quasarzone_sale', '82cook', 'natepan', 'ppomppu', 'dcinside', 'naver_blog']
const WINDOW_DAYS = 14
const RAW_LIMIT = 1200
const BATCH_SIZE = 25
const MAX_REQ_PER_RUN = 30

const SYSTEM_PROMPT = `너는 한국 쇼핑 커뮤니티 글에서 '상품 비교·대체 발화'만 뽑아내는 추출기다.
입력 리스트(각 줄 t="텍스트")에서 두 상품을 저울질하거나 갈아타기를 언급한 문장을 찾는다.

찾을 패턴:
- 'A vs B', 'A랑 B 중에', 'A와 B 비교'        → relation="vs"
- 'A 말고 B', 'A 대신 B', 'A보다 B', 'A에서 B로 갈아탐' → relation="replace" (from=B 신규/챌린저, to=A 기존/인커번트)

❗ 절대 규칙:
- 응답 첫 글자 '[', 마지막 글자 ']'. 설명·코드펜스·markdown 금지.
- 두 상품이 '같은 용도의 경쟁/대체' 관계일 때만 추출 (보완재·세트·무관 조합 제외).
- 일반 명사가 아닌 '상품/브랜드/품목' 수준만 (정치인·인물·지역·추상개념 제외).
- 상품명은 브랜드·용량·수식어 제거한 본질 한국어로 정규화 (예 "닥터린 알티지 오메가3" → "오메가3").
- 비교 발화가 하나도 없으면 빈 배열 [].

각 항목 필드:
- from: 챌린저(새로 고려/갈아타려는 쪽) 정규화 상품명
- to:   인커번트(기존/비교 기준) 정규화 상품명
- relation: "vs" | "replace"
- quote: 근거가 된 원문 일부 (40자 이내)

예시 입력: - t="유산균 먹다가 신바이오틱스로 갈아탔는데 효과 좋네요"
예시 출력: [{"from":"신바이오틱스","to":"유산균","relation":"replace","quote":"유산균 먹다가 신바이오틱스로 갈아탔는데"}]`

function buildUserPrompt(items) {
  const lines = items.map((it) => `- t="${it.text.replace(/"/g, "'").slice(0, 180)}"`)
  return `다음 ${items.length}개 텍스트에서 비교·대체 발화를 추출해 JSON 배열로 응답:\n\n${lines.join('\n')}`
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

function isoWeek(d) {
  // ISO week 'YYYY-Www' (모멘텀 시계열 버킷)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function normalizePair(o) {
  if (!o || typeof o !== 'object') return null
  const from = typeof o.from === 'string' ? o.from.trim().slice(0, 60) : ''
  const to = typeof o.to === 'string' ? o.to.trim().slice(0, 60) : ''
  const relation = o.relation === 'replace' ? 'replace' : o.relation === 'vs' ? 'vs' : null
  if (!from || !to || !relation || from === to) return null
  return {
    from,
    to,
    relation,
    quote: typeof o.quote === 'string' ? o.quote.trim().slice(0, 120) : null,
  }
}

function callClaudeCli(prompt) {
  // ANTHROPIC_API_KEY 류 제거 → claude.ai 구독으로 인증.
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
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 400)}`))
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 250)}`))
      }
      if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 250) ?? '?'}`))
      resolve({ text: typeof parsed.result === 'string' ? parsed.result : '' })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

async function fetchRawTexts() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString()
  const { data } = await sb
    .from('jimscanner_market_raw')
    .select('id, title, source, metadata, captured_at')
    .in('source', COMMUNITY_SOURCES)
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(RAW_LIMIT)
  return (data ?? [])
    .map((r) => {
      const desc =
        r.metadata && typeof r.metadata.description === 'string' ? r.metadata.description : ''
      const text = `${r.title ?? ''} ${desc}`.trim()
      return { id: r.id, text, source: r.source, captured_at: r.captured_at }
    })
    .filter((r) => r.text.length >= 6)
}

// 추출 명 → 기존 canonical product 매핑 (정확 일치 우선).
async function buildProductIndex() {
  const { data } = await sb.from('jimscanner_trends_products').select('id, canonical_name')
  const map = new Map()
  for (const p of data ?? []) {
    if (p.canonical_name) map.set(p.canonical_name.trim(), p.id)
  }
  return map
}

async function upsertRivalry(rows) {
  // (from_name,to_name,relation,window) 단위 누적 — 같은 키는 mention_count 합산.
  for (const r of rows) {
    const { data: existing } = await sb
      .from('jimscanner_trends_rivalry')
      .select('id, mention_count')
      .eq('from_name', r.from_name)
      .eq('to_name', r.to_name)
      .eq('relation', r.relation)
      .eq('window', r.window)
      .maybeSingle()
    if (existing) {
      await sb
        .from('jimscanner_trends_rivalry')
        .update({
          mention_count: (existing.mention_count ?? 0) + r.mention_count,
          last_seen_at: new Date().toISOString(),
          from_product_id: r.from_product_id ?? undefined,
          to_product_id: r.to_product_id ?? undefined,
          sample_quote: r.sample_quote ?? undefined,
        })
        .eq('id', existing.id)
    } else {
      await sb.from('jimscanner_trends_rivalry').insert(r)
    }
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'mine_trends_rivalry',
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
  console.log(`[${new Date().toISOString()}] mine-trends-rivalry (claude CLI) start`)

  const texts = await fetchRawTexts()
  if (texts.length === 0) {
    console.log('  done: 대상 텍스트 없음 (0)')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }
  console.log(`  raw texts: ${texts.length}`)

  const productIndex = await buildProductIndex()
  const window = isoWeek(new Date())

  // (from,to,relation) → 누적 행
  const agg = new Map()
  let reqCount = 0
  let lastError = null

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    const batch = texts.slice(i, i + BATCH_SIZE)
    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(batch)}`
    try {
      const out = await callClaudeCli(prompt)
      reqCount++
      const arr = tryParseJsonArray(out.text) ?? []
      const batchSource = batch[0]?.source ?? null
      let added = 0
      for (const raw of arr) {
        const p = normalizePair(raw)
        if (!p) continue
        const key = `${p.from} ${p.to} ${p.relation}`
        const cur = agg.get(key)
        if (cur) {
          cur.mention_count++
          if (!cur.sample_quote && p.quote) cur.sample_quote = p.quote
        } else {
          agg.set(key, {
            from_name: p.from,
            to_name: p.to,
            relation: p.relation,
            window,
            mention_count: 1,
            source: batchSource,
            sample_quote: p.quote,
            from_product_id: productIndex.get(p.from) ?? null,
            to_product_id: productIndex.get(p.to) ?? null,
          })
        }
        added++
      }
      console.log(`  batch ${reqCount}: ${batch.length} texts → ${added} pairs`)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch ${reqCount + 1} failed: ${lastError}`)
      break
    }
  }

  const rows = [...agg.values()]
  if (rows.length > 0) await upsertRivalry(rows)

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: texts.length,
    inserted_count: rows.length,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${rows.length} rivalry pairs, ${Date.now() - t0}ms`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({ status: 'error', fetched_count: 0, inserted_count: 0, duration_ms: 0, error_message: msg })
  process.exit(1)
})
