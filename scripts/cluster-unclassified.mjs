#!/usr/bin/env node
/**
 * 미분류·'기타' 잔여 신호 군집화 → 신개념 광맥 발굴 (로컬 전용).
 *
 * classify-trends-llm 이 처리 못 했거나 'other' 로 덤프한 trends_products 풀을
 * alias 텍스트 코사인(char-bigram TF, synonym-cluster.mjs 군집 로직 재사용)으로 묶고,
 * 각 클러스터를 기존 canonical_name 집합과 근접매칭해 '어디에도 안 붙는'
 * 클러스터만 jimscanner_emerging_clusters 에 적재한다 (= 택소노미 화이트스페이스).
 *
 * 호출:
 *   node --env-file=.env.local scripts/cluster-unclassified.mjs
 *   node --env-file=.env.local scripts/cluster-unclassified.mjs --max=400 --threshold=0.62 --dry-run
 *
 * 요구 사항:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - (선택) claude CLI on PATH (자동 라벨/그룹핑; 없으면 1차 패스 fallback)
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

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']
  }),
)
const MAX = Number.parseInt(args.max ?? '400', 10)
// nearest_similarity 가 이 값 이상이면 '기존 택소노미에 붙음' → 광맥 아님(제외)
const THRESHOLD = Number.parseFloat(args.threshold ?? '0.62')
const DRY_RUN = args['dry-run'] === 'true'
const SKIP_LLM = args['skip-llm'] === 'true'
const MODEL = 'claude-code-cli'

const SYSTEM_PROMPT = `한국 위탁 판매 키워드 동의어 그룹핑기. 입력 라벨을 같은 상품 의미군으로 묶어 JSON 배열로 반환.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석 과정·설명·코드펜스(\`\`\`)·markdown 금지
- 입력 id 손실 금지

각 클러스터 필드:
- canonical_label: 의미군 대표 한국어 짧은 표현 (10자 이내)
- member_ids: 묶인 입력 id 배열 (입력에 등장한 id 만)
- category_hint: health | living | digital | other

예시 입력: - id="1" label="저소음 미니 가습기" - id="2" label="무소음 가습기"
예시 출력: [{"canonical_label":"저소음 가습기","member_ids":["1","2"],"category_hint":"living"}]`

function normalize(s) {
  if (!s) return ''
  return String(s).toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 60)
}

// char-bigram TF 벡터 코사인 (의존성 없는 TF-IDF 근사)
function bigrams(s) {
  const n = normalize(s)
  if (n.length <= 1) return n ? [n] : []
  const out = []
  for (let i = 0; i < n.length - 1; i++) out.push(n.slice(i, i + 2))
  return out
}
function cosine(aGrams, bVec) {
  if (aGrams.length === 0) return 0
  const aVec = new Map()
  for (const g of aGrams) aVec.set(g, (aVec.get(g) ?? 0) + 1)
  let dot = 0
  let na = 0
  for (const v of aVec.values()) na += v * v
  for (const [g, v] of aVec) dot += v * (bVec.map.get(g) ?? 0)
  const denom = Math.sqrt(na) * bVec.norm
  return denom === 0 ? 0 : dot / denom
}
function toVec(s) {
  const grams = bigrams(s)
  const map = new Map()
  for (const g of grams) map.set(g, (map.get(g) ?? 0) + 1)
  let norm = 0
  for (const v of map.values()) norm += v * v
  return { map, norm: Math.sqrt(norm) }
}

async function fetchPool() {
  // 미분류(llm_classified_at IS NULL) + 'other' 덤프
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, llm_classified_at, first_seen_at, last_seen_at')
    .or('llm_classified_at.is.null,category_top.eq.other')
    .order('last_seen_at', { ascending: false })
    .limit(MAX)
  if (error) throw error
  return (data ?? []).filter((r) => r.canonical_name)
}

async function fetchClassifiedCanonicals() {
  // 이미 분류돼 택소노미에 붙은 canonical (근접매칭 기준)
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('canonical_name')
    .not('llm_classified_at', 'is', null)
    .neq('category_top', 'other')
    .limit(4000)
  if (error) throw error
  const set = new Set()
  for (const r of data ?? []) if (r.canonical_name) set.add(r.canonical_name)
  return [...set].map((name) => ({ name, vec: toVec(name) }))
}

async function fetchAliases(productIds) {
  const map = new Map()
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200)
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias, source')
      .in('product_id', chunk)
      .limit(chunk.length * 8)
    for (const r of data ?? []) {
      const cur = map.get(r.product_id) ?? { aliases: [], sources: new Set() }
      if (cur.aliases.length < 6 && r.alias) cur.aliases.push(r.alias)
      if (r.source) cur.sources.add(r.source)
      map.set(r.product_id, cur)
    }
  }
  return map
}

function group1stPass(products) {
  const buckets = new Map()
  for (const p of products) {
    const norm = normalize(p.canonical_name)
    if (!norm) continue
    const arr = buckets.get(norm) ?? []
    arr.push(p)
    buckets.set(norm, arr)
  }
  return [...buckets.values()].map((arr) => ({
    canonical_label: arr[0].canonical_name.slice(0, 60),
    members: arr,
    category_hint: arr.find((x) => x.category_top && x.category_top !== 'other')?.category_top ?? null,
  }))
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
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 400)}`))
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.is_error) return reject(new Error(`claude is_error`))
        resolve({ text: typeof parsed.result === 'string' ? parsed.result : '' })
      } catch {
        reject(new Error(`stdout not JSON: ${stdout.slice(0, 200)}`))
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

async function llmRegroup(firstPass) {
  const candidates = firstPass.slice(0, 80)
  if (candidates.length < 4) return null
  const lines = candidates.map((c, i) => `- id="${i}" label="${c.canonical_label.replace(/"/g, '')}"`)
  const prompt = `${SYSTEM_PROMPT}\n\n다음 ${lines.length}개 라벨을 의미군으로 묶어 JSON 배열로 응답:\n\n${lines.join('\n')}`
  try {
    const { text } = await callClaudeCli(prompt)
    const arr = tryParseArray(text)
    if (!Array.isArray(arr)) return null
    const merged = []
    const usedIdx = new Set()
    for (const g of arr) {
      const ids = Array.isArray(g.member_ids)
        ? g.member_ids.map((x) => Number.parseInt(x, 10)).filter((x) => !Number.isNaN(x))
        : []
      const members = []
      for (const idx of ids) {
        const c = candidates[idx]
        if (!c || usedIdx.has(idx)) continue
        usedIdx.add(idx)
        for (const m of c.members) members.push(m)
      }
      if (members.length === 0) continue
      merged.push({
        canonical_label: String(g.canonical_label ?? '').slice(0, 60) || members[0].canonical_name.slice(0, 60),
        members,
        category_hint: ['health', 'living', 'digital', 'other'].includes(g.category_hint) ? g.category_hint : null,
      })
    }
    for (let i = 0; i < candidates.length; i++) if (!usedIdx.has(i)) merged.push(candidates[i])
    return merged
  } catch (e) {
    console.warn(`[cluster-unclassified] LLM regroup failed: ${e.message}`)
    return null
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'cluster_unclassified',
      triggered_by: 'local_cli',
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

async function upsert(cluster) {
  const { data: existing } = await sb
    .from('jimscanner_emerging_clusters')
    .select('id, status')
    .eq('label', cluster.label)
    .maybeSingle()
  // 이미 승격/기각된 라벨은 건드리지 않음
  if (existing && existing.status !== 'open') return 'skip'
  const payload = { ...cluster, refreshed_at: new Date().toISOString(), llm_model: MODEL }
  if (existing?.id) {
    await sb.from('jimscanner_emerging_clusters').update(payload).eq('id', existing.id)
    return 'update'
  }
  const { error } = await sb.from('jimscanner_emerging_clusters').insert(payload)
  if (error) {
    console.warn(`  insert failed (${cluster.label}): ${error.message}`)
    return 'error'
  }
  return 'insert'
}

async function main() {
  const t0 = Date.now()
  console.log(`[cluster-unclassified] start max=${MAX} threshold=${THRESHOLD} dry-run=${DRY_RUN}`)

  const pool = await fetchPool()
  console.log(`[cluster-unclassified] pool(미분류+기타): ${pool.length}`)
  if (pool.length === 0) {
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    console.log('  nothing to cluster')
    return
  }

  const [aliasMap, classified] = await Promise.all([
    fetchAliases(pool.map((p) => p.id)),
    fetchClassifiedCanonicals(),
  ])
  console.log(`[cluster-unclassified] 기존 분류 canonical: ${classified.length}`)

  let clusters = group1stPass(pool)
  console.log(`[cluster-unclassified] 1차 클러스터: ${clusters.length}`)
  if (!SKIP_LLM) {
    const regrouped = await llmRegroup(clusters)
    if (regrouped) {
      clusters = regrouped
      console.log(`[cluster-unclassified] LLM 재그룹: ${clusters.length}`)
    }
  }

  // 각 클러스터 집계 + 근접매칭 → 화이트스페이스만 남김
  const whitespace = []
  for (const c of clusters) {
    const memberTerms = [...new Set(c.members.map((m) => m.canonical_name))].slice(0, 50)
    const productIds = c.members.map((m) => m.id)
    const sources = new Set()
    let freq = 0
    let firstSeen = null
    let lastSeen = null
    for (const m of c.members) {
      freq += m.alias_count ?? 0
      const a = aliasMap.get(m.id)
      if (a) for (const s of a.sources) sources.add(s)
      if (m.first_seen_at && (!firstSeen || m.first_seen_at < firstSeen)) firstSeen = m.first_seen_at
      if (m.last_seen_at && (!lastSeen || m.last_seen_at > lastSeen)) lastSeen = m.last_seen_at
    }

    // 라벨을 기존 canonical 집합과 근접매칭 (max cosine)
    const labelGrams = bigrams(c.canonical_label)
    let best = 0
    let bestName = null
    for (const cn of classified) {
      const sim = cosine(labelGrams, cn.vec)
      if (sim > best) {
        best = sim
        bestName = cn.name
      }
    }
    if (best >= THRESHOLD) continue // 기존 택소노미에 붙음 → 광맥 아님

    whitespace.push({
      label: c.canonical_label,
      member_terms: memberTerms,
      member_product_ids: productIds,
      category_hint: c.category_hint,
      member_count: memberTerms.length,
      source_count: sources.size,
      total_frequency: freq,
      nearest_canonical: bestName,
      nearest_similarity: Number(best.toFixed(3)),
      first_seen_at: firstSeen,
      last_seen_at: lastSeen,
      status: 'open',
    })
  }
  // 광맥성: 소스폭 → 발화량 순
  whitespace.sort((a, b) => b.source_count - a.source_count || b.total_frequency - a.total_frequency)
  console.log(`[cluster-unclassified] 화이트스페이스 클러스터: ${whitespace.length} (threshold ${THRESHOLD} 미만)`)

  if (DRY_RUN) {
    for (const c of whitespace.slice(0, 15)) {
      console.log(
        `  ${c.label} — 멤버 ${c.member_count} / 소스 ${c.source_count} / freq ${c.total_frequency} / 근접 ${c.nearest_canonical ?? '∅'}(${c.nearest_similarity})`,
      )
    }
    return
  }

  let ins = 0
  let upd = 0
  for (const c of whitespace) {
    const r = await upsert(c)
    if (r === 'insert') ins++
    else if (r === 'update') upd++
  }
  await logRun({
    status: 'ok',
    fetched_count: pool.length,
    inserted_count: ins,
    duration_ms: Date.now() - t0,
  })
  console.log(`[cluster-unclassified] done: new=${ins} updated=${upd} ${Date.now() - t0}ms`)
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error('[cluster-unclassified] fatal:', msg)
  await logRun({ status: 'error', fetched_count: 0, inserted_count: 0, duration_ms: 0, error_message: msg })
  process.exit(1)
})
