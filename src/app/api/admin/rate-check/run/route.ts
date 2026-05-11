import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import {
  startRateCheckRun,
  processRateCheckChunk,
  finishRateCheckRun,
  rescanForwarderInRun,
} from '@/lib/rate-check'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

/**
 * 요금 추출 run 의 세 단계를 action 파라미터로 분기.
 *
 * 기본 일괄 스캔 플로우 (클라이언트 주도):
 *   1) {action:'start'}                       → run 생성, pending forwarder_id 목록 반환
 *   2) {action:'chunk', run_id, forwarder_ids} → 청크 처리 (3~5개 권장, ≤ 90s)
 *   3) {action:'finish', run_id}              → run 집계·마감
 *
 * 단일 배대지 스캔 플로우 (1건만 스캔하고 싶을 때):
 *   - {action:'single', forwarder_id}         → 1건짜리 run 을 원샷으로 start→chunk→finish
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const action: string | undefined = body.action

  try {
    if (action === 'start') {
      const result = await startRateCheckRun(`manual:${user.email}`)
      return NextResponse.json({ ok: true, ...result })
    }

    if (action === 'chunk') {
      const runId: string | undefined = body.run_id
      const ids: unknown = body.forwarder_ids
      if (!runId || !Array.isArray(ids) || ids.length === 0) {
        return NextResponse.json(
          { ok: false, error: 'run_id와 forwarder_ids 필요' },
          { status: 400 },
        )
      }
      const forwarderIds = ids.filter((x): x is string => typeof x === 'string')
      const result = await processRateCheckChunk(runId, forwarderIds)
      return NextResponse.json({ ok: true, ...result })
    }

    if (action === 'finish') {
      const runId: string | undefined = body.run_id
      if (!runId) {
        return NextResponse.json({ ok: false, error: 'run_id 필요' }, { status: 400 })
      }
      const result = await finishRateCheckRun(runId)
      return NextResponse.json({ ok: true, ...result })
    }

    if (action === 'single') {
      const forwarderId: string | undefined = body.forwarder_id
      if (!forwarderId) {
        return NextResponse.json({ ok: false, error: 'forwarder_id 필요' }, { status: 400 })
      }
      const start = await startRateCheckRun(`single:${user.email}`)
      const chunk = await processRateCheckChunk(start.run_id, [forwarderId])
      const finish = await finishRateCheckRun(start.run_id)
      return NextResponse.json({ ok: true, ...finish, processed: chunk.processed })
    }

    if (action === 'rescan') {
      const runId: string | undefined = body.run_id
      const forwarderId: string | undefined = body.forwarder_id
      if (!runId || !forwarderId) {
        return NextResponse.json(
          { ok: false, error: 'run_id와 forwarder_id 필요' },
          { status: 400 },
        )
      }
      const processed = await rescanForwarderInRun(runId, forwarderId)
      const finish = await finishRateCheckRun(runId)
      return NextResponse.json({ ok: true, processed, summary: finish })
    }

    return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
