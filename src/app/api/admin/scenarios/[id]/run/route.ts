import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { enqueueScenarioRun, logExecution } from '@/lib/execution-log'
import { scenarioById } from '@/lib/scenarios'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 시나리오 "▶ 지금 실행" — 실행 큐(jimscanner_scenario_runs)에 등록만 한다.
 * 실제 단계 실행은 로컬 러너가 큐를 폴링해 Claude CLI 로 수행하고 운영 일지에 기록한다.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // 인증: 어드민만
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 유효한 시나리오인지 검증 (임의 id 차단)
  const scenario = scenarioById(id)
  if (!scenario) {
    return NextResponse.json({ error: `알 수 없는 시나리오: ${id}` }, { status: 404 })
  }

  const res = await enqueueScenarioRun(scenario.id, scenario.steps.length, user.email ?? null)
  if (!res.ok) {
    // 큐 등록 실패(예: 테이블 미생성) — 운영 일지에 기록 시도 후 에러 반환
    await logExecution({
      kind: 'scenario_step',
      source: 'admin-ui',
      scenarioId: scenario.id,
      task: '시나리오 실행 큐 등록',
      status: 'fail',
      error: res.error ?? 'enqueue failed',
    })
    return NextResponse.json(
      { error: `큐 등록 실패: ${res.error ?? 'unknown'} (scenario_runs 테이블 적용 필요할 수 있음)` },
      { status: 500 },
    )
  }

  await logExecution({
    kind: 'scenario_step',
    source: 'admin-ui',
    scenarioId: scenario.id,
    task: `${scenario.name} 실행 요청`,
    status: 'running',
    summary: `${user.email} 가 실행 큐에 등록 (${scenario.steps.length}단계)`,
    metadata: { run_id: res.id, requested_by: user.email },
  })

  return NextResponse.json({ ok: true, runId: res.id, scenario: scenario.id })
}
