'use server'

import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export type PromoteResult = { ok: boolean; productId?: string; error?: string }

/**
 * 미발굴 키워드를 canonical product + alias(manual, confidence=1) 로 승격.
 * 다음 recompute(daily 집계)부터 점수화되어 4점수·리더보드에 등장한다.
 */
export async function promoteOrphan(
  keyword: string,
  category: string | null,
): Promise<PromoteResult> {
  if (!keyword?.trim()) return { ok: false, error: '키워드가 비었습니다.' }

  // 어드민 인증 확인 (우회 금지) — 레이아웃과 동일 게이트
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return { ok: false, error: '인증이 필요합니다.' }
  }

  // RLS 우회 쓰기는 service-role 로 (RPC 가 products/aliases insert)
  const admin = createAdminClient()
  const { data, error } = await admin.rpc('jimscanner_orphan_promote' as never, {
    p_keyword: keyword,
    p_category: category,
  } as never)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin/trend-radar/orphans')
  revalidatePath('/admin/trend-radar')
  return { ok: true, productId: (data as unknown as string) ?? undefined }
}
