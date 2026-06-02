'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// jimscanner_emerging_clusters 는 generated Database 타입에 아직 없어서
// `as any` 로 우회. types/supabase.ts 재생성 시 제거 가능 (rpc_type_workaround 패턴).
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

/**
 * 화이트스페이스 클러스터를 분류 상품(canonical)으로 승격.
 * 1) 클러스터 라벨로 jimscanner_trends_products canonical 1건 생성
 * 2) 구성 멤버 product 들을 새 canonical_name + llm_classified_at 으로 백필(classify)
 * 3) 클러스터 status='promoted' + promoted_product_id 기록
 */
export async function promoteCluster(clusterId: string) {
  const sb = sbLoose()
  const { data: cluster, error: cErr } = await sb
    .from('jimscanner_emerging_clusters')
    .select('id, label, category_hint, member_product_ids, status')
    .eq('id', clusterId)
    .maybeSingle()
  if (cErr) return { ok: false as const, error: cErr.message as string }
  if (!cluster) return { ok: false as const, error: 'cluster not found' }
  if (cluster.status !== 'open') return { ok: false as const, error: `이미 ${cluster.status} 상태` }

  const label = String(cluster.label).slice(0, 120)
  const categoryTop = ['health', 'living', 'digital', 'other'].includes(cluster.category_hint)
    ? cluster.category_hint
    : 'other'
  const now = new Date().toISOString()

  // 1) canonical 생성 (이미 존재하면 그 id 재사용)
  const { data: existingProd } = await sb
    .from('jimscanner_trends_products')
    .select('id')
    .eq('canonical_name', label)
    .eq('category_top', categoryTop)
    .maybeSingle()

  let productId: string | undefined = existingProd?.id
  if (!productId) {
    const { data: created, error: insErr } = await sb
      .from('jimscanner_trends_products')
      .insert({
        canonical_name: label,
        category_top: categoryTop,
        description: '신개념 광맥(미분류 군집) 승격',
        llm_classified_at: now,
        llm_model: 'emerging_promote',
      })
      .select('id')
      .single()
    if (insErr) return { ok: false as const, error: insErr.message as string }
    productId = created.id
  }

  // 2) 멤버 백필 — 잔여 product 들을 분류 완료 처리
  const memberIds: string[] = Array.isArray(cluster.member_product_ids)
    ? cluster.member_product_ids
    : []
  if (memberIds.length > 0) {
    await sb
      .from('jimscanner_trends_products')
      .update({ category_top: categoryTop, llm_classified_at: now, llm_model: 'emerging_promote' })
      .in('id', memberIds)
      .is('llm_classified_at', null)
  }

  // 3) 클러스터 승격 마킹
  const { error: updErr } = await sb
    .from('jimscanner_emerging_clusters')
    .update({ status: 'promoted', promoted_product_id: productId })
    .eq('id', clusterId)
  if (updErr) return { ok: false as const, error: updErr.message as string }

  revalidatePath('/admin/trend-radar/emerging')
  return { ok: true as const, productId }
}

/** 광맥 아님 — 기각 (다음 cron 에서 재적재 안 됨). */
export async function dismissCluster(clusterId: string) {
  const { error } = await sbLoose()
    .from('jimscanner_emerging_clusters')
    .update({ status: 'dismissed' })
    .eq('id', clusterId)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/emerging')
  return { ok: true as const }
}
