import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STAGES = ['discovered', 'reviewing', 'sourcing', 'listed', 'selling', 'dropped'] as const
const DROP_REASONS = ['마진부족', '반품위험', '소싱불가', '경쟁과포화', '인증장벽', '기타'] as const

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

/**
 * 후보를 파이프라인 단계로 이동 / 진입.
 * body: { product_id, stage, dropped_reason?, note? }
 * - pipeline 행을 upsert (product_id UNIQUE)
 * - 이력(history) 한 줄 append → 전환율 / 체류일 분석 원천
 */
export async function POST(req: Request) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { product_id?: string; stage?: string; dropped_reason?: string | null; note?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { product_id } = body
  const stage = body.stage
  if (!product_id || !stage || !STAGES.includes(stage as (typeof STAGES)[number])) {
    return NextResponse.json({ error: 'product_id 와 유효한 stage 필요' }, { status: 400 })
  }
  const droppedReason =
    stage === 'dropped' && body.dropped_reason && DROP_REASONS.includes(body.dropped_reason as (typeof DROP_REASONS)[number])
      ? body.dropped_reason
      : null
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : null

  const sb = createAdminClient()

  // 기존 행 조회 (from_stage 이력용)
  const { data: existing } = await sb
    .from('jimscanner_trends_pipeline' as never)
    .select('stage')
    .eq('product_id', product_id)
    .maybeSingle()
  const fromStage = (existing as { stage?: string } | null)?.stage ?? null

  const nowIso = new Date().toISOString()

  // upsert 현재 단계
  const { error: upsertErr } = await sb
    .from('jimscanner_trends_pipeline' as never)
    .upsert(
      {
        product_id,
        stage,
        stage_changed_at: nowIso,
        dropped_reason: droppedReason,
        ...(note != null ? { note } : {}),
      } as never,
      { onConflict: 'product_id' } as never,
    )
  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 })
  }

  // 이력 append (단계가 실제로 바뀐 경우에만 — 같은 단계 메모 수정은 이력 생략)
  if (fromStage !== stage) {
    await sb.from('jimscanner_trends_pipeline_history' as never).insert(
      {
        product_id,
        from_stage: fromStage,
        to_stage: stage,
        dropped_reason: droppedReason,
        note,
        changed_at: nowIso,
      } as never,
    )
  }

  return NextResponse.json({ ok: true, product_id, stage, dropped_reason: droppedReason })
}
