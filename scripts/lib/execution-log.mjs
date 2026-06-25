// 운영 일지(jimscanner_seller_execution_logs) 기록 헬퍼 — .mjs 크론/루프 스크립트용.
// src/lib/execution-log.ts(Next 런타임용)와 같은 테이블에 쓴다.
// 작업 단위(persona/scenario_step/cron) 기록: 어떤 페르소나가 어떤 시나리오 단계에서 무엇을 했나.
// ⚠️ 본업과 공유 DB라 본업의 jimscanner_execution_logs 와 충돌 회피 위해 seller 네임스페이스 사용.
//
// 사용 예:
//   import { logExecution } from './lib/execution-log.mjs'
//   await logExecution(sb, {
//     kind: 'cron', source: 'ops-sweep', scenarioId: 'stockout-autostop',
//     personaId: 'inventory-ops', task: '품절 감지', status: 'ok',
//     summary: '3건 자동중지', durationMs: Date.now() - t0,
//   })

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb  service-role 클라이언트
 * @param {{
 *   kind: 'cron'|'persona'|'scenario_step',
 *   source: string,
 *   scenarioId?: string|null,
 *   personaId?: string|null,
 *   task?: string|null,
 *   status?: 'ok'|'fail'|'blocked'|'skipped'|'running',
 *   summary?: string|null,
 *   output?: object,
 *   error?: string|null,
 *   startedAt?: string|null,
 *   endedAt?: string|null,
 *   durationMs?: number|null,
 *   toolUses?: number|null,
 *   tokens?: number|null,
 *   evidence?: object,
 *   metadata?: object,
 * }} e
 * @returns {Promise<boolean>} 성공 여부 (실패해도 throw 하지 않음 — 본 작업 비방해)
 */
export async function logExecution(sb, e) {
  try {
    const { error } = await sb.from('jimscanner_seller_execution_logs').insert({
      kind: e.kind,
      source: e.source,
      scenario_id: e.scenarioId ?? null,
      persona_id: e.personaId ?? null,
      task: e.task ?? null,
      status: e.status ?? 'ok',
      summary: e.summary ?? null,
      output: e.output ?? {},
      error: e.error ?? null,
      started_at: e.startedAt ?? null,
      ended_at: e.endedAt ?? null,
      duration_ms: e.durationMs ?? null,
      tool_uses: e.toolUses ?? null,
      tokens: e.tokens ?? null,
      evidence: e.evidence ?? {},
      metadata: e.metadata ?? {},
    })
    if (error) {
      console.warn('[execution-log] insert failed:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[execution-log] insert threw:', err instanceof Error ? err.message : String(err))
    return false
  }
}
