#!/usr/bin/env node
/**
 * Unmet Demand 추출기 — market_raw 본문 → 페인포인트 클러스터.
 *
 * 흐름:
 *   1) jimscanner_market_raw 에서 processed=false 인 텍스트 소스만 (naver_blog/news/clien_park/quasarzone_sale).
 *   2) Claude CLI 로 본문에서 '사용자 페인포인트 statement' 만 추출 (불만/요구/결핍).
 *   3) statement 의 의미 클러스터 키 (LLM 부여) 로 group → jimscanner_market_pain_points UPSERT.
 *   4) cluster_label 별로 jimscanner_trends_products.canonical_name 과 fuzzy 매칭
 *      (간단 substring + token 교집합) → mapped_product_id / mapped_score 채움.
 *   5) market_raw.processed = true 마킹.
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-pain-points.mjs
 *   node --env-file=.env.local scripts/extract-pain-points.mjs --dry
 *   node --env-file=.env.local scripts/extract-pain-points.mjs --limit 20
 *
 * 요구 사항:
 *   - claude CLI 가 PATH (구독 인증 완료)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * 무한 비용 가드: 1회 실행에 MAX_REQ_PER_RUN 요청 / DAILY 카운터는 기존
 *   jimscanner_trends_llm_calls 와 분리하지 않고 'pain-points' notes 로 누적.
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry')
const limit = parseInt(args[args.indexOf('--limit') + 1]) || 30

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const MAX_REQ_PER_RUN = 6
const BATCH_SIZE = 8
const TEXT_SOURCES = ['naver_blog', 'naver_news', 'clien_park', 'quasarzone_sale']

const SYSTEM_PROMPT = `한국 위탁 판매 시장 분석 보조. 입력은 직구·쇼핑 관련 게시물 일부.
목적: 사용자의 '페인포인트(불만·결핍·해결되지 않은 요구)' 만 추출.

❗ 절대 규칙
- 응답은 JSON 배열 1개. 첫 글자 '[' 마지막 글자 ']'.
- 어떤 설명·코드펜스·마크다운도 출력 금지.
- 페인포인트 없으면 빈 배열 [].
- statement 는 게시물 안의 한국어 발화 그대로 1문장. 한 입력에서 최대 2개.

각 항목 필드:
- raw_id: 입력 id 그대로
- statement: 사용자 발화체 1문장 (40자 이내, 광고 카피로 그대로 인용 가능해야 함)
- cluster_id: 같은 의도끼리 묶을 짧은 영문 slug (예: "noisy-fan", "cooling-mat-too-small"). 알파벳+숫자+하이픈만.
- cluster_label: 5~10자 한국어 라벨 (예: "팬 소음", "쿨매트 작음")
- severity: 0~10 (사용자가 얼마나 불편해하는가)
- ad_copy: statement 를 활용한 30자 이내 한국어 광고 헤드라인 1줄
- product_hint: 페인이 가리키는 상품군 키워드 (한국어 1~3단어). 없으면 빈 문자열.

예시 입력: - id="abc" source=clien_park title="여름 잠 못자겠는데..." text="에어컨 켜놔도 베개가 너무 더워요. 쿨링 베개라고 사봤는데 30분 지나면 다시 뜨끈해져서 답답합니다."
예시 출력: [{"raw_id":"abc","statement":"쿨링 베개 30분 지나면 다시 뜨끈해져서 답답","cluster_id":"cooling-pillow-short-duration","cluster_label":"쿨베개 지속력","severity":7,"ad_copy":"30분이 아니라 밤새 시원한 쿨링 베개","product_hint":"쿨링 베개"}]`

function buildUserPrompt(items) {
  const lines = items.map((it) => {
    const body = (it.body || '').replace(/\s+/g, ' ').slice(0, 600)
    return `- id="${it.id}" source=${it.source} title=${JSON.stringify(it.title || '')} text=${JSON.stringify(body)}`
  })
  return `다음 ${items.length}개 게시물에서 페인포인트만 추출해 JSON 배열로 응답:\n\n${lines.join('\n')}`
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

function slugifyCluster(s) {
  if (typeof s !== 'string') return ''
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function normalizeResult(o) {
  if (!o || typeof o !== 'object') return null
  const raw_id = String(o.raw_id ?? '').trim()
  if (!raw_id) return null
  const statement = (o.statement || '').toString().trim().slice(0, 200)
  if (!statement) return null
  const cluster_id = slugifyCluster(o.cluster_id) || slugifyCluster(statement.slice(0, 30))
  if (!cluster_id) return null
  const cluster_label = (o.cluster_label || '').toString().trim().slice(0, 40) || cluster_id
  const sevRaw = Number(o.severity)
  const severity = Number.isFinite(sevRaw) ? Math.max(0, Math.min(10, Math.round(sevRaw))) : 5
  const ad_copy = (o.ad_copy || '').toString().trim().slice(0, 120)
  const product_hint = (o.product_hint || '').toString().trim().slice(0, 60)
  return { raw_id, statement, cluster_id, cluster_label, severity, ad_copy, product_hint }
}

function callClaudeCli(prompt) {
  // ANTHROPIC_API_KEY 가 있으면 CLI 가 구독 무시하고 API 키로 인증.
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
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 400)}`))
      let parsed
      try { parsed = JSON.parse(stdout) } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      })
    })
    child.stdin.end(`${SYSTEM_PROMPT}\n\n${prompt}`, 'utf8')
  })
}

// ── fuzzy 매칭: hint 단어와 canonical_name 의 토큰 교집합 비율
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .split(/[\s,./()\[\]·-]+/)
    .filter((t) => t.length >= 2)
}

function matchProduct(hint, products) {
  const hintTokens = tokenize(hint)
  if (hintTokens.length === 0) return null
  let best = null
  for (const p of products) {
    const nameTokens = tokenize(p.canonical_name)
    if (nameTokens.length === 0) continue
    let hits = 0
    for (const ht of hintTokens) {
      if (nameTokens.some((nt) => nt.includes(ht) || ht.includes(nt))) hits++
    }
    if (hits === 0) continue
    const score = Math.round((hits / Math.max(hintTokens.length, 1)) * 100)
    if (!best || score > best.score) best = { id: p.id, score, name: p.canonical_name }
  }
  if (!best || best.score < 50) return null
  return best
}

async function fetchRaws() {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, metadata, captured_at')
    .in('source', TEXT_SOURCES)
    .eq('processed', false)
    .order('captured_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    body: r.metadata?.description || r.metadata?.text || r.metadata?.summary || r.title || '',
  }))
}

async function fetchProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .order('updated_at', { ascending: false })
    .limit(1000)
  if (error) throw error
  return data ?? []
}

async function upsertPainPoint(pp, mapped, rawId) {
  // cluster_id + statement 단위로 dedup. 같은 statement 가 다시 보이면 frequency +1, raw_ids 확장.
  const { data: existing } = await sb
    .from('jimscanner_market_pain_points')
    .select('id, frequency, raw_ids')
    .eq('cluster_id', pp.cluster_id)
    .eq('statement', pp.statement)
    .maybeSingle()

  if (existing) {
    const rawIds = Array.from(new Set([...(existing.raw_ids || []), rawId]))
    const { error } = await sb
      .from('jimscanner_market_pain_points')
      .update({
        frequency: (existing.frequency || 1) + 1,
        raw_ids: rawIds,
        last_seen: new Date().toISOString(),
        mapped_product_id: mapped?.id ?? null,
        mapped_score: mapped?.score ?? null,
      })
      .eq('id', existing.id)
    if (error) throw error
    return existing.id
  }

  const { data, error } = await sb
    .from('jimscanner_market_pain_points')
    .insert({
      cluster_id: pp.cluster_id,
      cluster_label: pp.cluster_label,
      statement: pp.statement,
      severity: pp.severity,
      ad_copy: pp.ad_copy || null,
      mapped_product_id: mapped?.id ?? null,
      mapped_score: mapped?.score ?? null,
      raw_ids: [rawId],
    })
    .select('id')
    .single()
  if (error) throw error
  return data?.id
}

async function markProcessed(rawIds) {
  if (rawIds.length === 0) return
  const { error } = await sb
    .from('jimscanner_market_raw')
    .update({ processed: true })
    .in('id', rawIds)
  if (error) throw error
}

async function main() {
  console.log(`[1/5] market_raw 미처리 본문 수집 (limit=${limit})`)
  const raws = await fetchRaws()
  console.log(`      ${raws.length}건`)
  if (raws.length === 0) {
    console.log('처리할 raw 없음. 종료.')
    return
  }

  console.log(`[2/5] canonical product 카탈로그 로드`)
  const products = await fetchProducts()
  console.log(`      ${products.length}개`)

  console.log(`[3/5] LLM 추출 — max ${MAX_REQ_PER_RUN} 요청 × batch ${BATCH_SIZE}`)
  const extracted = []
  let reqUsed = 0
  for (let i = 0; i < raws.length && reqUsed < MAX_REQ_PER_RUN; i += BATCH_SIZE) {
    const batch = raws.slice(i, i + BATCH_SIZE)
    const prompt = buildUserPrompt(batch)
    try {
      const { text } = await callClaudeCli(prompt)
      reqUsed++
      const arr = tryParseJsonArray(text) || []
      for (const item of arr) {
        const n = normalizeResult(item)
        if (n) extracted.push(n)
      }
      console.log(`      batch ${reqUsed}: in=${batch.length} → out=${arr.length}`)
    } catch (e) {
      console.warn(`      batch fail: ${e.message}`)
    }
  }

  console.log(`[4/5] fuzzy 매칭 + UPSERT`)
  const touchedRawIds = new Set()
  let upserts = 0
  let unmet = 0
  for (const pp of extracted) {
    const matched = matchProduct(pp.product_hint, products)
    if (dryRun) {
      console.log(
        `  [${matched ? 'MATCH ' + matched.score : 'UNMET '}] ${pp.cluster_label} :: ${pp.statement}`,
      )
      if (matched) console.log(`      → ${matched.name}`)
    } else {
      try {
        await upsertPainPoint(pp, matched, pp.raw_id)
        upserts++
        if (!matched) unmet++
        touchedRawIds.add(pp.raw_id)
      } catch (e) {
        console.warn(`      upsert fail (${pp.cluster_id}): ${e.message}`)
      }
    }
  }

  console.log(`[5/5] processed=true 마킹`)
  if (!dryRun) {
    // 분석 대상이었던 raw 는 다 마킹 (페인이 안 나와도 다시 안 봄)
    await markProcessed(raws.slice(0, MAX_REQ_PER_RUN * BATCH_SIZE).map((r) => r.id))
  }

  console.log(`\n✓ 추출 ${extracted.length} · UPSERT ${upserts} · Unmet ${unmet} · LLM 요청 ${reqUsed}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
