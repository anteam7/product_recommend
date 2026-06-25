import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Json } from '@/lib/supabase'

// 셀러 사업 전용 페르소나·시나리오·크론 실행 로그.
// 기존 jimscanner_agent_runs(루프 단위 요약)보다 한 단계 작은 "작업(task) 단위" 기록.
// 운영 일지(/admin/execution-logs)와 회고 루프의 근거 데이터.
//
// ⚠️ 본업(jimscanner)도 같은 공유 DB에서 jimscanner_execution_logs / jimscanner_scenario_runs 를
//    동일 이름으로 쓴다 → 충돌·혼입 방지를 위해 셀러는 jimscanner_seller_* 네임스페이스 사용.
const EXEC_TABLE = 'jimscanner_seller_execution_logs'
const RUNS_TABLE = 'jimscanner_seller_scenario_runs'

// 신규 테이블이라 생성된 Database 타입에 아직 없음 → 느슨한 클라이언트로 접근.
function adminLoose(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient
}

export type ExecKind = 'cron' | 'persona' | 'scenario_step'
export type ExecStatus = 'ok' | 'fail' | 'blocked' | 'skipped' | 'running'

export type ExecLogEntry = {
  kind: ExecKind
  source: string
  scenarioId?: string | null
  personaId?: string | null
  task?: string | null
  status?: ExecStatus
  summary?: string | null
  output?: Record<string, unknown>
  error?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs?: number | null
  toolUses?: number | null
  tokens?: number | null
  evidence?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export type ExecLogRow = {
  id: string
  created_at: string
  kind: ExecKind
  source: string
  scenario_id: string | null
  persona_id: string | null
  task: string | null
  status: ExecStatus
  summary: string | null
  output: Record<string, unknown>
  error: string | null
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  tool_uses: number | null
  tokens: number | null
  evidence: Record<string, unknown>
  metadata: Record<string, unknown>
}

/** 실행 로그 1건 기록. 실패해도 throw 하지 않음 — 본 작업을 방해하지 않기 위해. */
export async function logExecution(e: ExecLogEntry): Promise<void> {
  try {
    const admin = adminLoose()
    await admin.from(EXEC_TABLE).insert({
      kind: e.kind,
      source: e.source,
      scenario_id: e.scenarioId ?? null,
      persona_id: e.personaId ?? null,
      task: e.task ?? null,
      status: e.status ?? 'ok',
      summary: e.summary ?? null,
      output: (e.output ?? {}) as Json,
      error: e.error ?? null,
      started_at: e.startedAt ?? null,
      ended_at: e.endedAt ?? null,
      duration_ms: e.durationMs ?? null,
      tool_uses: e.toolUses ?? null,
      tokens: e.tokens ?? null,
      evidence: (e.evidence ?? {}) as Json,
      metadata: (e.metadata ?? {}) as Json,
    })
  } catch (err) {
    console.warn('[execution-log] insert failed', err)
  }
}

export type ExecLogFilter = {
  kind?: ExecKind
  status?: ExecStatus
  personaId?: string
  scenarioId?: string
  limit?: number
}

export async function fetchExecutionLogs(filter: ExecLogFilter = {}): Promise<ExecLogRow[]> {
  try {
    const admin = adminLoose()
    let q = admin
      .from(EXEC_TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(filter.limit ?? 150)
    if (filter.kind) q = q.eq('kind', filter.kind)
    if (filter.status) q = q.eq('status', filter.status)
    if (filter.personaId) q = q.eq('persona_id', filter.personaId)
    if (filter.scenarioId) q = q.eq('scenario_id', filter.scenarioId)
    const { data, error } = await q
    if (error) {
      console.warn('[execution-log] fetch failed', error.message)
      return []
    }
    return (data ?? []) as ExecLogRow[]
  } catch (err) {
    console.warn('[execution-log] fetch threw', err)
    return []
  }
}

/** 최근 24h 집계 (대시보드/요약용). */
export async function execLogStats24h(): Promise<{
  total: number
  ok: number
  fail: number
  blocked: number
}> {
  const rows = await fetchExecutionLogs({ limit: 500 })
  const since = Date.now() - 24 * 60 * 60 * 1000
  const recent = rows.filter((r) => {
    const t = new Date(r.created_at).getTime()
    return !Number.isNaN(t) && t >= since
  })
  return {
    total: recent.length,
    ok: recent.filter((r) => r.status === 'ok').length,
    fail: recent.filter((r) => r.status === 'fail').length,
    blocked: recent.filter((r) => r.status === 'blocked').length,
  }
}

/** 시나리오 실행 큐에 등록. 로컬 러너가 집어서 단계 실행. */
export async function enqueueScenarioRun(
  scenarioId: string,
  totalSteps: number,
  requestedBy?: string | null,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const admin = adminLoose()
    const { data, error } = await admin
      .from(RUNS_TABLE)
      .insert({
        scenario_id: scenarioId,
        status: 'queued',
        requested_by: requestedBy ?? null,
        total_steps: totalSteps,
      })
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    const id = (data as { id?: string } | null)?.id
    if (!id) return { ok: false, error: 'insert returned no id' }
    return { ok: true, id }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
