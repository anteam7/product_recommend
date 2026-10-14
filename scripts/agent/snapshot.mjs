// 관측 = 단일 스냅샷. 목표 평가는 이 출력만 본다. (docs/plan-personal-agent.md §2.3)

// runningWindowMin: "실행 중" 판정 창 = 재실행 억제 + 조치 후 유예. 실소요(p90)보다 여유 있게 — 쿠팡 재고는 ~17분 걸리므로 40.
export const SYNCS = {
  coupang_orders: { table: 'jimscanner_coupang_orders_sync_runs', script: 'scripts/local-cron-orders-sync.mjs',       label: '쿠팡 주문 동기화',   runningWindowMin: 15 },
  naver_orders:   { table: 'jimscanner_naver_orders_sync_runs',   script: 'scripts/local-cron-naver-orders-sync.mjs', label: '네이버 주문 동기화', runningWindowMin: 15 },
  toss_orders:    { table: 'jimscanner_toss_orders_sync_runs',    script: 'scripts/local-cron-toss-orders-sync.mjs',  label: '토스 주문 동기화',   runningWindowMin: 15 },
  coupang_ggsan:  { table: 'jimscanner_coupang_ggsan_sync_runs',  script: 'scripts/local-cron-ggsan-sync.mjs',        label: '매입처 송장 추적',   runningWindowMin: 15 },
  coupang_stock:  { table: 'jimscanner_coupang_stock_sync_runs',  script: 'scripts/local-cron-stock-sync.mjs',        label: '쿠팡 재고 동기화',   runningWindowMin: 40 },
}
// 테이블마다 성공 표기가 다르다: success(쿠팡·ggsan·토스) / ok|partial(네이버)
export const OK_STATUSES = new Set(['success', 'ok', 'partial'])
export const ERROR_STATUSES = new Set(['error', 'partial'])
// 1a 감시 대상 상주 프로세스. register-agent·scout-agent는 런처가 없어 수동 기동 → 1a에서는 제외(heartbeat는 찍음).
export const PROCESSES = ['work-agent', 'order-server']
export const SUPPLIERS = ['ggsan', 'bio77', 'upickb2b', 'wellroot', 'kwholesale', 'cmtstory', 'campingmoon']
export const RUNNING_WINDOW_MIN = 15

const KST_OFFSET_MS = 9 * 3600_000
export function kstDate(d) { return new Date(new Date(d).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10) }
export function kstHour(d) { return new Date(new Date(d).getTime() + KST_OFFSET_MS).getUTCHours() }

export async function fetchRaw(sb) {
  const must = (res, what) => { if (res.error) throw new Error(`${what}: ${res.error.message}`); return res.data ?? [] }
  const syncRuns = {}
  for (const [key, s] of Object.entries(SYNCS)) {
    syncRuns[key] = must(
      await sb.from(s.table).select('status, started_at, finished_at, error_message').order('started_at', { ascending: false }).limit(10),
      s.table,
    )
  }
  const heartbeats = must(await sb.from('jimscanner_agent_heartbeats').select('name, last_seen_at, status, detail'), 'heartbeats')
  const cronRuns = must(
    await sb.from('jimscanner_agent_runs').select('created_at, status').eq('loop_name', 'run-crons').order('created_at', { ascending: false }).limit(1),
    'agent_runs(run-crons)',
  )
  const escalated = must(await sb.from('jimscanner_work_instructions').select('id, title, updated_at').eq('status', 'escalated'), 'work_instructions')
  const settings = must(await sb.from('jimscanner_agent_settings').select('key, value'), 'agent_settings')
  return { syncRuns, heartbeats, cronRuns, escalated, settings }
}

export function buildSnapshot(raw, now = new Date()) {
  const minsAgo = (iso) => Math.round((now.getTime() - new Date(iso).getTime()) / 60_000)

  const syncs = {}
  for (const key of Object.keys(SYNCS)) {
    const runs = raw.syncRuns?.[key] ?? []
    const finished = runs.filter((r) => r.finished_at)
    const lastOk = finished.find((r) => OK_STATUSES.has(r.status)) ?? null
    const last = finished[0] ?? null
    const newest = runs[0] ?? null
    const windowMin = SYNCS[key].runningWindowMin ?? RUNNING_WINDOW_MIN
    const running = newest && newest.status === 'running' && !newest.finished_at && minsAgo(newest.started_at) <= windowMin
    syncs[key] = {
      label: SYNCS[key].label,
      lastOkAt: lastOk ? lastOk.finished_at : null,
      lastOkAgeMin: lastOk ? minsAgo(lastOk.finished_at) : Infinity,
      lastStatus: last ? last.status : null,
      lastError: last && ERROR_STATUSES.has(last.status) ? (last.error_message ?? '(메시지 없음)') : null,
      runningSince: running ? newest.started_at : null,
    }
  }

  const heartbeats = {}
  for (const h of raw.heartbeats ?? []) heartbeats[h.name] = { ...h, ageMin: minsAgo(h.last_seen_at) }

  const last = raw.cronRuns?.[0] ?? null
  const dailyCron = { last, okToday: !!last && last.status === 'completed' && kstDate(last.created_at) === kstDate(now) }

  const escalatedOver24h = (raw.escalated ?? []).filter((e) => minsAgo(e.updated_at) > 24 * 60)
  const settings = Object.fromEntries((raw.settings ?? []).map((s) => [s.key, s.value]))

  return { takenAt: now.toISOString(), syncs, heartbeats, dailyCron, instructions: { escalatedOver24h }, settings }
}
