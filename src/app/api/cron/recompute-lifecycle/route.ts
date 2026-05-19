import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'
import {
  classifyLifecycle,
  deriveSignalsForProduct,
  type LifecycleStage,
} from '@/scoring/lifecycle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * 매일 KST 06:00 recompute 의 마지막 step.
 * canonical product 전수에 대해 PLC stage 를 재산출한다.
 *
 * 처리량 가드: products 가 폭증할 때를 대비해 limit 기본 500.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { searchParams } = new URL(request.url)
  const limit = Math.min(2000, Number(searchParams.get('limit') ?? 500))

  const t0 = Date.now()

  const { data: products, error } = await (admin as any)
    .from('jimscanner_trends_products')
    .select('id, lifecycle_stage')
    .order('lifecycle_computed_at', { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const list = (products ?? []) as Array<{ id: string; lifecycle_stage: LifecycleStage | null }>

  let updated = 0
  let stageTransitions = 0
  let nullStage = 0
  const stageCounts: Record<string, number> = {}

  for (const p of list) {
    const signals = await deriveSignalsForProduct(admin, p.id)
    const result = classifyLifecycle(signals)

    if (!result.stage) {
      nullStage++
      continue
    }

    stageCounts[result.stage] = (stageCounts[result.stage] ?? 0) + 1

    const isTransition = p.lifecycle_stage !== result.stage
    if (isTransition) stageTransitions++

    const patch: Record<string, unknown> = {
      lifecycle_stage: result.stage,
      lifecycle_velocity: result.velocity,
      lifecycle_evidence: { ...result.evidence, confidence: result.confidence },
      lifecycle_computed_at: new Date().toISOString(),
    }
    if (isTransition) {
      patch.lifecycle_stage_entered_at = new Date().toISOString()
    }

    const { error: upErr } = await (admin as any)
      .from('jimscanner_trends_products')
      .update(patch)
      .eq('id', p.id)

    if (!upErr) updated++
  }

  const duration_ms = Date.now() - t0

  await (admin as any).from('jimscanner_trends_runs').insert({
    source: 'recompute_lifecycle',
    status: 'ok',
    fetched_count: list.length,
    inserted_count: updated,
    duration_ms,
    triggered_by: 'cron',
    finished_at: new Date().toISOString(),
  })

  return NextResponse.json({
    ok: true,
    scanned: list.length,
    updated,
    nullStage,
    stageTransitions,
    stageCounts,
    duration_ms,
  })
}
