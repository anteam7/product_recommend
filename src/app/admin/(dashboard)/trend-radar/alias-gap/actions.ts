'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// 새 뷰/함수가 generated Database 타입에 아직 없어서 `as any` 로 우회.
// types/supabase.ts 재생성 시 제거 가능 (rpc_type_workaround 패턴 참고).
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

export async function ignoreKeyword(keyword: string, reason: string = 'noise') {
  const k = (keyword ?? '').trim()
  if (!k) return { ok: false as const, error: 'empty keyword' }
  const { error } = await sbLoose().rpc('jimscanner_trends_ignore_keyword', {
    p_keyword: k,
    p_reason: reason.slice(0, 200),
    p_by: 'admin',
  })
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/alias-gap')
  return { ok: true as const }
}

export async function createProductFromKeyword(
  keyword: string,
  canonicalName: string,
  categoryTop: string,
  categoryMid?: string,
) {
  const k = (keyword ?? '').trim()
  const cn = (canonicalName ?? '').trim()
  const ct = (categoryTop ?? '').trim()
  if (!k || !cn || !ct) return { ok: false as const, error: 'missing fields' }
  const { data, error } = await sbLoose().rpc('jimscanner_trends_create_product_from_keyword', {
    p_keyword: k,
    p_canonical_name: cn,
    p_category_top: ct,
    p_category_mid: categoryMid?.trim() || null,
  })
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/alias-gap')
  return { ok: true as const, product_id: data as string }
}

export async function addAliasToProduct(productId: string, alias: string) {
  const a = (alias ?? '').trim()
  if (!productId || !a) return { ok: false as const, error: 'missing fields' }
  const { error } = await sbLoose().rpc('jimscanner_trends_add_alias', {
    p_product_id: productId,
    p_alias: a,
  })
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/alias-gap')
  return { ok: true as const }
}
