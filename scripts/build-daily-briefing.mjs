#!/usr/bin/env node
/**
 * 아침 발굴 브리핑 빌더 — 24h Δ 자동 감지·서술 다이제스트.
 *
 * 15개 분산 보드를 순회하지 않고 "무엇이 바뀌었나"를 한 화면에서 읽게 한다.
 * 매일 1회 핵심 델타를 순수 SQL/JS 로 계산해 jimscanner_trends_briefings 에 적재.
 *
 * 델타 엔진:
 *   ① final_score 24h 상승·하락 Top 무버 (scores 최근 2스냅샷 diff)
 *   ② 신규 Top-N 진입/이탈 (전일 대비)
 *   ③ 수요 부상 × ggsan 신규입고 교차 매치 (recommend RPC 상위)
 *   ④ heartbeat 지연 / 소스 error / 신선도 경보
 *   ⑤ 분류 적체(미분류) 증감
 *
 * 계산된 델타만 Claude CLI(예산 인지, ANTHROPIC_API_KEY 분리)에 넘겨
 * 한국어 3~5줄 서술로 합성. 실패 시 결정론적 한국어 폴백.
 *
 * 호출:
 *   node --env-file=.env.local scripts/build-daily-briefing.mjs
 *   node --env-file=.env.local scripts/build-daily-briefing.mjs --no-narrative
 *
 * 요구: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env),
 *       서술 합성 시 claude CLI 가 PATH 에 있고 인증된 상태.
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

const TOP_N = 30 // Top-N 진입/이탈 판정 경계
const MOVER_LIMIT = 5 // 상승/하락 각각 표시 개수
const GGSAN_LIMIT = 5 // 교차 매치 표시 개수
const HEARTBEAT_STALE_HOURS = 24 // 신선도 경보 임계

const args = process.argv.slice(2)
const skipNarrative = args.includes('--no-narrative')

// KST(UTC+9) 기준 오늘 날짜 (briefing_date PK)
function kstDateStr() {
  const kst = new Date(Date.now() + 9 * 3600_000)
  return kst.toISOString().slice(0, 10)
}

// ── ① + ② 점수 무버 & Top-N 진입/이탈 ─────────────────────────
async function computeScoreDeltas() {
  // 최근 3일치 score row 수집 → product 별 (latest, prev) 2스냅샷 diff.
  const since = new Date(Date.now() - 3 * 86400_000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: false })
    .limit(8000)

  const rows = data ?? []
  // product 별 최근 2개 (이미 desc 정렬이라 첫 2개가 latest/prev)
  const byProduct = new Map()
  for (const r of rows) {
    const list = byProduct.get(r.product_id) ?? []
    if (list.length < 2) list.push(r)
    byProduct.set(r.product_id, list)
  }

  const deltas = []
  const curTop = []
  const prevTop = []
  for (const [pid, list] of byProduct) {
    const curr = Number(list[0]?.final_score ?? 0)
    const prev = list[1] != null ? Number(list[1].final_score) : null
    curTop.push({ pid, score: curr })
    if (prev != null) {
      prevTop.push({ pid, score: prev })
      deltas.push({ product_id: pid, prev, curr, delta: Math.round((curr - prev) * 10) / 10 })
    }
  }

  // 이름 매핑
  const ids = [...byProduct.keys()]
  const nameMap = new Map()
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', ids)
    for (const p of prods ?? []) nameMap.set(p.id, p.canonical_name)
  }
  const nm = (id) => nameMap.get(id) ?? '(이름 미상)'

  const up = deltas
    .filter((d) => d.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, MOVER_LIMIT)
    .map((d) => ({ ...d, name: nm(d.product_id) }))
  const down = deltas
    .filter((d) => d.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, MOVER_LIMIT)
    .map((d) => ({ ...d, name: nm(d.product_id) }))

  // Top-N 진입/이탈
  const curSet = new Set(
    curTop.sort((a, b) => b.score - a.score).slice(0, TOP_N).map((x) => x.pid),
  )
  const prevSet = new Set(
    prevTop.sort((a, b) => b.score - a.score).slice(0, TOP_N).map((x) => x.pid),
  )
  const curScore = new Map(curTop.map((x) => [x.pid, x.score]))
  const entered = [...curSet]
    .filter((pid) => !prevSet.has(pid))
    .map((pid) => ({ product_id: pid, name: nm(pid), score: Math.round((curScore.get(pid) ?? 0) * 10) / 10 }))
    .sort((a, b) => b.score - a.score)
  const exited = [...prevSet]
    .filter((pid) => !curSet.has(pid))
    .map((pid) => ({ product_id: pid, name: nm(pid) }))

  return { movers: { up, down }, entries: { entered, exited } }
}

// ── ③ 수요 부상 × ggsan 교차 매치 ──────────────────────────────
async function computeGgsanCross() {
  try {
    const { data, error } = await sb.rpc('jimscanner_ggsan_recommend', {
      days_window: 14,
      min_sim: 0.2,
      min_score: 0.5,
      result_limit: 50,
    })
    if (error || !data) return []
    return data
      .slice(0, GGSAN_LIMIT)
      .map((r) => ({
        goods_no: r.goods_no,
        title: r.title,
        final_score: Math.round(Number(r.final_score) * 10) / 10,
        is_imminent: !!r.is_imminent,
        detail_url: r.detail_url ?? null,
      }))
  } catch {
    return []
  }
}

// ── ④ heartbeat / 소스 신선도 경보 ────────────────────────────
async function computeAlerts() {
  const alerts = []
  try {
    const { data: hb } = await sb
      .from('jimscanner_trends_heartbeat')
      .select('heartbeat_at, last_collector, last_run_status')
      .eq('id', 'main')
      .maybeSingle()
    if (hb) {
      const ageH = (Date.now() - new Date(hb.heartbeat_at).getTime()) / 3600_000
      if (ageH >= HEARTBEAT_STALE_HOURS) {
        alerts.push({
          kind: 'heartbeat',
          severity: 'high',
          message: `로컬 수집기 heartbeat ${Math.round(ageH)}h 지연 (마지막: ${hb.last_collector ?? '?'})`,
        })
      }
      if (hb.last_run_status === 'error') {
        alerts.push({ kind: 'collector', severity: 'high', message: `마지막 수집 상태 error (${hb.last_collector ?? '?'})` })
      }
    }
  } catch {}

  // 최근 24h 내 error 상태 run
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data: runs } = await sb
      .from('jimscanner_trends_runs')
      .select('source, status, error_message, finished_at')
      .gte('finished_at', since)
      .eq('status', 'error')
      .order('finished_at', { ascending: false })
      .limit(5)
    for (const r of runs ?? []) {
      alerts.push({
        kind: 'run_error',
        severity: 'mid',
        message: `${r.source} 실패: ${(r.error_message ?? '').slice(0, 80) || '원인 미상'}`,
      })
    }
  } catch {}

  return alerts
}

// ── ⑤ 분류 적체 증감 ─────────────────────────────────────────
async function computeBacklog(prevPayload) {
  let unclassified = 0
  try {
    const { count } = await sb
      .from('jimscanner_trends_products')
      .select('*', { count: 'exact', head: true })
      .is('llm_classified_at', null)
    unclassified = count ?? 0
  } catch {}
  const prev = prevPayload?.backlog?.unclassified
  const delta = typeof prev === 'number' ? unclassified - prev : null
  return { unclassified, delta }
}

// ── 서술 합성 (Claude CLI, 예산 인지) ─────────────────────────
function callClaudeCli(prompt) {
  // claude CLI 가 ANTHROPIC_API_KEY 를 보면 구독 대신 API 키로 인증.
  // 자식 env 에서 API 키류 제거 → claude.ai 구독으로 동작.
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', 'haiku', '--output-format', 'json'], {
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
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 300)}`))
      let parsed
      try { parsed = JSON.parse(stdout) } catch { return reject(new Error('claude stdout not JSON')) }
      if (parsed.is_error) return reject(new Error('claude is_error'))
      resolve(typeof parsed.result === 'string' ? parsed.result.trim() : '')
    })
    child.stdin.end(prompt, 'utf8')
  })
}

function deterministicNarrative(p) {
  const parts = []
  const up = p.movers?.up ?? []
  const down = p.movers?.down ?? []
  if (up.length) parts.push(`상승 무버: ${up.map((x) => `${x.name}(+${x.delta})`).join(', ')}.`)
  if (down.length) parts.push(`하락 무버: ${down.map((x) => `${x.name}(${x.delta})`).join(', ')}.`)
  const ent = p.entries?.entered ?? []
  if (ent.length) parts.push(`신규 Top-${TOP_N} 진입 ${ent.length}건 (${ent.slice(0, 3).map((x) => x.name).join(', ')}).`)
  const exi = p.entries?.exited ?? []
  if (exi.length) parts.push(`이탈 ${exi.length}건.`)
  if ((p.ggsan ?? []).length) parts.push(`ggsan 교차 후보 ${p.ggsan.length}건 상위 노출.`)
  if (p.backlog?.delta != null && p.backlog.delta !== 0) {
    const d = p.backlog.delta
    parts.push(`미분류 적체 ${p.backlog.unclassified}건 (${d > 0 ? '+' : ''}${d}).`)
  }
  for (const a of p.alerts ?? []) parts.push(`⚠ ${a.message}`)
  return parts.length ? parts.join(' ') : '오늘은 감지된 유의미한 변화가 없습니다.'
}

async function synthesizeNarrative(payload) {
  if (skipNarrative) return deterministicNarrative(payload)
  const hasSignal =
    (payload.movers?.up?.length ?? 0) +
      (payload.movers?.down?.length ?? 0) +
      (payload.entries?.entered?.length ?? 0) +
      (payload.alerts?.length ?? 0) >
    0
  if (!hasSignal) return deterministicNarrative(payload)

  const prompt = `당신은 1인 오픈마켓 셀러의 아침 발굴 브리핑 작성자다.
아래 JSON 델타만 보고 한국어 3~5줄로 "오늘 무엇이 바뀌었나"를 서술하라.
규칙: 숫자 근거 유지, 과장 금지, 액션 유도(예: "확인 권장"). 코드펜스·markdown·머리말 금지. 본문만.

${JSON.stringify(payload)}`

  try {
    const text = await callClaudeCli(prompt)
    if (text && text.length > 5) return text
  } catch (e) {
    console.error(`  narrative 합성 실패 → 폴백: ${e instanceof Error ? e.message : e}`)
  }
  return deterministicNarrative(payload)
}

async function main() {
  const t0 = Date.now()
  const date = kstDateStr()
  console.log(`[${new Date().toISOString()}] build-daily-briefing start (date=${date})`)

  // 직전 브리핑 (적체 증감 비교용)
  const { data: prevRow } = await sb
    .from('jimscanner_trends_briefings')
    .select('payload')
    .order('briefing_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  const prevPayload = prevRow?.payload ?? null

  const [scoreDeltas, ggsan, alerts] = await Promise.all([
    computeScoreDeltas().catch((e) => {
      console.error(`  score delta 실패: ${e?.message ?? e}`)
      return { movers: { up: [], down: [] }, entries: { entered: [], exited: [] } }
    }),
    computeGgsanCross(),
    computeAlerts(),
  ])
  const backlog = await computeBacklog(prevPayload)

  const payload = {
    movers: scoreDeltas.movers,
    entries: scoreDeltas.entries,
    ggsan,
    alerts,
    backlog,
  }

  const narrative = await synthesizeNarrative(payload)

  const { error } = await sb.from('jimscanner_trends_briefings').upsert(
    { briefing_date: date, payload, narrative, computed_at: new Date().toISOString() },
    { onConflict: 'briefing_date' },
  )
  if (error) {
    console.error(`  upsert 실패: ${error.message}`)
    process.exit(1)
  }

  console.log(
    `[${new Date().toISOString()}] done — up=${payload.movers.up.length} down=${payload.movers.down.length} ` +
      `enter=${payload.entries.entered.length} exit=${payload.entries.exited.length} ` +
      `ggsan=${ggsan.length} alerts=${alerts.length} backlog=${backlog.unclassified} (${Date.now() - t0}ms)`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
