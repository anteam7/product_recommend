#!/usr/bin/env node
/**
 * 소싱 검색어 자동생성 — 도매처별 멀티마켓 검색어를 LLM(claude CLI)으로 생성.
 *
 * 소싱 공백 큐(/admin/trend-radar/sourcing-gap)에 노출되는 '죽은 리드'
 * (supplier 미매칭 / stale)에 대해, canonical_name + aliases 로부터
 * 도매처별 최적 검색어를 만들어 jimscanner_trends_products.sourcing_queries
 * (jsonb) 에 캐싱한다. 운영자는 캐싱된 검색어로 각 마켓을 딥링크로 바로 연다.
 *
 *   - 도매꾹 / 오너클랜 → 한글 동의어 (국내 도매)
 *   - 1688              → 중국어 (중국 도매 원천)
 *   - aliexpress        → 영어 (글로벌 도매)
 *
 * 호출:
 *   node --env-file=.env.local scripts/trends-gen-sourcing-queries.mjs
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료 (구독 인증)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env)
 *   - supabase/trends_sourcing_gap.sql 마이그레이션 적용 완료
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
const MAX_REQ_PER_RUN = 40
const STALE_DAYS = 30
const MIN_FINAL_SCORE = 30
const GAP_LIMIT = 200

const SYSTEM_PROMPT = `한국 위탁 판매 소싱 검색어 생성기. 입력 상품 리스트 → 도매처별 검색어 JSON 배열로 변환.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 설명·코드펜스(\`\`\`)·markdown 금지
- 입력 id 그대로 유지

각 항목 필드 (전부 필수):
- id: 입력 id 그대로
- domeggook: 도매꾹(국내 도매몰) 검색용 한글 검색어. 브랜드 제거, 핵심 품목 위주, 너무 길지 않게.
- ownerclan: 오너클랜(국내 도매) 검색용 한글 검색어. domeggook 과 살짝 다른 동의어/대체어로.
- q1688: 1688(중국 도매) 검색용 중국어 검색어. 해당 품목의 중국어 일반명.
- aliexpress: AliExpress(글로벌) 검색용 영어 검색어. 일반적인 영어 품목명.

지침:
- 검색어는 '도매처에서 같은 물건을 찾기 위한' 키워드. 마케팅 문구 X.
- 효능·브랜드·용량 수식어는 빼고 물건 본질로.

예시 입력: - id="abc" name="오메가3" cat=health aliases=[종근당 오메가3 | rTG 오메가3]
예시 출력: [{"id":"abc","domeggook":"오메가3 영양제","ownerclan":"알티지 오메가3","q1688":"鱼油 omega3","aliexpress":"omega 3 fish oil softgel"}]`

function buildUserPrompt(items) {
  const lines = items.map(
    (it) =>
      `- id="${it.id}" name="${it.name}" cat=${it.category_top} aliases=[${it.sample_aliases.slice(0, 4).join(' | ')}]`,
  )
  return `다음 ${items.length}개 상품의 도매처별 소싱 검색어를 JSON 배열로 응답:\n\n${lines.join('\n')}`
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

function s(v) {
  return typeof v === 'string' ? v.trim().slice(0, 80) : ''
}

function normalizeResult(o, fallbackId) {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? fallbackId).trim()
  if (!id) return null
  const domeggook = s(o.domeggook)
  const ownerclan = s(o.ownerclan) || domeggook
  const q1688 = s(o.q1688)
  const aliexpress = s(o.aliexpress)
  if (!domeggook && !q1688 && !aliexpress) return null
  return { id, domeggook, ownerclan, q1688, aliexpress }
}

function callClaudeCli(prompt) {
  // claude CLI 가 ANTHROPIC_API_KEY 를 보면 구독 대신 API 키로 인증.
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

async function fetchGapCandidates() {
  // 소싱 공백 큐 RPC 로 '죽은 리드' 조회 후, sourcing_queries 미생성 분만.
  const { data, error } = await sb.rpc('jimscanner_trends_sourcing_gap', {
    stale_days: STALE_DAYS,
    min_final_score: MIN_FINAL_SCORE,
    result_limit: GAP_LIMIT,
  })
  if (error) throw new Error(`gap rpc: ${error.message}`)
  return (data ?? []).filter((r) => !r.sourcing_queries)
}

async function fetchSampleAliases(productIds) {
  if (productIds.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, confidence')
    .in('product_id', productIds)
    .order('confidence', { ascending: false })
    .limit(productIds.length * 5)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    if (list.length < 4) list.push(r.alias)
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
          sourcing_queries: {
            domeggook: r.domeggook,
            ownerclan: r.ownerclan,
            '1688': r.q1688,
            aliexpress: r.aliexpress,
            generated_at: now,
            model: MODEL,
          },
        })
        .eq('id', r.id),
    ),
  )
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] trends-gen-sourcing-queries start`)

  const candidates = await fetchGapCandidates()
  if (candidates.length === 0) {
    console.log('  done: 검색어 생성 대상 없음 (0 candidates)')
    return
  }
  console.log(`  candidates (gap, 미생성): ${candidates.length}`)

  const aliasMap = await fetchSampleAliases(candidates.map((c) => c.product_id))

  const allResults = []
  let reqCount = 0
  let totalCostUsd = 0
  let lastError = null

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const inputs = batch.map((c) => ({
      id: c.product_id,
      name: c.canonical_name,
      category_top: c.category_top,
      sample_aliases: aliasMap.get(c.product_id) ?? [],
    }))

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
        `  batch ${reqCount}: ${batch.length} in → ${byId.size} queries ($${out.costUsd.toFixed(4)})`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  batch ${reqCount + 1} failed: ${lastError}`)
      break
    }
  }

  if (allResults.length > 0) await applyResults(allResults)

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${allResults.length} products, $${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
