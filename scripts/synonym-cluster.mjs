#!/usr/bin/env node
/**
 * Synonym-Aggregated Demand 야간 cron (로컬 전용).
 *
 * naver_blog / news / shopping_insight / google_suggest / quasarzone 등에서
 * 흩어진 표면형 키워드를 같은 의미군(cluster)으로 묶고
 * jimscanner_synonym_clusters + jimscanner_signal_cluster_map 에 적재한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/synonym-cluster.mjs
 *   node --env-file=.env.local scripts/synonym-cluster.mjs --days=14 --max-terms=400
 *
 * 그룹핑 전략:
 *   1) 표면형 정규화(소문자, 공백 제거) 로 1차 묶음
 *   2) claude CLI 가 있으면 LLM 1-shot 그룹핑으로 2차 묶음 (영문↔한글, 줄임말, 오타, 속어, 브랜드형↔일반형)
 *   3) claude 가 없거나 실패하면 1차 결과로만 upsert (fallback)
 *
 * 요구 사항:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - (선택) claude CLI on PATH
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

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']
  }),
)
const DAYS = Number.parseInt(args.days ?? '7', 10)
const MAX_TERMS = Number.parseInt(args['max-terms'] ?? '500', 10)
const DRY_RUN = args['dry-run'] === 'true'
const SKIP_LLM = args['skip-llm'] === 'true'
const MODEL = 'claude-code-cli'

const SYSTEM_PROMPT = `한국 위탁 판매 키워드 동의어 그룹핑기. 입력 라벨을 같은 상품 의미군으로 묶어 JSON 배열로 반환.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석 과정·설명·코드펜스(\`\`\`)·markdown 금지
- 입력 id 손실 금지

같은 의미군으로 묶어야 할 경우:
- 영문↔한글 (예: "omega3" ↔ "오메가3")
- 줄임말·풀네임 (예: "탈모샴" ↔ "탈모 샴푸")
- 오타·표기 (예: "오메가쓰리" ↔ "오메가3")
- 브랜드형·일반형 (예: "닥터린 오메가3" ↔ "오메가3")
- 속어·정식명 (예: "직구 미용기기" ↔ "해외 뷰티 디바이스")

각 클러스터 필드:
- canonical_label: 의미군 대표 한국어 짧은 표현 (10자 이내)
- member_ids: 묶인 입력 id 배열 (입력에 등장한 id 만)
- category_hint: health | living | digital | other

예시 입력: - id="1" label="오메가3" - id="2" label="omega3 60캡슐" - id="3" label="oled tv"
예시 출력: [{"canonical_label":"오메가3","member_ids":["1","2"],"category_hint":"health"},{"canonical_label":"OLED TV","member_ids":["3"],"category_hint":"digital"}]`

function normalize(s) {
  if (!s) return ''
  return String(s).toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 60)
}

async function fetchMarketRaw(sinceIso) {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, query, captured_at')
    .gte('captured_at', sinceIso)
    .order('captured_at', { ascending: false })
    .limit(MAX_TERMS * 3)
  if (error) throw error
  return (data ?? []).map((r) => ({
    kind: 'market_raw',
    id: r.id,
    surface: (r.title || r.query || '').trim(),
    source: r.source,
    observed_at: r.captured_at,
  })).filter((r) => r.surface)
}

async function fetchTrendsKeywords(sinceIso) {
  const { data, error } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, collected_at')
    .gte('collected_at', sinceIso)
    .order('collected_at', { ascending: false })
    .limit(MAX_TERMS * 3)
  if (error) throw error
  return (data ?? []).map((r) => ({
    kind: 'trends_keyword',
    id: r.keyword,
    surface: r.keyword,
    source: r.source,
    observed_at: r.collected_at,
  })).filter((r) => r.surface)
}

async function fetchTrendsProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(MAX_TERMS)
  if (error) throw error
  return (data ?? []).map((r) => ({
    kind: 'trends_product',
    id: r.id,
    surface: r.canonical_name,
    source: 'trends_product',
    observed_at: r.last_seen_at,
    category_hint: r.category_top,
  })).filter((r) => r.surface)
}

function group1stPass(signals) {
  // 정규화 표면형 기준 1차 그룹핑
  const buckets = new Map()
  for (const s of signals) {
    const norm = normalize(s.surface)
    if (!norm) continue
    const arr = buckets.get(norm) ?? []
    arr.push(s)
    buckets.set(norm, arr)
  }
  // 각 버킷의 first signal 의 surface 를 1차 canonical 로 사용
  const clusters = []
  for (const [norm, arr] of buckets) {
    const first = arr[0]
    clusters.push({
      key: `n:${norm}`,
      canonical_label: first.surface.slice(0, 60),
      member_signals: arr,
      category_hint: arr.find((x) => x.category_hint)?.category_hint ?? null,
    })
  }
  return clusters
}

// 전역 ~/.claude/settings.json 의 model(fable) 대신 크론은 opus 로 고정. env 로 override 가능.
const CLI_MODEL = process.env.SYNONYM_MODEL || 'opus'

function callClaudeCli(prompt) {
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', CLI_MODEL], {
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
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300)}`))
        resolve({ text: typeof parsed.result === 'string' ? parsed.result : '' })
      } catch (e) {
        reject(new Error(`stdout not JSON: ${stdout.slice(0, 300)}`))
      }
    })
    child.stdin.end(prompt, 'utf8')
  })
}

function tryParseArray(text) {
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

async function llmRegroup(firstPassClusters) {
  // 1차 패스에서 단일 멤버인 클러스터들의 라벨만 모아 LLM 에 그룹핑 요청.
  const candidates = firstPassClusters
    .filter((c) => c.member_signals.length >= 1)
    .slice(0, 80) // LLM 부담 제한
  if (candidates.length < 4) return null
  const lines = candidates.map((c, i) => `- id="${i}" label="${c.canonical_label.replace(/"/g, '')}"`)
  const prompt = `${SYSTEM_PROMPT}\n\n다음 ${lines.length}개 라벨을 의미군으로 묶어 JSON 배열로 응답:\n\n${lines.join('\n')}`
  try {
    const { text } = await callClaudeCli(prompt)
    const arr = tryParseArray(text)
    if (!Array.isArray(arr)) return null
    // arr: [{canonical_label, member_ids:[...], category_hint}]
    const merged = []
    const usedIdx = new Set()
    for (const g of arr) {
      const ids = Array.isArray(g.member_ids) ? g.member_ids.map((x) => Number.parseInt(x, 10)).filter((x) => !Number.isNaN(x)) : []
      if (ids.length === 0) continue
      const member_signals = []
      for (const idx of ids) {
        const c = candidates[idx]
        if (!c || usedIdx.has(idx)) continue
        usedIdx.add(idx)
        for (const s of c.member_signals) member_signals.push(s)
      }
      if (member_signals.length === 0) continue
      merged.push({
        canonical_label: String(g.canonical_label ?? '').slice(0, 60) || member_signals[0].surface.slice(0, 60),
        member_signals,
        category_hint: ['health', 'living', 'digital', 'other'].includes(g.category_hint) ? g.category_hint : null,
      })
    }
    // LLM 이 누락한 candidates 는 1차 그대로
    for (let i = 0; i < candidates.length; i++) {
      if (usedIdx.has(i)) continue
      merged.push(candidates[i])
    }
    return merged
  } catch (e) {
    console.warn(`[synonym-cluster] LLM regroup failed: ${e.message}`)
    return null
  }
}

async function upsertClusters(clusters) {
  let inserted = 0
  let mapInserted = 0
  for (const c of clusters) {
    const member_terms = [...new Set(c.member_signals.map((s) => s.surface))].slice(0, 50)
    const sources = new Set(c.member_signals.map((s) => s.source).filter(Boolean))
    const payload = {
      canonical_label: c.canonical_label,
      member_terms,
      category_hint: c.category_hint,
      member_count: member_terms.length,
      source_count: sources.size,
      total_frequency: c.member_signals.length,
      llm_model: MODEL,
      refreshed_at: new Date().toISOString(),
    }
    const { data: existing } = await sb
      .from('jimscanner_synonym_clusters')
      .select('id')
      .eq('canonical_label', c.canonical_label)
      .maybeSingle()
    let cluster_id
    if (existing?.id) {
      cluster_id = existing.id
      await sb.from('jimscanner_synonym_clusters').update(payload).eq('id', cluster_id)
    } else {
      const { data, error } = await sb
        .from('jimscanner_synonym_clusters')
        .insert(payload)
        .select('id')
        .single()
      if (error) {
        console.warn(`[synonym-cluster] insert cluster failed (${c.canonical_label}): ${error.message}`)
        continue
      }
      cluster_id = data.id
      inserted++
    }
    // map upsert
    const rows = c.member_signals.map((s) => ({
      cluster_id,
      signal_kind: s.kind,
      signal_id: String(s.id),
      surface_term: s.surface.slice(0, 200),
      source: s.source ?? null,
      similarity: 1.0,
      observed_at: s.observed_at ?? new Date().toISOString(),
    }))
    if (rows.length === 0) continue
    const { error: mErr } = await sb
      .from('jimscanner_signal_cluster_map')
      .upsert(rows, { onConflict: 'cluster_id,signal_kind,signal_id' })
    if (mErr) {
      console.warn(`[synonym-cluster] map upsert failed: ${mErr.message}`)
      continue
    }
    mapInserted += rows.length
  }
  return { inserted, mapInserted }
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString()
  console.log(`[synonym-cluster] window=${DAYS}d since=${since} max-terms=${MAX_TERMS} dry-run=${DRY_RUN}`)

  const [raw, kw, prods] = await Promise.all([
    fetchMarketRaw(since),
    fetchTrendsKeywords(since),
    fetchTrendsProducts(),
  ])
  const all = [...raw, ...kw, ...prods].slice(0, MAX_TERMS * 5)
  console.log(`[synonym-cluster] signals: market_raw=${raw.length} trends_keyword=${kw.length} trends_product=${prods.length} total=${all.length}`)

  if (all.length === 0) {
    console.log('[synonym-cluster] nothing to cluster')
    return
  }

  const firstPass = group1stPass(all)
  console.log(`[synonym-cluster] first-pass clusters: ${firstPass.length}`)

  let finalClusters = firstPass
  if (!SKIP_LLM) {
    const regrouped = await llmRegroup(firstPass)
    if (regrouped) {
      finalClusters = regrouped
      console.log(`[synonym-cluster] llm regrouped clusters: ${regrouped.length}`)
    }
  }

  if (DRY_RUN) {
    console.log('[synonym-cluster] DRY RUN — first 10:')
    for (const c of finalClusters.slice(0, 10)) {
      console.log(`  ${c.canonical_label} (${c.member_signals.length} signals, hint=${c.category_hint})`)
    }
    return
  }

  const { inserted, mapInserted } = await upsertClusters(finalClusters)
  console.log(`[synonym-cluster] done: new clusters=${inserted} map rows=${mapInserted}`)
}

main().catch((e) => {
  console.error('[synonym-cluster] fatal:', e)
  process.exit(1)
})
