import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedScout } from '@/lib/scout-auth'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

const CONTROL_TYPES = ['job_pause', 'job_resume', 'job_stop', 'get_state']
const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

// extension/manifest.json 의 version 과 동기화 — extension/ 아무 파일이나 바뀌면 둘 다 올린다.
// 배포된 서버가 아는 "최신 버전"과 확장이 보고한 버전을 비교해, 낡았으면 사이드패널에 새로고침 알림.
const LATEST_EXT_VERSION = '0.1.4'
function isOlder(reported: string, latest: string): boolean {
  const a = reported.split('.').map((n) => parseInt(n, 10) || 0)
  const b = latest.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) < (b[i] || 0)) return true
    if ((a[i] || 0) > (b[i] || 0)) return false
  }
  return false
}

/**
 * 확장 단일 왕복 폴링 — ack(실행 시작 확인)·progress(진행 이벤트) 반영 후 대기 명령 배달.
 * body: { extVersion?, selectorsVersion?, ack?: string[], progress?: [{commandId, phase, ...}] }
 * resp: { commands: [...최대 5], control: [...즉시분 전체], serverTime }
 * 배달은 update .eq(status,'queued') 조건부(낙관적 점유)라 동시 폴링에도 중복 배달되지 않는다.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedScout(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const sb = admin()
  const now = new Date().toISOString()

  // ack: 확장이 수신·실행 시작한 명령 → running
  const ack: string[] = Array.isArray(body?.ack) ? body.ack.filter(isUuid).slice(0, 50) : []
  if (ack.length) {
    const { error } = await sb.from('jimscanner_scout_commands')
      .update({ status: 'running', updated_at: now })
      .in('id', ack).in('status', ['queued', 'sent'])
    if (error) return NextResponse.json({ error: `ack: ${error.message}` }, { status: 500 })
  }

  // progress: 최신 진행 이벤트 저장 (phase=paused → 상태도 paused, phase=resumed → running)
  const progress = Array.isArray(body?.progress) ? body.progress.slice(0, 50) : []
  for (const p of progress) {
    if (!isUuid(p?.commandId)) continue
    if (JSON.stringify(p).length > 8000) continue // 비정상 대형 페이로드 방어
    const patch: Record<string, unknown> = { progress: p, updated_at: now }
    if (p.phase === 'paused') patch.status = 'paused'
    if (p.phase === 'resumed') patch.status = 'running'
    const { error } = await sb.from('jimscanner_scout_commands').update(patch).eq('id', p.commandId)
      .in('status', ['sent', 'running', 'paused'])
    if (error) return NextResponse.json({ error: `progress: ${error.message}` }, { status: 500 })
  }

  // 배달 후보 조회: 제어 명령(pause/resume/stop/get_state)은 전량, 일반 명령은 생성순 5건
  const { data: candidates, error: qErr } = await sb.from('jimscanner_scout_commands')
    .select('id, command_type, created_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true }).limit(60)
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 })

  const ctlIds = (candidates ?? []).filter((c: { command_type: string }) => CONTROL_TYPES.includes(c.command_type)).map((c: { id: string }) => c.id)
  const cmdIds = (candidates ?? []).filter((c: { command_type: string }) => !CONTROL_TYPES.includes(c.command_type)).slice(0, 5).map((c: { id: string }) => c.id)
  const claimIds = [...ctlIds, ...cmdIds]

  // 낙관적 점유: queued 인 것만 sent 로 전환하고 그 행만 반환 → 경합 시 이긴 쪽만 배달받는다
  let claimed: Array<{ id: string; session_id: string; command_type: string; payload: unknown }> = []
  if (claimIds.length) {
    const { data, error } = await sb.from('jimscanner_scout_commands')
      .update({ status: 'sent', sent_at: now, updated_at: now })
      .in('id', claimIds).eq('status', 'queued')
      .select('id, session_id, command_type, payload')
    if (error) return NextResponse.json({ error: `claim: ${error.message}` }, { status: 500 })
    claimed = data ?? []
  }
  const extVersion = typeof body?.extVersion === 'string' ? body.extVersion : null
  const update = extVersion && isOlder(extVersion, LATEST_EXT_VERSION) ? { latestVersion: LATEST_EXT_VERSION } : null
  return NextResponse.json({
    commands: claimed.filter((c) => !CONTROL_TYPES.includes(c.command_type)),
    control: claimed.filter((c) => CONTROL_TYPES.includes(c.command_type)),
    serverTime: now,
    ...(update ? { update } : {}),
  })
}
