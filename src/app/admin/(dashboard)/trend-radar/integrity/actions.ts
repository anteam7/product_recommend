'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// jimscanner_trends_alias_overrides / 일부 컬럼이 generated Database 타입에 아직 없어서
// `as any` 로 우회 (rpc_type_workaround 패턴). types/supabase.ts 재생성 시 제거 가능.
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

async function logOverride(row: {
  action: 'confirm' | 'split' | 'merge'
  alias?: string | null
  alias_type?: string | null
  from_product_id?: string | null
  to_product_id?: string | null
  detail?: Record<string, unknown>
}) {
  // 로그 실패는 본 액션을 막지 않는다 (테이블 미적용 환경 대비).
  try {
    await sbLoose()
      .from('jimscanner_trends_alias_overrides')
      .insert({ detail: {}, ...row })
  } catch {
    /* noop */
  }
}

async function refreshAliasCount(productId: string) {
  const sb = sbLoose()
  const { count } = await sb
    .from('jimscanner_trends_aliases')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId)
  await sb
    .from('jimscanner_trends_products')
    .update({ alias_count: count ?? 0 })
    .eq('id', productId)
}

/**
 * 확정(override): 운영자가 이 alias→product 매핑이 옳다고 확정.
 * confidence=1.0, classified_by='manual' 로 고정해 LLM 재분류 대상에서 제외.
 */
export async function confirmAlias(aliasId: string, productId: string) {
  if (!aliasId) return { ok: false as const, error: 'aliasId 필요' }
  const { error, data } = await sbLoose()
    .from('jimscanner_trends_aliases')
    .update({ confidence: 1.0, classified_by: 'manual' })
    .eq('id', aliasId)
    .select('alias, alias_type')
    .single()
  if (error) return { ok: false as const, error: error.message as string }
  await logOverride({
    action: 'confirm',
    alias: data?.alias ?? null,
    alias_type: data?.alias_type ?? null,
    from_product_id: productId,
  })
  revalidatePath('/admin/trend-radar/integrity')
  return { ok: true as const }
}

/**
 * 분할(split): 오병합으로 의심되는 alias 를 현재 product 에서 떼어내
 * 새 캐노니컬 product 로 분리한다. (alias 텍스트를 새 product 의 canonical_name 으로)
 */
export async function splitAlias(aliasId: string, fromProductId: string) {
  if (!aliasId || !fromProductId) return { ok: false as const, error: 'aliasId/fromProductId 필요' }
  const sb = sbLoose()

  const { data: alias, error: aErr } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, alias_type')
    .eq('id', aliasId)
    .single()
  if (aErr || !alias) return { ok: false as const, error: aErr?.message ?? 'alias 없음' }

  const { data: parent } = await sb
    .from('jimscanner_trends_products')
    .select('category_top, category_mid')
    .eq('id', fromProductId)
    .single()

  // 새 product 생성 (분할된 alias 가 곧 새 캐노니컬 이름)
  const { data: newProd, error: pErr } = await sb
    .from('jimscanner_trends_products')
    .insert({
      canonical_name: alias.alias,
      category_top: parent?.category_top ?? 'other',
      category_mid: parent?.category_mid ?? null,
      description: '오병합 감사 분할로 생성',
    })
    .select('id')
    .single()
  if (pErr || !newProd) return { ok: false as const, error: pErr?.message ?? '새 product 생성 실패' }

  // alias 를 새 product 로 이동 + 운영자 확정
  const { error: mErr } = await sb
    .from('jimscanner_trends_aliases')
    .update({ product_id: newProd.id, confidence: 1.0, classified_by: 'manual' })
    .eq('id', aliasId)
  if (mErr) return { ok: false as const, error: mErr.message as string }

  await Promise.all([refreshAliasCount(fromProductId), refreshAliasCount(newProd.id)])
  await logOverride({
    action: 'split',
    alias: alias.alias,
    alias_type: alias.alias_type,
    from_product_id: fromProductId,
    to_product_id: newProd.id,
  })
  revalidatePath('/admin/trend-radar/integrity')
  return { ok: true as const, newProductId: newProd.id as string }
}

/**
 * 병합(merge): 과소병합(중복 캐노니컬)으로 의심되는 두 product 를 하나로 합친다.
 * source 의 모든 alias 를 target 으로 옮기고(운영자 확정), source product 는 삭제.
 */
export async function mergeProducts(sourceId: string, targetId: string) {
  if (!sourceId || !targetId) return { ok: false as const, error: 'sourceId/targetId 필요' }
  if (sourceId === targetId) return { ok: false as const, error: '같은 product 는 병합 불가' }
  const sb = sbLoose()

  // alias 이동 — UNIQUE(alias, alias_type) 충돌 가능성은 있으나 드물고, 충돌 시 에러 반환.
  const { error: mErr } = await sb
    .from('jimscanner_trends_aliases')
    .update({ product_id: targetId, confidence: 1.0, classified_by: 'manual' })
    .eq('product_id', sourceId)
  if (mErr) return { ok: false as const, error: `alias 이동 실패: ${mErr.message}` }

  const { error: dErr } = await sb
    .from('jimscanner_trends_products')
    .delete()
    .eq('id', sourceId)
  if (dErr) return { ok: false as const, error: `source 삭제 실패: ${dErr.message}` }

  await refreshAliasCount(targetId)
  await logOverride({
    action: 'merge',
    from_product_id: sourceId,
    to_product_id: targetId,
  })
  revalidatePath('/admin/trend-radar/integrity')
  return { ok: true as const }
}
