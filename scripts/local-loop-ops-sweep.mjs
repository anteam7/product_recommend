#!/usr/bin/env node
/**
 * 자동 Ops Sweep 루프 (Loop Engineering L1 — 보고 전용)
 * 크론·재고·주문 동기화의 건강 상태를 DB에서 조회해 jimscanner_agent_runs에 기록한다.
 *
 * 실행: node --env-file=.env.local scripts/local-loop-ops-sweep.mjs
 * 자동화: run-crons.mjs 완료 후 자동 호출, 또는 Windows Task Scheduler 별도 등록
 *
 * 출력: jimscanner_agent_runs INSERT + 콘솔 요약
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let envRaw: string
try {
  envRaw = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
} catch (e) {
  console.error('.env.local 읽기 실패:', e instanceof Error ? e.message : String(e))
  console.error('node --env-file=.env.local 로 실행했는지 확인하세요.')
  process.exit(1)
}

const env = Object.fromEntries(
  envRaw
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 가 .env.local에 없습니다.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const t0 = Date.now()

// KST 기준 현재 시각 문자열
const nowKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' KST'

// 임계값 (분)
const THRESHOLDS = {
  trend: 120,   // 트렌드 크론: 2시간
  stock: 90,    // 재고 동기화: 90분
  orders: 90,   // 주문 동기화: 90분
}

async function checkTrendSignals() {
  const { data, error } = await sb.rpc('execute_sql' as never, {
    sql: `
      SELECT source,
             max(collected_at AT TIME ZONE 'Asia/Seoul') as last_run_kst,
             count(*) FILTER (WHERE collected_at > now() - interval '24 hours') as count_24h
      FROM jimscanner_trend_signals
      GROUP BY source
      ORDER BY last_run_kst ASC
    `,
  } as never).catch(() => ({ data: null, error: 'rpc unavailable' }))

  if (error || !data) {
    // rpc 없으면 직접 쿼리
    const { data: rows, error: e2 } = await sb
      .from('jimscanner_trend_signals' as never)
      .select('source, collected_at')
      .gte('collected_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order('collected_at', { ascending: false })
      .limit(500) as { data: Array<{ source: string; collected_at: string }> | null; error: unknown }

    if (e2 || !rows) return { status: 'ERROR', detail: 'DB 연결 실패', rows: [] }

    const bySource: Record<string, { last: string; count: number }> = {}
    for (const r of rows ?? []) {
      if (!bySource[r.source]) bySource[r.source] = { last: r.collected_at, count: 0 }
      bySource[r.source].count++
    }
    return { status: 'OK', detail: bySource, rows: Object.entries(bySource) }
  }
  return { status: 'OK', detail: data, rows: data as unknown[] }
}

async function checkStaleListings() {
  const { count, error } = await sb
    .from('jimscanner_coupang_listings' as never)
    .select('id', { count: 'exact', head: true })
    .eq('status', 'SELLING')
    .lt('updated_at', new Date(Date.now() - THRESHOLDS.stock * 60 * 1000).toISOString()) as { data: null; count: number | null; error: unknown }

  if (error) return { stale_count: -1, error: String(error) }
  return { stale_count: count ?? 0 }
}

async function checkRecentOrders() {
  const { data, error } = await sb
    .from('jimscanner_coupang_orders' as never)
    .select('ordered_at')
    .order('ordered_at', { ascending: false })
    .limit(1) as { data: Array<{ ordered_at: string }> | null; error: unknown }

  if (error || !data || data.length === 0) return { last_order: null }
  return { last_order: data[0].ordered_at }
}

// ── 실행 ──
console.log(`[${nowKST()}] ops-sweep 시작`)

const [trendResult, staleResult, orderResult] = await Promise.all([
  checkTrendSignals(),
  checkStaleListings(),
  checkRecentOrders(),
])

// 심각도 판정
const issues: Array<{ severity: string; message: string }> = []

if (trendResult.status === 'ERROR') {
  issues.push({ severity: 'ERROR', message: '트렌드 신호 DB 조회 실패' })
} else {
  const rows = trendResult.rows as Array<[string, { count: number }]>
  const zeroCounts = rows.filter(([, v]) => (typeof v === 'object' && 'count' in v ? v.count === 0 : false))
  if (zeroCounts.length > 0)
    issues.push({ severity: 'WARN', message: `24h 수집 0건 소스: ${zeroCounts.map(([s]) => s).join(', ')}` })
}

if (staleResult.stale_count > 0)
  issues.push({ severity: 'WARN', message: `SELLING 상태 중 ${THRESHOLDS.stock}분 이상 미갱신: ${staleResult.stale_count}건` })
if (staleResult.stale_count === -1)
  issues.push({ severity: 'WARN', message: '재고 동기화 상태 조회 실패' })

const overallStatus = issues.some((i) => i.severity === 'ERROR')
  ? 'failed'
  : issues.some((i) => i.severity === 'WARN')
    ? 'partial'
    : 'completed'

const what = [
  '트렌드 신호 수집 현황(소스별 24h 건수) 조회',
  `SELLING 상태 쿠팡 상품 중 ${THRESHOLDS.stock}분 초과 미갱신 상품 수 확인`,
  '최근 주문 수신 시각 확인',
].join('\n')

const why = `자동 ops-sweep 루프(Loop Engineering L1). run-crons.mjs 완료 후 자동 실행 또는 Windows Task Scheduler 독립 실행.`

const how = [
  `jimscanner_trend_signals: 24h 이내 소스별 수집 건수 집계`,
  `jimscanner_coupang_listings: status=SELLING & updated_at < now()-${THRESHOLDS.stock}m 건수`,
  `jimscanner_coupang_orders: 최근 주문 ordered_at 조회`,
].join('\n')

const summary =
  issues.length === 0
    ? `모든 크론 정상 (이슈 없음)`
    : `이슈 ${issues.length}건: ${issues.map((i) => `[${i.severity}] ${i.message}`).join(' / ')}`

const duration = Date.now() - t0

// jimscanner_agent_runs에 기록
const { error: insertError } = await sb
  .from('jimscanner_agent_runs' as never)
  .insert({
    loop_name: 'ops-sweep',
    level: 'L1',
    triggered_by: 'auto',
    status: overallStatus,
    summary,
    what_happened: what,
    why,
    how,
    stats: { processed: 3, succeeded: 3 - issues.filter(i => i.severity === 'ERROR').length, failed: issues.filter(i => i.severity === 'ERROR').length, warned: issues.filter(i => i.severity === 'WARN').length },
    detail: { issues, trend: trendResult.detail, stale_count: staleResult.stale_count, last_order: orderResult.last_order },
    duration_ms: duration,
  } as never)

if (insertError) {
  console.error('agent_runs insert 실패:', insertError)
  // insert 실패는 루프 자체의 실패가 아니므로 exit code에 영향 없음.
  // 결과는 콘솔 로그로 이미 출력됨.
}

console.log(`[${nowKST()}] ops-sweep 완료 (${duration}ms): ${summary}`)
if (issues.length > 0) {
  for (const issue of issues) console.log(`  [${issue.severity}] ${issue.message}`)
}
