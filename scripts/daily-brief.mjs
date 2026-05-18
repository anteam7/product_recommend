#!/usr/bin/env node
/**
 * Daily Brief — 매일 아침 LLM 자동 생성 한국어 상황 요약 + Top 3 액션 카드.
 *
 * 새 cron source 'daily_brief'. run-crons.mjs 마지막 단계 (classify-trends-llm 다음) 에서 spawn.
 *
 * 호출:
 *   node --env-file=.env.local scripts/daily-brief.mjs
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env)
 *   - supabase/daily_briefs.sql 적용된 상태
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

function todayKstDate() {
  // KST = UTC+9. brief_date 는 KST 기준 그날짜.
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 3600_000)
  return kst.toISOString().slice(0, 10)
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400_000)
  return d.toISOString()
}

const SYSTEM_PROMPT = `당신은 한국 위탁판매 플랫폼 운영자의 매일 아침 브리핑 작성자입니다.
입력으로 어제 vs 오늘 데이터 변화, cron 실패, 핀 상품 점수 변화, 미분류 큐 적체량을 받습니다.

❗ 응답 형식 (엄격):
- 첫 줄은 '<<SUMMARY_MD>>'
- 그 뒤 한국어 5문장 이내 마크다운 (** 강조 가능). 운영자가 오늘 무엇을 먼저 봐야 하는지가 분명해야 함.
- 그 다음 줄은 '<<ACTIONS_JSON>>'
- 그 뒤 JSON 배열 (정확히 3개 액션). 각 항목:
  {"title": "한국어 5-12자", "why": "한국어 1문장 (20자 내)", "link": "/admin/..." }
- link 는 반드시 /admin 으로 시작. 트리아지 큐는 /admin/trend-radar/recommend, 핀은 /admin/trend-radar/pins,
  카테고리별 보드는 /admin/trend-radar?cat=health|living|digital, 소스 헬스는 /admin/trend-radar/sources,
  TV 매칭은 /admin/trend-radar/tv-ggsan-match, 상품 디테일은 /admin/trend-radar/products/<id>.
- 코드 펜스, 추가 설명, 인사말 금지.`

function buildUserPrompt(ctx) {
  const lines = []
  lines.push(`## 브리핑 일자: ${ctx.briefDate} (KST)`)
  lines.push('')
  lines.push('## 1) 어제 vs 오늘 — canonical 상품 스냅샷')
  lines.push(`- 총 상품: ${ctx.products.totalToday} (전일 ${ctx.products.totalYesterday}, Δ ${ctx.products.deltaTotal >= 0 ? '+' : ''}${ctx.products.deltaTotal})`)
  lines.push(`- LLM 분류 완료: ${ctx.products.classifiedToday} / ${ctx.products.totalToday}`)
  lines.push(`- 미분류 (큐 적체): ${ctx.products.unclassified}`)
  lines.push(`- 카테고리 분포: ${ctx.products.categoryDist.map((c) => `${c.cat}=${c.count}`).join(', ') || '없음'}`)
  lines.push('')
  lines.push('## 2) 어제 cron 실행 결과')
  lines.push(`- 전체 ${ctx.runs.total} 회 (ok ${ctx.runs.ok} / partial ${ctx.runs.partial} / error ${ctx.runs.error})`)
  if (ctx.runs.failures.length > 0) {
    lines.push(`- 실패 상세:`)
    for (const f of ctx.runs.failures.slice(0, 8)) {
      lines.push(`  · ${f.source} [${f.status}] ${f.error_message?.slice(0, 100) ?? ''}`)
    }
  } else {
    lines.push('- 실패 없음')
  }
  lines.push('')
  lines.push('## 3) 핀 상품 점수 변화 (최근 7일 → 오늘)')
  if (ctx.pinDeltas.length === 0) {
    lines.push('- 핀된 상품 없음 또는 점수 매칭 실패')
  } else {
    for (const p of ctx.pinDeltas.slice(0, 8)) {
      lines.push(`- ${p.keyword} (final ${p.todayScore ?? '-'} vs 전 ${p.prevScore ?? '-'}, Δ ${p.delta >= 0 ? '+' : ''}${p.delta})`)
    }
  }
  lines.push('')
  lines.push('## 4) Top 5 상품 (오늘 final_score)')
  for (const t of ctx.topProducts.slice(0, 5)) {
    lines.push(`- ${t.canonical_name} [${t.category_top}] final=${t.final_score}`)
  }
  lines.push('')
  lines.push('위 데이터로 응답 형식을 따라 작성해 주세요.')
  return lines.join('\n')
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
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 500)}`))
      let parsed
      try { parsed = JSON.parse(stdout) } catch { return reject(new Error(`stdout not JSON: ${stdout.slice(0, 300)}`)) }
      if (parsed.is_error) return reject(new Error(`is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
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

function parseLlmResponse(text) {
  const summaryMarker = '<<SUMMARY_MD>>'
  const actionsMarker = '<<ACTIONS_JSON>>'
  const si = text.indexOf(summaryMarker)
  const ai = text.indexOf(actionsMarker)
  if (si === -1 || ai === -1 || ai < si) {
    return { summary_md: text.trim().slice(0, 2000), actions: [] }
  }
  const summary_md = text.slice(si + summaryMarker.length, ai).trim()
  const jsonText = text.slice(ai + actionsMarker.length).trim()
  let actions = []
  try {
    const a = jsonText.indexOf('[')
    const b = jsonText.lastIndexOf(']')
    if (a !== -1 && b !== -1 && b > a) {
      const parsed = JSON.parse(jsonText.slice(a, b + 1))
      if (Array.isArray(parsed)) actions = parsed
    }
  } catch {}
  const normalized = actions
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      title: typeof x.title === 'string' ? x.title.slice(0, 60) : '',
      why: typeof x.why === 'string' ? x.why.slice(0, 120) : '',
      link: typeof x.link === 'string' && x.link.startsWith('/admin') ? x.link : '/admin/trend-radar',
    }))
    .filter((x) => x.title)
    .slice(0, 3)
  return { summary_md, actions: normalized }
}

async function gatherContext(briefDate) {
  const sinceYesterday = isoDaysAgo(1)
  const since7d = isoDaysAgo(7)

  // 1) products
  const { count: totalToday } = await sb
    .from('jimscanner_trends_products')
    .select('*', { count: 'exact', head: true })
  const { count: totalYesterday } = await sb
    .from('jimscanner_trends_products')
    .select('*', { count: 'exact', head: true })
    .lt('created_at', sinceYesterday)
  const { count: classifiedToday } = await sb
    .from('jimscanner_trends_products')
    .select('*', { count: 'exact', head: true })
    .not('llm_classified_at', 'is', null)
  const unclassified = (totalToday ?? 0) - (classifiedToday ?? 0)

  // 카테고리 분포
  const { data: catData } = await sb
    .from('jimscanner_trends_products')
    .select('category_top')
    .limit(5000)
  const catCounts = new Map()
  for (const r of catData ?? []) {
    const k = r.category_top ?? 'other'
    catCounts.set(k, (catCounts.get(k) ?? 0) + 1)
  }
  const categoryDist = [...catCounts.entries()]
    .map(([cat, count]) => ({ cat, count }))
    .sort((a, b) => b.count - a.count)

  // 2) runs 어제
  const { data: runs } = await sb
    .from('jimscanner_trends_runs')
    .select('source, status, error_message, started_at')
    .gte('started_at', sinceYesterday)
    .order('started_at', { ascending: false })
    .limit(200)
  const runsTotal = runs?.length ?? 0
  const runsOk = (runs ?? []).filter((r) => r.status === 'ok').length
  const runsPartial = (runs ?? []).filter((r) => r.status === 'partial').length
  const runsError = (runs ?? []).filter((r) => r.status === 'error').length
  const failures = (runs ?? []).filter((r) => r.status !== 'ok')

  // 3) 핀 상품 점수 변화
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, pinned_at')
    .order('pinned_at', { ascending: false })
    .limit(30)
  const pinKeywords = (pins ?? []).map((p) => p.keyword).filter(Boolean)
  const pinDeltas = []
  if (pinKeywords.length > 0) {
    // 매칭: product.canonical_name == keyword
    const { data: matchedProducts } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('canonical_name', pinKeywords)
    const pids = (matchedProducts ?? []).map((p) => p.id)
    if (pids.length > 0) {
      const { data: recentScores } = await sb
        .from('jimscanner_trends_scores')
        .select('product_id, final_score, computed_at')
        .in('product_id', pids)
        .gte('computed_at', since7d)
        .order('computed_at', { ascending: false })
        .limit(2000)
      const latest = new Map()
      const prev = new Map()
      const oneDayAgo = sinceYesterday
      for (const s of recentScores ?? []) {
        if (s.computed_at >= oneDayAgo) {
          if (!latest.has(s.product_id)) latest.set(s.product_id, s.final_score)
        } else {
          if (!prev.has(s.product_id)) prev.set(s.product_id, s.final_score)
        }
      }
      for (const p of matchedProducts ?? []) {
        const t = latest.get(p.id)
        const prv = prev.get(p.id)
        if (t == null && prv == null) continue
        const delta = (t ?? 0) - (prv ?? 0)
        pinDeltas.push({ keyword: p.canonical_name, todayScore: t, prevScore: prv, delta })
      }
      pinDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    }
  }

  // 4) Top 상품 (오늘 final_score)
  const { data: topScores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(500)
  const seen = new Set()
  const topMap = new Map()
  for (const s of topScores ?? []) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    topMap.set(s.product_id, s.final_score)
  }
  const topIds = [...topMap.entries()]
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 5)
    .map(([id]) => id)
  const { data: topProductRows } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', topIds)
  const topProducts = (topProductRows ?? [])
    .map((p) => ({
      canonical_name: p.canonical_name,
      category_top: p.category_top,
      final_score: topMap.get(p.id) ?? 0,
    }))
    .sort((a, b) => b.final_score - a.final_score)

  return {
    briefDate,
    products: {
      totalToday: totalToday ?? 0,
      totalYesterday: totalYesterday ?? 0,
      deltaTotal: (totalToday ?? 0) - (totalYesterday ?? 0),
      classifiedToday: classifiedToday ?? 0,
      unclassified,
      categoryDist,
    },
    runs: {
      total: runsTotal,
      ok: runsOk,
      partial: runsPartial,
      error: runsError,
      failures: failures.map((f) => ({
        source: f.source,
        status: f.status,
        error_message: f.error_message,
      })),
    },
    pinDeltas,
    topProducts,
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'daily_brief',
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
  const briefDate = todayKstDate()
  console.log(`[${new Date().toISOString()}] daily-brief start (brief_date=${briefDate})`)

  // 이미 오늘자 brief 있으면 skip
  const { data: existing } = await sb
    .from('jimscanner_daily_briefs')
    .select('brief_date')
    .eq('brief_date', briefDate)
    .maybeSingle()
  if (existing) {
    console.log(`  skip: brief already exists for ${briefDate}`)
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  const ctx = await gatherContext(briefDate)
  console.log(`  context gathered: ${ctx.products.totalToday} products, ${ctx.runs.total} runs, ${ctx.pinDeltas.length} pin deltas`)

  const userPrompt = buildUserPrompt(ctx)
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`

  let llm
  try {
    llm = await callClaudeCli(fullPrompt)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`  llm call failed: ${msg}`)
    await logRun({
      status: 'error',
      fetched_count: 1,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
      error_message: msg,
    })
    process.exit(1)
  }

  const parsed = parseLlmResponse(llm.text)
  if (!parsed.summary_md) {
    console.error('  llm response had no summary_md; aborting insert')
    await logRun({
      status: 'partial',
      fetched_count: 1,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
      error_message: 'empty summary_md',
    })
    process.exit(1)
  }

  const durationMs = Date.now() - t0
  const { error } = await sb.from('jimscanner_daily_briefs').insert({
    brief_date: briefDate,
    summary_md: parsed.summary_md,
    actions: parsed.actions,
    context: ctx,
    model: MODEL,
    prompt_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
    cost_usd: llm.costUsd,
    duration_ms: durationMs,
  })
  if (error) {
    console.error(`  insert failed: ${error.message}`)
    await logRun({
      status: 'error',
      fetched_count: 1,
      inserted_count: 0,
      duration_ms: durationMs,
      error_message: error.message,
    })
    process.exit(1)
  }

  await logRun({
    status: 'ok',
    fetched_count: 1,
    inserted_count: 1,
    duration_ms: durationMs,
  })
  console.log(`[${new Date().toISOString()}] done — summary=${parsed.summary_md.length}chars, actions=${parsed.actions.length}, $${llm.costUsd.toFixed(4)}, ${durationMs}ms`)
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
