#!/usr/bin/env node
/**
 * 트렌드 레이더 — Go/No-Go 의사결정 브리프 생성 (로컬 전용).
 *
 * final_score 상위 N개 + 임계 신규진입자를 대상으로, 이미 적재된
 * 4점수·score_components·aliases(증거 발화)·supplier 행을 한 프롬프트로
 * 묶어 LLM(claude CLI 인프라 재사용)에 넣고 구조화 브리프를 생성·캐시한다.
 *
 * UI:
 *   - products/[id] 상단 '브리프' 카드 (평결 배지 + 근거3 + 블로커 + 다음 액션)
 *   - opportunity 'Go 후보 피드'
 *
 * 호출:
 *   node --env-file=.env.local scripts/trends-generate-briefs.mjs
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - 마이그레이션 supabase/trends_briefs.sql 적용 후
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
const TOP_N = 30 // final_score 상위 후보
const NEW_ENTRANT_MIN_FINAL = 55 // 임계 신규진입자 (최근 적재 + final≥)
const STALE_HOURS = 24 // 이 시간 안에 brief 있으면 재생성 스킵
const MAX_REQ_PER_RUN = 40

const SYSTEM_PROMPT = `한국 위탁 판매 발굴 후보의 Go/No-Go 트리아지 분석가.
주어진 상품 1건의 점수·증거·도매 데이터를 보고 운영자 의사결정 브리프를 작성.

❗ 절대 규칙:
- 응답 첫 글자는 '{', 마지막 글자는 '}'
- 설명·코드펜스(\`\`\`)·markdown 금지, JSON 객체 하나만

필드:
- verdict: "go" | "watch" | "pass"
  · go: 지금 등록 추진할 만함 (트렌드·마진·소싱 모두 우호)
  · watch: 신호 약함/불확실, 추가 관찰
  · pass: 진입 부적합 (경쟁 과열·소싱 불가·수요 미약)
- confidence: 0.0~1.0 (평결 확신도)
- top_reasons: 평결 근거 3개 배열 (각 20자 이내 한국어, 점수·증거 기반 구체)
- biggest_blocker: 가장 큰 진입 장애 1문장 (없으면 null)
- recommended_action: 운영자 다음 액션 1문장 (예: "ggsan 단가 확인 후 19,000원대 등록")
- suggested_price_band: 권장 판매가 밴드 (예: "19,000~24,000원", 근거 부족하면 null)

점수는 0~100. final_score 가 종합 우선순위. supplier 의 price_krw 와 moq 로 마진·소싱성 판단.`

function buildUserPrompt(item) {
  const sup = (item.suppliers ?? [])
    .map(
      (s) =>
        `${s.supplier_source}: price_krw=${s.price_krw ?? '?'} moq=${s.moq ?? '?'} lead=${s.lead_time_days ?? '?'}일 stock=${s.inventory_status ?? '?'}`,
    )
    .join(' | ')
  return `상품 1건 브리프 작성:
canonical_name="${item.canonical_name}"
brand=${item.brand ?? 'null'} category=${item.category_top}/${item.category_mid ?? '?'}
intent=${item.intent_label ?? '?'} desc="${item.description ?? ''}"

점수: final=${item.final_score} trend=${item.trend_score} commerce=${item.commerce_score} supplier=${item.supplier_score} competition=${item.competition_score}
score_components=${JSON.stringify(item.score_components ?? {})}

증거 발화(aliases): ${item.sample_aliases.join(' | ') || '없음'}
출처: ${item.sample_sources.join(',') || '없음'}
도매(supplier): ${sup || '없음'}`
}

function tryParseObject(text) {
  if (!text) return null
  const attempt = (s) => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  let v = attempt(text)
  if (v) return v
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    v = attempt(fence[1])
    if (v) return v
  }
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a !== -1 && b !== -1 && b > a) {
    v = attempt(text.slice(a, b + 1))
    if (v) return v
  }
  return null
}

function normalizeBrief(o) {
  if (!o || typeof o !== 'object') return null
  const verdict = ['go', 'watch', 'pass'].includes(o.verdict) ? o.verdict : null
  if (!verdict) return null
  let conf = Number(o.confidence)
  if (!Number.isFinite(conf)) conf = 0.5
  conf = Math.max(0, Math.min(1, conf))
  const reasons = Array.isArray(o.top_reasons)
    ? o.top_reasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 60)).slice(0, 3)
    : []
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
  return {
    verdict,
    confidence: conf,
    top_reasons: reasons,
    biggest_blocker: str(o.biggest_blocker, 200),
    recommended_action: str(o.recommended_action, 200),
    suggested_price_band: str(o.suggested_price_band, 60),
  }
}

function callClaudeCli(prompt) {
  // claude CLI 가 ANTHROPIC_API_KEY 를 보면 구독(Max) 대신 API 키로 인증.
  // 자식 env 에서 API 키류를 제거해서 claude.ai 구독으로 동작하게 한다.
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
        costUsd: parsed.total_cost_usd ?? 0,
      })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

/** product_id 별 최신 score 1행을 모은다. */
async function fetchLatestScores() {
  const { data } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)
  const seen = new Set()
  const latest = []
  for (const s of data ?? []) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  return latest
}

/** STALE_HOURS 안에 brief 가 있는 product_id 집합. */
async function fetchRecentlyBriefed() {
  const since = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_briefs')
    .select('product_id, generated_at')
    .gte('generated_at', since)
  return new Set((data ?? []).map((r) => r.product_id))
}

async function fetchProducts(ids) {
  if (ids.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select(
      'id, canonical_name, brand, category_top, category_mid, intent_label, description, first_seen_at',
    )
    .in('id', ids)
  return new Map((data ?? []).map((p) => [p.id, p]))
}

async function fetchSampleAliases(ids) {
  if (ids.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, source')
    .in('product_id', ids)
    .order('confidence', { ascending: false })
    .limit(ids.length * 6)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    if (list.length < 5) list.push(r)
    map.set(r.product_id, list)
  }
  return map
}

async function fetchSuppliers(ids) {
  if (ids.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, supplier_source, price_krw, moq, lead_time_days, inventory_status, collected_at')
    .in('product_id', ids)
    .order('collected_at', { ascending: false })
    .limit(ids.length * 4)
  const map = new Map()
  for (const r of data ?? []) {
    const list = map.get(r.product_id) ?? []
    if (list.length < 3) list.push(r)
    map.set(r.product_id, list)
  }
  return map
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'trends_generate_briefs',
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
  console.log(`[${new Date().toISOString()}] trends-generate-briefs start`)

  const scores = await fetchLatestScores()
  if (scores.length === 0) {
    console.log('  done: score 없음')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }

  const briefedRecently = await fetchRecentlyBriefed()

  // 대상 선정: final_score 상위 TOP_N + 임계 신규진입자, STALE 한 것만.
  const byFinal = [...scores].sort((a, b) => b.final_score - a.final_score)
  const topIds = byFinal.slice(0, TOP_N).map((s) => s.product_id)
  const topSet = new Set(topIds)

  const prodMeta = await fetchProducts(scores.map((s) => s.product_id))
  const newCutoff = Date.now() - 72 * 3600 * 1000 // 최근 3일 내 첫 등장
  const candidates = byFinal.filter((s) => {
    if (briefedRecently.has(s.product_id)) return false
    if (topSet.has(s.product_id)) return true
    const p = prodMeta.get(s.product_id)
    const firstSeen = p?.first_seen_at ? new Date(p.first_seen_at).getTime() : 0
    return s.final_score >= NEW_ENTRANT_MIN_FINAL && firstSeen >= newCutoff
  })

  if (candidates.length === 0) {
    console.log('  done: 신규 브리프 대상 없음 (모두 최신)')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }

  const targetIds = candidates.map((s) => s.product_id)
  const [aliasMap, supplierMap] = await Promise.all([
    fetchSampleAliases(targetIds),
    fetchSuppliers(targetIds),
  ])

  console.log(`  candidates: ${candidates.length} (top ${topIds.length} + 신규진입)`)

  let reqCount = 0
  let inserted = 0
  let totalCostUsd = 0
  let lastError = null

  for (const s of candidates) {
    if (reqCount >= MAX_REQ_PER_RUN) break
    const p = prodMeta.get(s.product_id)
    if (!p) continue
    const sample = aliasMap.get(s.product_id) ?? []
    const item = {
      ...p,
      trend_score: s.trend_score,
      commerce_score: s.commerce_score,
      supplier_score: s.supplier_score,
      competition_score: s.competition_score,
      final_score: s.final_score,
      score_components: s.score_components,
      sample_aliases: sample.map((a) => a.alias),
      sample_sources: [...new Set(sample.map((a) => a.source ?? '').filter(Boolean))],
      suppliers: supplierMap.get(s.product_id) ?? [],
    }

    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(item)}`
    try {
      const out = await callClaudeCli(prompt)
      reqCount++
      totalCostUsd += out.costUsd
      const brief = normalizeBrief(tryParseObject(out.text))
      if (!brief) {
        console.error(`  ${p.canonical_name}: parse 실패`)
        continue
      }
      const { error } = await sb.from('jimscanner_trends_briefs').insert({
        product_id: s.product_id,
        verdict: brief.verdict,
        confidence: brief.confidence,
        top_reasons: brief.top_reasons,
        biggest_blocker: brief.biggest_blocker,
        recommended_action: brief.recommended_action,
        suggested_price_band: brief.suggested_price_band,
        basis: {
          final_score: s.final_score,
          trend_score: s.trend_score,
          commerce_score: s.commerce_score,
          supplier_score: s.supplier_score,
          competition_score: s.competition_score,
        },
        model: MODEL,
      })
      if (error) {
        lastError = error.message
        console.error(`  ${p.canonical_name}: insert 실패 ${error.message}`)
        continue
      }
      inserted++
      console.log(
        `  [${brief.verdict.toUpperCase()}] ${p.canonical_name} (conf ${brief.confidence.toFixed(2)}, $${out.costUsd.toFixed(4)})`,
      )
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  ${p.canonical_name}: ${lastError}`)
      break
    }
  }

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: candidates.length,
    inserted_count: inserted,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${inserted} briefs, $${totalCostUsd.toFixed(4)}, ${Date.now() - t0}ms`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({ status: 'error', fetched_count: 0, inserted_count: 0, duration_ms: 0, error_message: msg })
  process.exit(1)
})
