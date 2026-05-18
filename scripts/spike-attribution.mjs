#!/usr/bin/env node
/**
 * Spike Attribution — 키워드 급등의 외부 트리거 자동 매칭.
 *
 * 1) jimscanner_trends_keywords 에서 최근 7일 데이터의 keyword 별로
 *    p90 이상의 spike point 를 찾는다 (volume_relative 기준).
 * 2) spike_at 직전 24~72h 윈도우 안에 들어온 외부 이벤트 후보
 *    (jimscanner_market_raw 의 naver_news/daum_news/naver_tvtime
 *     /82cook/natepan/dcinside/ppomppu) 를 모은다.
 * 3) claude CLI 한 번에 한 키워드씩 N개 후보를 매칭 → score+reasoning.
 * 4) jimscanner_trends_spike_attribution 에 upsert.
 *
 * 사용:
 *   node --env-file=.env.local scripts/spike-attribution.mjs
 *   node --env-file=.env.local scripts/spike-attribution.mjs --dry
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
const DRY_RUN = process.argv.includes('--dry')

// 스파이크 탐지 파라미터
const LOOKBACK_DAYS = 7              // keyword 시계열을 얼마나 볼지
const PCTL = 0.9                     // p90 = top 10%
const MIN_RATIO_VS_BASELINE = 1.8    // baseline 평균 대비 1.8x 이상
const MAX_SPIKE_KEYWORDS = 25        // 한 run 당 최대 spike 키워드 수
const PRE_HOURS = 72                 // spike 직전 N시간
const POST_HOURS = 6                 // spike 직후 N시간까지도 허용
const MAX_CANDIDATES_PER_SPIKE = 12  // LLM 에 넘길 후보 외부 이벤트 개수
const DAILY_REQ_CAP = 200

const COMMUNITY_SOURCES = ['82cook', 'natepan', 'dcinside', 'ppomppu']
const NEWS_SOURCES = ['naver_news', 'daum_news']
const TV_SOURCES = ['naver_tvtime']
const ALL_CANDIDATE_SOURCES = [...COMMUNITY_SOURCES, ...NEWS_SOURCES, ...TV_SOURCES]

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
      try { parsed = JSON.parse(stdout) } catch { return reject(new Error(`stdout not JSON`)) }
      if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      resolve({ text: typeof parsed.result === 'string' ? parsed.result : '' })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

function tryParseJsonArray(text) {
  if (!text) return null
  try { const v = JSON.parse(text); if (Array.isArray(v)) return v } catch {}
  const a = text.indexOf('['); const b = text.lastIndexOf(']')
  if (a !== -1 && b !== -1 && b > a) {
    try { const v = JSON.parse(text.slice(a, b + 1)); if (Array.isArray(v)) return v } catch {}
  }
  return null
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos); const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

async function fetchKeywordSeries() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, volume_relative, collected_at')
    .gte('collected_at', since)
    .not('volume_relative', 'is', null)
    .order('collected_at', { ascending: true })
    .limit(20000)
  if (error) throw error
  return data ?? []
}

/**
 * 키워드별 시계열에서 spike point 를 추출.
 * - 해당 키워드 series 에서 p90 임계 + baseline(중앙값) 대비 ratio 가 임계 이상이면 spike.
 * - 한 키워드당 가장 최근 spike 1건만 사용 (중복 방지).
 */
function detectSpikes(rows) {
  const byKeyword = new Map()
  for (const r of rows) {
    if (typeof r.volume_relative !== 'number') continue
    const list = byKeyword.get(r.keyword) ?? []
    list.push(r)
    byKeyword.set(r.keyword, list)
  }

  const spikes = []
  for (const [keyword, series] of byKeyword.entries()) {
    if (series.length < 3) continue
    const values = series.map((s) => s.volume_relative).slice().sort((a, b) => a - b)
    const p90 = quantile(values, PCTL)
    const median = quantile(values, 0.5) || 0.001
    // 최근부터 거꾸로 훑어 첫 spike 1건
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i].volume_relative
      if (v >= p90 && v / median >= MIN_RATIO_VS_BASELINE) {
        spikes.push({
          keyword,
          source: series[i].source,
          spike_at: series[i].collected_at,
          spike_score: v,
          spike_ratio: v / median,
        })
        break
      }
    }
  }
  spikes.sort((a, b) => b.spike_ratio - a.spike_ratio)
  return spikes.slice(0, MAX_SPIKE_KEYWORDS)
}

async function fetchExistingPairs(spikes) {
  if (spikes.length === 0) return new Set()
  // (keyword, spike_at) tuple 들이 이미 처리됐는지 단순 체크
  const keys = spikes.map((s) => s.keyword)
  const { data } = await sb
    .from('jimscanner_trends_spike_attribution')
    .select('keyword, spike_at')
    .in('keyword', keys)
  const set = new Set()
  for (const r of (data ?? [])) set.add(`${r.keyword}::${r.spike_at}`)
  return set
}

async function fetchCandidates(spike) {
  const spikeMs = new Date(spike.spike_at).getTime()
  const fromIso = new Date(spikeMs - PRE_HOURS * 3600 * 1000).toISOString()
  const toIso = new Date(spikeMs + POST_HOURS * 3600 * 1000).toISOString()

  // market_raw 에서 윈도우 + title ilike keyword
  const { data } = await sb
    .from('jimscanner_market_raw')
    .select('source, source_url, title, captured_at, metadata')
    .in('source', ALL_CANDIDATE_SOURCES)
    .gte('captured_at', fromIso)
    .lte('captured_at', toIso)
    .ilike('title', `%${spike.keyword}%`)
    .order('captured_at', { ascending: false })
    .limit(MAX_CANDIDATES_PER_SPIKE * 3)

  const rows = data ?? []
  // 우선순위: TV > 뉴스 > 커뮤니티 (영향력 가정)
  const rank = (s) => (TV_SOURCES.includes(s) ? 0 : NEWS_SOURCES.includes(s) ? 1 : 2)
  rows.sort((a, b) => rank(a.source) - rank(b.source))
  return rows.slice(0, MAX_CANDIDATES_PER_SPIKE)
}

const SYSTEM_PROMPT = `한국 검색 트렌드 어트리뷰션 분석기. 입력: 1개 키워드의 spike, 그 직전 24~72h 외부 이벤트 후보 N개. 출력: 후보 N개 각각에 대해 'spike 의 직접 원인일 확률(0~1)' 과 한 줄 근거.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- markdown/code fence/설명 금지
- 입력 idx 그대로 유지

각 항목 필드:
- idx: 입력의 idx 그대로
- score: 0.0~1.0 (1.0 = 명백한 trigger, 0.0 = 무관)
- reasoning: 30자 이내 한국어 한 줄 (왜 그 점수인지)

예시 출력: [{"idx":0,"score":0.85,"reasoning":"방송 직후 검색 급증, 제품명 직접 언급"},{"idx":1,"score":0.1,"reasoning":"동음이의 우연 매칭"}]`

function buildUserPrompt(spike, candidates) {
  const lines = candidates.map((c, i) => {
    const tag = c.source
    const ts = c.captured_at?.slice(0, 16) ?? '?'
    const title = (c.title ?? '').slice(0, 100)
    return `- idx=${i} src=${tag} at=${ts} title="${title}"`
  })
  return `키워드: "${spike.keyword}"
spike 시점: ${spike.spike_at}
spike 강도: ${spike.spike_score?.toFixed(1)} (baseline 대비 ${spike.spike_ratio?.toFixed(2)}x)

다음 ${candidates.length}개 외부 이벤트 후보 각각이 위 spike 의 trigger 인지 판단:

${lines.join('\n')}`
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'spike_attribution',
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
  console.log(`[${new Date().toISOString()}] spike-attribution start (dry=${DRY_RUN})`)

  const series = await fetchKeywordSeries()
  console.log(`  keyword rows fetched: ${series.length}`)
  if (series.length === 0) {
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }

  const spikes = detectSpikes(series)
  console.log(`  detected spikes: ${spikes.length}`)
  if (spikes.length === 0) {
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }

  const seen = await fetchExistingPairs(spikes)
  const fresh = spikes.filter((s) => !seen.has(`${s.keyword}::${s.spike_at}`))
  console.log(`  fresh spikes (not yet attributed): ${fresh.length}`)

  let reqCount = 0
  let insertedCount = 0
  let lastError = null

  for (const spike of fresh) {
    if (reqCount >= DAILY_REQ_CAP) break
    const candidates = await fetchCandidates(spike)
    if (candidates.length === 0) {
      console.log(`  · "${spike.keyword}" — no external candidates`)
      continue
    }

    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(spike, candidates)}`
    let arr = []
    if (DRY_RUN) {
      console.log(`  [dry] would call claude for "${spike.keyword}" with ${candidates.length} candidates`)
      continue
    }

    try {
      const out = await callClaudeCli(prompt)
      reqCount++
      arr = tryParseJsonArray(out.text) ?? []
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  · "${spike.keyword}" claude failed: ${lastError}`)
      continue
    }

    const rowsToInsert = []
    for (const r of arr) {
      const idx = Number(r.idx)
      const c = candidates[idx]
      if (!c) continue
      const score = Math.max(0, Math.min(1, Number(r.score) || 0))
      if (score < 0.2) continue  // 잡음 제거
      rowsToInsert.push({
        keyword: spike.keyword,
        spike_at: spike.spike_at,
        spike_score: spike.spike_score,
        spike_ratio: spike.spike_ratio,
        candidate_source: c.source,
        candidate_url: c.source_url ?? null,
        candidate_title: (c.title ?? '').slice(0, 500),
        candidate_published_at: c.captured_at,
        score,
        reasoning: typeof r.reasoning === 'string' ? r.reasoning.slice(0, 300) : null,
        model: MODEL,
      })
    }

    if (rowsToInsert.length > 0) {
      // upsert on (keyword, spike_at, candidate_url) — null url 은 unique 충돌 안 함
      const { error } = await sb
        .from('jimscanner_trends_spike_attribution')
        .upsert(rowsToInsert, { onConflict: 'keyword,spike_at,candidate_url', ignoreDuplicates: false })
      if (error) {
        lastError = error.message
        console.error(`  · "${spike.keyword}" insert failed: ${error.message}`)
      } else {
        insertedCount += rowsToInsert.length
        console.log(`  · "${spike.keyword}" → ${rowsToInsert.length} attributions (top score ${Math.max(...rowsToInsert.map(r => r.score)).toFixed(2)})`)
      }
    } else {
      console.log(`  · "${spike.keyword}" — no candidates passed score threshold`)
    }
  }

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: fresh.length,
    inserted_count: insertedCount,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(`[${new Date().toISOString()}] done — ${reqCount} req, ${insertedCount} attributions, ${Date.now() - t0}ms`)
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
