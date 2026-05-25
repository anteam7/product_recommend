#!/usr/bin/env node
/**
 * 부정 리뷰 결함 aspect 마이닝 — 로컬 cron (Improvement-Scout #aspect-mining).
 *
 * 흐름:
 *   1) jimscanner_trends_review_raw 에서 processed_at IS NULL 인 부정 리뷰 fetch
 *      (수집 자체는 별도 collector 책임 — 본 스크립트는 가공/정규화만 담당)
 *   2) Claude CLI 로 review_text → aspect_tag 정규화 추출 (배치 20개씩)
 *   3) jimscanner_trends_review_aspects (category_top, aspect_tag) UPSERT 집계
 *      - mention_count, product_count, source_product_ids, sample_quotes 누적
 *      - severity_score = (낮은 별점 가중치 * 언급빈도) 정규화
 *   4) raw.processed_at + extracted_aspects 마킹
 *   5) jimscanner_trends_runs 에 감사 로그
 *
 * 호출:
 *   node --env-file=.env.local scripts/mine-review-aspects.mjs
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료 (구독 인증, ANTHROPIC_API_KEY 제거)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * 참고: scripts/classify-trends-llm.mjs 의 callClaudeCli 패턴 재사용.
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

const SOURCE_LABEL = 'mine_review_aspects'
const BATCH_SIZE = 20
const MAX_BATCHES_PER_RUN = 30
const SAMPLE_QUOTE_CAP = 5
const SOURCE_PRODUCT_CAP = 50

// 정규화 aspect 사전 — LLM 출력이 이 키로 매핑되도록 system prompt 에 강제.
// 새 카테고리 추가 시 여기에 추가.
const ASPECT_DICTIONARY = [
  ['뚜껑_약함',     '뚜껑이 잘 깨지거나 닫히지 않음'],
  ['냄새',          '플라스틱·고무·약품 냄새'],
  ['충전_불량',     '충전이 안 됨 / 케이블 단선'],
  ['내구성',        '쉽게 부서지거나 닳음'],
  ['구성품_누락',   '설명서·악세서리·부속 누락'],
  ['소음',          '동작 소음이 큼'],
  ['크기_차이',     '실측이 설명과 다름'],
  ['색상_차이',     '실물 색이 사진과 다름'],
  ['배송_파손',     '포장 파손·운송 사고'],
  ['배송_지연',     '도착이 너무 늦음'],
  ['고객응대_불량', 'CS 응답 불량'],
  ['짝퉁_의심',     '정품 의심·라벨 차이'],
  ['세척_어려움',   '청소·관리 난이도 높음'],
  ['사용설명_부족', '설명서·매뉴얼 부실'],
  ['오작동',        '센서·전원·기능 오류'],
]

const SYSTEM_PROMPT = `한국 위탁 판매 리뷰 분석기. 입력 부정 리뷰 (별점 1~3) 배열을 JSON 으로 변환.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석 과정·설명·코드펜스(\`\`\`)·markdown 출력 금지
- 입력 id 그대로 유지

각 항목 필드:
- id: 입력 id
- aspects: 정규화 aspect_tag 배열 (없으면 [])

허용된 aspect_tag 만 사용:
${ASPECT_DICTIONARY.map(([k, v]) => `- ${k} (${v})`).join('\n')}

리뷰 한 건은 여러 aspect 를 가질 수 있음. 어느 카테고리에도 안 맞으면 빈 배열.

예시 입력: - id="r1" rating=2 text="뚜껑이 첫날 깨졌고 고무 냄새가 심함"
예시 출력: [{"id":"r1","aspects":["뚜껑_약함","냄새"]}]`

function buildUserPrompt(reviews) {
  const lines = reviews.map(
    (r) => `- id="${r.id}" rating=${r.rating ?? '?'} text="${(r.review_text ?? '').replace(/\n/g, ' ').slice(0, 240)}"`,
  )
  return `다음 ${reviews.length}개 부정 리뷰의 결함 aspect 를 JSON 배열로 응답:\n\n${lines.join('\n')}`
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
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 500)}`))
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      resolve({ text: typeof parsed.result === 'string' ? parsed.result : '' })
    })
    child.stdin.end(`${SYSTEM_PROMPT}\n\n${prompt}`, 'utf8')
  })
}

async function fetchUnprocessed() {
  const { data, error } = await sb
    .from('jimscanner_trends_review_raw')
    .select('id, source, source_product_id, category_top, rating, review_text')
    .is('processed_at', null)
    .order('collected_at', { ascending: true })
    .limit(BATCH_SIZE * MAX_BATCHES_PER_RUN)
  if (error) throw error
  return data ?? []
}

function severityWeight(rating) {
  // 별점 1 → 1.0, 2 → 0.7, 3 → 0.4, 그 외 → 0.5
  if (rating === 1) return 1
  if (rating === 2) return 0.7
  if (rating === 3) return 0.4
  return 0.5
}

async function aggregateAndPersist(reviewById, results) {
  // (category_top, aspect_tag) 별 메모리 집계.
  const agg = new Map() // key=`${cat}::${tag}` → row
  for (const r of results) {
    const raw = reviewById.get(r.id)
    if (!raw) continue
    const cat = raw.category_top ?? 'other'
    const tags = Array.isArray(r.aspects) ? r.aspects.filter((t) => typeof t === 'string') : []
    for (const tag of tags) {
      const key = `${cat}::${tag}`
      let row = agg.get(key)
      if (!row) {
        row = {
          category_top: cat,
          aspect_tag: tag,
          mention_count: 0,
          severity_sum: 0,
          product_set: new Set(),
          sample_quotes: [],
        }
        agg.set(key, row)
      }
      row.mention_count += 1
      row.severity_sum += severityWeight(raw.rating)
      if (raw.source_product_id) row.product_set.add(raw.source_product_id)
      if (row.sample_quotes.length < SAMPLE_QUOTE_CAP) {
        row.sample_quotes.push({
          quote: (raw.review_text ?? '').slice(0, 240),
          source: raw.source,
          rating: raw.rating ?? null,
        })
      }
    }
  }

  // UPSERT 누적: 기존 행과 합산.
  for (const row of agg.values()) {
    const { data: existing } = await sb
      .from('jimscanner_trends_review_aspects')
      .select('id, mention_count, product_count, severity_score, source_product_ids, sample_quotes')
      .eq('category_top', row.category_top)
      .eq('aspect_tag', row.aspect_tag)
      .maybeSingle()

    const existingProducts = new Set(
      Array.isArray(existing?.source_product_ids) ? existing.source_product_ids : [],
    )
    for (const pid of row.product_set) existingProducts.add(pid)
    const mergedProducts = Array.from(existingProducts).slice(0, SOURCE_PRODUCT_CAP)

    const existingQuotes = Array.isArray(existing?.sample_quotes) ? existing.sample_quotes : []
    const mergedQuotes = [...row.sample_quotes, ...existingQuotes].slice(0, SAMPLE_QUOTE_CAP)

    const newMention = (existing?.mention_count ?? 0) + row.mention_count
    // severity 는 (severity_sum / mention_count) 가중 평균.
    const prevSevWeighted = (existing?.severity_score ?? 0) * (existing?.mention_count ?? 0)
    const newSeverity = newMention > 0 ? (prevSevWeighted + row.severity_sum) / newMention : 0

    await sb
      .from('jimscanner_trends_review_aspects')
      .upsert(
        {
          category_top: row.category_top,
          aspect_tag: row.aspect_tag,
          mention_count: newMention,
          product_count: mergedProducts.length,
          severity_score: Math.min(1, newSeverity),
          source_product_ids: mergedProducts,
          sample_quotes: mergedQuotes,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'category_top,aspect_tag' },
      )
  }
  return agg.size
}

async function markProcessed(results) {
  const now = new Date().toISOString()
  await Promise.all(
    results.map((r) =>
      sb
        .from('jimscanner_trends_review_raw')
        .update({ processed_at: now, extracted_aspects: r.aspects ?? [] })
        .eq('id', r.id),
    ),
  )
}

async function logRun(status, fetched, inserted, durationMs, errorMessage) {
  await sb.from('jimscanner_trends_runs').insert({
    source: SOURCE_LABEL,
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    duration_ms: durationMs,
    error_message: errorMessage ?? null,
    triggered_by: 'cli',
    finished_at: new Date().toISOString(),
  })
}

async function main() {
  const startedAt = Date.now()
  let totalFetched = 0
  let totalAspectRows = 0
  try {
    const unprocessed = await fetchUnprocessed()
    totalFetched = unprocessed.length
    if (unprocessed.length === 0) {
      console.log('[mine-review-aspects] no unprocessed reviews — exiting cleanly')
      await logRun('ok', 0, 0, Date.now() - startedAt, null)
      return
    }

    const reviewById = new Map(unprocessed.map((r) => [r.id, r]))
    for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
      const batch = unprocessed.slice(i, i + BATCH_SIZE)
      const prompt = buildUserPrompt(batch)
      let parsed
      try {
        const { text } = await callClaudeCli(prompt)
        parsed = tryParseJsonArray(text)
      } catch (err) {
        console.error(`[mine-review-aspects] batch ${i / BATCH_SIZE} claude error:`, err.message)
        continue
      }
      if (!parsed) {
        console.error(`[mine-review-aspects] batch ${i / BATCH_SIZE} unparseable`)
        continue
      }
      const written = await aggregateAndPersist(reviewById, parsed)
      totalAspectRows += written
      await markProcessed(parsed)
      console.log(`[mine-review-aspects] batch ${i / BATCH_SIZE}: ${batch.length} reviews → ${written} aspect rows`)
    }

    await logRun('ok', totalFetched, totalAspectRows, Date.now() - startedAt, null)
    console.log(`[mine-review-aspects] done — fetched=${totalFetched} aspect_rows_touched=${totalAspectRows}`)
  } catch (err) {
    console.error('[mine-review-aspects] fatal:', err)
    await logRun('error', totalFetched, totalAspectRows, Date.now() - startedAt, String(err?.message ?? err))
    process.exit(1)
  }
}

main()
