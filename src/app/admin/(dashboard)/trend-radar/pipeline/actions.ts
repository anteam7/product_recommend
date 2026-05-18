'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { createClient } from '@/lib/auth/server'

export const STAGES = ['discovery', 'sourcing', 'listing', 'live', 'profitable', 'rejected'] as const
export type Stage = (typeof STAGES)[number]

// jimscanner_trends_pipeline_stages / _stage_transitions 는 generated Database 타입에 아직 없음.
// SQL 적용 후에도 types 재생성 전까지 `as any` 캐스팅으로 우회. (rpc_type_workaround 패턴)
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

async function getActorEmail(): Promise<string | null> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return user?.email ?? null
  } catch {
    return null
  }
}

export async function moveStage(productId: string, toStage: Stage, notes?: string) {
  if (!STAGES.includes(toStage)) {
    return { ok: false as const, error: `invalid stage: ${toStage}` }
  }
  const sb = sbLoose()
  const actor = await getActorEmail()
  const now = new Date()

  const { data: existing } = await sb
    .from('jimscanner_trends_pipeline_stages')
    .select('stage, entered_at, owner_email')
    .eq('product_id', productId)
    .maybeSingle()

  const fromStage: Stage | null = existing?.stage ?? null
  const dwellMs = existing?.entered_at
    ? now.getTime() - new Date(existing.entered_at as string).getTime()
    : null

  if (fromStage === toStage) {
    return { ok: true as const, noop: true }
  }

  if (existing) {
    const { error } = await sb
      .from('jimscanner_trends_pipeline_stages')
      .update({
        stage: toStage,
        entered_at: now.toISOString(),
        owner_email: actor ?? existing.owner_email,
        notes: notes ?? null,
      })
      .eq('product_id', productId)
    if (error) return { ok: false as const, error: error.message as string }
  } else {
    const { error } = await sb
      .from('jimscanner_trends_pipeline_stages')
      .insert({
        product_id: productId,
        stage: toStage,
        entered_at: now.toISOString(),
        owner_email: actor,
        notes: notes ?? null,
      })
    if (error) return { ok: false as const, error: error.message as string }
  }

  await sb.from('jimscanner_trends_stage_transitions').insert({
    product_id: productId,
    from_stage: fromStage,
    to_stage: toStage,
    transitioned_at: now.toISOString(),
    transitioned_by: actor,
    dwell_ms: dwellMs,
    notes: notes ?? null,
  })

  revalidatePath('/admin/trend-radar/pipeline')
  revalidatePath('/admin/trend-radar/pins')
  return { ok: true as const }
}

/** 핀 토글 시 자동 sourcing 단계 진입 (기존 단계 없을 때만) */
export async function ensureSourcingFromPin(productId: string) {
  const sb = sbLoose()
  const { data: existing } = await sb
    .from('jimscanner_trends_pipeline_stages')
    .select('stage')
    .eq('product_id', productId)
    .maybeSingle()
  if (existing) return { ok: true as const, alreadyStaged: true }
  return await moveStage(productId, 'sourcing', '핀 토글로 자동 진입')
}
