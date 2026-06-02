'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// seed_radar RPC / seeds 테이블은 generated Database 타입에 아직 없어서 `as any` 로 우회.
// types/supabase.ts 재생성 시 제거 가능 (rpc_type_workaround 패턴 참고).
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

// 미커버 핫텀 → naver_search_trend 키워드그룹 seed 로 승격.
export async function promoteTokenToSeed(token: string) {
  const term = token.trim().slice(0, 60)
  if (!term) return { ok: false as const, error: 'empty token' }

  const sb = sbLoose()

  // 이미 같은 키워드를 담은 활성 seed 가 있으면 중복 추가 방지.
  const { data: existing } = await sb
    .from('jimscanner_trends_seeds')
    .select('id, config')
    .eq('source', 'naver_search_trend')
    .eq('is_active', true)
  const dup = (existing ?? []).some((s: { config: { keywords?: string[] } }) =>
    (s.config?.keywords ?? []).some((k) => k.trim().toLowerCase() === term.toLowerCase()),
  )
  if (dup) return { ok: false as const, error: '이미 활성 시드에 포함된 키워드' }

  // display_order 는 기존 최대값 + 1
  const { data: maxRow } = await sb
    .from('jimscanner_trends_seeds')
    .select('display_order')
    .eq('source', 'naver_search_trend')
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextOrder = ((maxRow?.display_order as number | undefined) ?? -1) + 1

  const { error } = await sb.from('jimscanner_trends_seeds').insert({
    source: 'naver_search_trend',
    kind: 'keyword_group',
    label: `[레이더] ${term}`,
    config: { groupName: term, keywords: [term] },
    is_active: true,
    display_order: nextOrder,
  })
  if (error) return { ok: false as const, error: error.message as string }

  revalidatePath('/admin/trend-radar/seed-radar')
  return { ok: true as const }
}

// 죽은 시드 가지치기 — 비활성화(soft prune). 이력 보존 위해 삭제하지 않음.
export async function pruneSeed(seedId: string) {
  if (!seedId) return { ok: false as const, error: 'missing seed id' }
  const { error } = await sbLoose()
    .from('jimscanner_trends_seeds')
    .update({ is_active: false })
    .eq('id', seedId)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/seed-radar')
  return { ok: true as const }
}

// 비활성 시드 복구.
export async function reactivateSeed(seedId: string) {
  if (!seedId) return { ok: false as const, error: 'missing seed id' }
  const { error } = await sbLoose()
    .from('jimscanner_trends_seeds')
    .update({ is_active: true })
    .eq('id', seedId)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/seed-radar')
  return { ok: true as const }
}
