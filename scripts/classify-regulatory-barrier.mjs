#!/usr/bin/env node
/**
 * 위탁 등록 인증·규제 진입장벽 분류 — Claude Code CLI (로컬 전용).
 *
 * jimscanner_trends_products 의 canonical_name + category_top + category_mid
 * + description + 속성 키워드(alias) 로 '솔로 위탁 셀러가 즉시 등록 가능한가'
 * 를 판정해 barrier_* 컬럼에 기록한다.
 *
 * 마이그레이션 선행 필수: supabase/trends_regulatory_barrier.sql
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-regulatory-barrier.mjs
 *
 * 요구:
 *   - claude CLI 가 PATH 에 있고 인증 완료
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * 패턴은 scripts/classify-trends-llm.mjs 를 그대로 따른다.
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
const BATCH_SIZE = 20
const MAX_REQ_PER_RUN = 40
const PRODUCT_FETCH_LIMIT = MAX_REQ_PER_RUN * BATCH_SIZE

const BARRIER_TYPES = ['none', 'kc_safety', 'food_health', 'cosmetic', 'medical_device', 'other']
const COST_BANDS = ['free', 'low', 'mid', 'high']

const SYSTEM_PROMPT = `한국 오픈마켓 '위탁(솔로) 셀러'의 상품 등록 적격성 판정기.
입력 상품 리스트를, 셀러가 별도 인증·신고 없이 즉시 등록 가능한지 규제 진입장벽 축으로 분류해 JSON 배열로 변환.

❗ 절대 규칙:
- 응답 첫 글자는 '[', 마지막 글자는 ']'
- 설명·코드펜스(\`\`\`)·markdown 금지
- 입력 id 그대로 유지

각 항목 필드:
- barrier_type: none | kc_safety | food_health | cosmetic | medical_device | other
  · none: 인증 없이 즉시 등록 가능 (일반 잡화·주방·수납·패션·문구·반려용품 등)
  · kc_safety: 전기생활용품안전법(전안법) KC 인증 대상 (전기·전자제품, 충전기·케이블, 아동용품, 일부 생활화학제품)
  · food_health: 식약처 신고/수입식품 신고 대상 (건강기능식품·영양제·일반식품·다이어트보조식품)
  · cosmetic: 화장품책임판매업 등록 대상 (스킨케어·메이크업·마스크팩·기능성화장품)
  · medical_device: 의료기기 판매업 신고/허가 대상 (혈압계·체온계·마사지기 일부·콘택트렌즈)
  · other: 위 5종 외 별도 인증 (예: 안경·의약외품)
- est_cost_band: free | low | mid | high  (인증 취득 비용대. none=free, 신고만=low, 시험성적+등록=mid, 업 등록+시설=high)
- est_days: 정수. 인증 취득 예상 소요일 (none=0, 신고류 7~30, 업 등록 30~90)
- evidence: 25자 이내 1문장. 왜 그 barrier_type 인지 근거 (한국어)

판정 지침:
- category_top=health 면 대부분 food_health (건강식품·영양제는 식약처 신고 대상). 단순 식품용기·텀블러는 none.
- 전원/배터리/충전 들어가면 kc_safety 의심.
- 애매하면 더 보수적(장벽 있음) 쪽으로. 단 명백한 일반잡화는 none.

예시 입력: - id="a1" name="오메가3" top=health mid=오메가3 desc="혈행건강 영양제" kw=[종근당 오메가3 | 알티지]
예시 출력: [{"id":"a1","barrier_type":"food_health","est_cost_band":"low","est_days":15,"evidence":"건강기능식품 식약처 신고 대상"}]`

function buildUserPrompt(items) {
  const lines = items.map(
    (it) =>
      `- id="${it.id}" name="${it.name}" top=${it.category_top} mid=${it.category_mid || '-'} desc="${it.description || '-'}" kw=[${it.sample_aliases.slice(0, 3).join(' | ')}]`,
  )
  return `다음 ${items.length}개 상품의 위탁 등록 규제 진입장벽을 판정해 JSON 배열로 응답:\n\n${lines.join('\n')}`
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

function normalizeResult(o, fallbackId) {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? fallbackId).trim()
  if (!id) return null
  const barrier = BARRIER_TYPES.includes(o.barrier_type) ? o.barrier_type : 'other'
  const band = COST_BANDS.includes(o.est_cost_band)
    ? o.est_cost_band
    : barrier === 'none'
      ? 'free'
      : 'low'
  let days = Number.isFinite(Number(o.est_days)) ? Math.max(0, Math.round(Number(o.est_days))) : null
  if (days == null) days = barrier === 'none' ? 0 : 15
  return {
    id,
    barrier_type: barrier,
    barrier_est_cost_band: band,
    barrier_est_days: days,
    barrier_evidence:
      typeof o.evidence === 'string' ? o.evidence.trim().slice(0, 120) : '',
  }
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

async function fetchCandidates() {
  // 분류(canonical) 완료 + barrier 미판정 상품 우선
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, description, alias_count, updated_at')
    .is('barrier_classified_at', null)
    .not('canonical_name', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(PRODUCT_FETCH_LIMIT)
  return data ?? []
}

async function fetchSampleAliases(productIds) {
  if (productIds.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('product_id', productIds)
    .order('confidence', { ascending: false })
    .limit(productIds.length * 5)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    if (list.length < 3) list.push(r)
    map.set(r.product_id, list)
  }
  return map
}

async function applyResults(results) {
  if (results.length === 0) return
  const now = new Date().toISOString()
  await Promise.all(
    results.map((r) =>
      sb
        .from('jimscanner_trends_products')
        .update({
          barrier_type: r.barrier_type,
          barrier_est_cost_band: r.barrier_est_cost_band,
          barrier_est_days: r.barrier_est_days,
          barrier_evidence: r.barrier_evidence,
          barrier_classified_at: now,
          barrier_model: MODEL,
        })
        .eq('id', r.id),
    ),
  )
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'classify_regulatory_barrier',
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
  console.log(`[${new Date().toISOString()}] classify-regulatory-barrier start`)

  const candidates = await fetchCandidates()
  if (candidates.length === 0) {
    console.log('  done: 판정 대상 없음 (0 candidates)')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }
  console.log(`  candidates: ${candidates.length}`)

  const aliasMap = await fetchSampleAliases(candidates.map((c) => c.id))

  const allResults = []
  let reqCount = 0
  let totalCostUsd = 0
  let lastError = null

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break

    const batch = candidates.slice(i, i + BATCH_SIZE)
    const inputs = batch.map((c) => {
      const sample = aliasMap.get(c.id) ?? []
      return {
        id: c.id,
        name: c.canonical_name,
        category_top: c.category_top,
        category_mid: c.category_mid,
        description: c.description,
        sample_aliases: sample.map((a) => a.alias),
      }
    })

    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(inputs)}`

    try {
      const out = await callClaudeCli(fullPrompt)
      reqCount++
      totalCostUsd += out.costUsd
      const arr = tryParseJsonArray(out.text) ?? []
      const byId = new Map()
      for (let j = 0; j < arr.length; j++) {
        const r = normalizeResult(arr[j], inputs[j]?.id ?? '')
        if (r) byId.set(r.id, r)
      }
      for (const it of inputs) {
        const r = byId.get(it.id)
        if (r) allResults.push(r)
      }
      console.log(
        `  batch ${reqCount}: ${batch.length} in → ${byId.size} judged ($${out.costUsd.toFixed(4)})`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch ${reqCount + 1} failed: ${lastError}`)
      break
    }
  }

  if (allResults.length > 0) await applyResults(allResults)

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: candidates.length,
    inserted_count: allResults.length,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${allResults.length} judged, $${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({ status: 'error', fetched_count: 0, inserted_count: 0, duration_ms: 0, error_message: msg })
  process.exit(1)
})
