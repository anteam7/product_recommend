#!/usr/bin/env node
/**
 * 커뮤니티 Unmet-Needs 추출 — 로컬 전용 (claude CLI).
 *
 * 최근 24h 동안 들어온 forum 계열 jimscanner_trends_raw row 의 payload
 * (제목/본문 일부) 를 LLM 으로 분류해 '추천해줘 / 없을까 / 대안이 있나 /
 * 짜증나' 패턴을 정규화된 need 로 추출. jimscanner_unmet_needs 에 적재하고,
 * 같은 need_text 가 ≥3 게시글에서 반복되면 jimscanner_trends_seeds
 * (source='naver_search_trend', kind='keyword_group') 후보로 자동 승격.
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-unmet-needs.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const FORUM_SOURCES = [
  '82cook',
  'natepan',
  'ppomppu',
  'dcinside',
  'aliex_best',
  'clien_park',
  'quasarzone_sale',
]
const WINDOW_HOURS = 24
const RAW_FETCH_LIMIT = 400
const BATCH_SIZE = 10
const MAX_BATCHES = 12
const PROMOTE_THRESHOLD = 3

const SYSTEM_PROMPT = `한국 커뮤니티 게시글에서 '미충족 수요(unmet need)' 추출기.
입력 게시글 리스트를 JSON 배열로 변환.

추출 대상 패턴:
- "추천해줘 / 추천 부탁"
- "없을까 / 어디서 사 / 어디 파나"
- "대안 있나 / 비슷한 거"
- "짜증나 / 불편 / 답답"
- "이런 거 만들면 / 있으면 좋겠다"

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석 과정·설명·코드펜스·markdown 금지
- 입력 id 그대로 유지
- 패턴이 없는 게시글은 결과에서 빼라 (빈 배열 가능)

각 항목 필드:
- id: 입력 id
- need_text: 정규화된 1~2문장 한국어 need (브랜드·말투 제거, 검색 키워드처럼)
- need_type: "request" (추천/구매 요청) | "complaint" (불만/불편) | "gap" (제품/서비스 부재)
- category_guess: "health" | "living" | "digital" | "fashion" | "food" | "service" | "other"
- intensity: 0.0~1.0 (반복·강조·감정 강도)

예시 입력: - id="x" title="여드름 짜고 나서 진정되는 거 추천좀요" body="피부과 가긴 부담스럽고..."
예시 출력: [{"id":"x","need_text":"여드름 진정·자극 완화 스킨케어","need_type":"request","category_guess":"health","intensity":0.6}]`

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
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
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

function pickExcerpt(payload) {
  if (!payload || typeof payload !== 'object') return { title: '', body: '', url: '' }
  const title =
    payload.title ?? payload.subject ?? payload.name ?? payload.keyword ?? ''
  const body =
    payload.content ??
    payload.body ??
    payload.summary ??
    payload.description ??
    payload.text ??
    ''
  const url = payload.url ?? payload.link ?? payload.detail_url ?? ''
  return {
    title: String(title).slice(0, 200),
    body: String(body).slice(0, 400),
    url: String(url).slice(0, 300),
  }
}

function refOf(row, excerpt) {
  if (excerpt.url) return excerpt.url
  return `${row.source}::${row.id}`
}

async function fetchForumRows() {
  const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_raw')
    .select('id, source, request_label, payload, collected_at')
    .in('source', FORUM_SOURCES)
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(RAW_FETCH_LIMIT)
  if (error) throw error
  return data ?? []
}

async function fetchAlreadyExtractedRefs(rows) {
  const refs = [...new Set(rows.map((r) => r._ref).filter(Boolean))]
  if (refs.length === 0) return new Set()
  const seen = new Set()
  for (let i = 0; i < refs.length; i += 200) {
    const chunk = refs.slice(i, i + 200)
    const { data } = await sb
      .from('jimscanner_unmet_needs')
      .select('source_post_ref')
      .in('source_post_ref', chunk)
    for (const d of data ?? []) seen.add(d.source_post_ref)
  }
  return seen
}

function normalizeOne(o) {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? '').trim()
  const need = String(o.need_text ?? '').trim()
  if (!id || !need) return null
  const typeOk = ['request', 'complaint', 'gap'].includes(o.need_type)
  const catOk = ['health', 'living', 'digital', 'fashion', 'food', 'service', 'other'].includes(
    o.category_guess,
  )
  let intensity = Number(o.intensity)
  if (!Number.isFinite(intensity)) intensity = 0.5
  intensity = Math.min(1, Math.max(0, intensity))
  return {
    id,
    need_text: need.slice(0, 200),
    need_type: typeOk ? o.need_type : 'request',
    category_guess: catOk ? o.category_guess : 'other',
    intensity,
  }
}

async function insertNeeds(records) {
  if (records.length === 0) return 0
  let inserted = 0
  for (let i = 0; i < records.length; i += 100) {
    const chunk = records.slice(i, i + 100)
    const { error, count } = await sb
      .from('jimscanner_unmet_needs')
      .upsert(chunk, {
        onConflict: 'source,source_post_ref,(md5(need_text))',
        ignoreDuplicates: true,
        count: 'exact',
      })
    if (error) {
      // fallback: try plain insert per-row (unique index might not be picked up by onConflict)
      for (const r of chunk) {
        const { error: e2 } = await sb.from('jimscanner_unmet_needs').insert(r)
        if (!e2) inserted++
      }
    } else {
      inserted += count ?? chunk.length
    }
  }
  return inserted
}

async function autoPromoteSeeds() {
  // 같은 need_text 가 ≥PROMOTE_THRESHOLD 개 게시글에서 등장 → seed 후보 자동 등록.
  const { data: needs } = await sb
    .from('jimscanner_unmet_needs')
    .select('need_text, category_guess, intensity, source_post_ref')
    .is('promoted_seed_id', null)
    .gte('extracted_at', new Date(Date.now() - 7 * 86400_000).toISOString())
    .limit(2000)

  if (!needs || needs.length === 0) return { promoted: 0 }

  // group by need_text
  const groups = new Map()
  for (const n of needs) {
    const key = n.need_text
    let g = groups.get(key)
    if (!g) {
      g = { count: 0, intensitySum: 0, refs: new Set(), category: n.category_guess }
      groups.set(key, g)
    }
    g.refs.add(n.source_post_ref ?? '')
    g.count++
    g.intensitySum += Number(n.intensity) || 0
  }

  let promoted = 0
  for (const [need_text, g] of groups) {
    if (g.refs.size < PROMOTE_THRESHOLD) continue

    // 이미 seed 가 있나 (label 중복 방지)
    const label = `[unmet] ${need_text}`.slice(0, 80)
    const { data: existing } = await sb
      .from('jimscanner_trends_seeds')
      .select('id')
      .eq('source', 'naver_search_trend')
      .eq('label', label)
      .maybeSingle()

    let seedId = existing?.id
    if (!seedId) {
      const { data: ins, error } = await sb
        .from('jimscanner_trends_seeds')
        .insert({
          source: 'naver_search_trend',
          kind: 'keyword_group',
          label,
          config: {
            groupName: need_text,
            keywords: [need_text],
            origin: 'unmet_needs_auto',
            category_guess: g.category,
            intensity_avg: Number((g.intensitySum / g.count).toFixed(2)),
            evidence_count: g.refs.size,
          },
          is_active: false, // 사람 검토 후 활성화
        })
        .select('id')
        .single()
      if (error) {
        console.warn(`  seed insert failed for "${need_text}": ${error.message}`)
        continue
      }
      seedId = ins?.id
      promoted++
    }

    if (seedId) {
      await sb
        .from('jimscanner_unmet_needs')
        .update({ promoted_seed_id: seedId })
        .eq('need_text', need_text)
        .is('promoted_seed_id', null)
    }
  }
  return { promoted }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'extract_unmet_needs',
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
  console.log(`[${new Date().toISOString()}] extract-unmet-needs start`)

  const rows = await fetchForumRows()
  console.log(`  forum rows (24h): ${rows.length}`)

  if (rows.length === 0) {
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }

  // 확장 + 중복 ref 제거
  const enriched = []
  const seenRefs = new Set()
  for (const r of rows) {
    const ex = pickExcerpt(r.payload)
    if (!ex.title && !ex.body) continue
    const ref = refOf(r, ex)
    if (seenRefs.has(ref)) continue
    seenRefs.add(ref)
    enriched.push({ ...r, _excerpt: ex, _ref: ref })
  }
  console.log(`  unique posts with text: ${enriched.length}`)

  const already = await fetchAlreadyExtractedRefs(enriched)
  const fresh = enriched.filter((r) => !already.has(r._ref))
  console.log(`  fresh (not yet extracted): ${fresh.length}`)

  let totalInserted = 0
  let lastError = null

  for (let i = 0; i < fresh.length && i < MAX_BATCHES * BATCH_SIZE; i += BATCH_SIZE) {
    const batch = fresh.slice(i, i + BATCH_SIZE)
    const idMap = new Map() // batch-local short id → row
    const lines = batch.map((r, j) => {
      const shortId = `r${i + j}`
      idMap.set(shortId, r)
      const title = r._excerpt.title.replace(/"/g, "'")
      const body = r._excerpt.body.replace(/"/g, "'").replace(/\n+/g, ' ')
      return `- id="${shortId}" source="${r.source}" title="${title}" body="${body}"`
    })
    const userPrompt = `다음 ${batch.length}개 게시글에서 unmet need 추출, JSON 배열로 응답 (없으면 []):\n\n${lines.join('\n')}`
    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`

    try {
      const out = await callClaudeCli(fullPrompt)
      const arr = tryParseJsonArray(out.text) ?? []
      const records = []
      for (const raw of arr) {
        const norm = normalizeOne(raw)
        if (!norm) continue
        const src = idMap.get(norm.id)
        if (!src) continue
        records.push({
          source: src.source,
          source_post_ref: src._ref,
          raw_excerpt: `${src._excerpt.title}\n${src._excerpt.body}`.trim().slice(0, 400),
          need_text: norm.need_text,
          need_type: norm.need_type,
          category_guess: norm.category_guess,
          intensity: norm.intensity,
        })
      }
      const inserted = await insertNeeds(records)
      totalInserted += inserted
      console.log(
        `  batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} in → ${records.length} needs (${inserted} inserted, ${out.inputTokens}/${out.outputTokens} tok)`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch failed: ${lastError}`)
      break
    }
  }

  const { promoted } = await autoPromoteSeeds()
  console.log(`  auto-promoted seeds: ${promoted}`)

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: fresh.length,
    inserted_count: totalInserted,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${totalInserted} needs inserted, ${promoted} seeds promoted, ${Date.now() - t0}ms`,
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
