'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// jimscanner_trends_seeds 는 generated Database 타입에 느슨하므로 as any 우회.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sbLoose(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

/**
 * 블라인드스팟 클러스터를 기반으로 신규 시드를 draft(is_active=false)로 insert.
 * 운영자가 어드민에서 승인(is_active=true)하면 다음 cron 부터 수집 시작.
 */
export async function proposeSeedDraft(input: {
  label: string
  keywords: string[]
  category: string | null
}) {
  const label = (input.label || '').trim().slice(0, 120)
  const keywords = (input.keywords || [])
    .map((k) => (k || '').trim())
    .filter(Boolean)
    .slice(0, 5)

  if (!label || keywords.length === 0) {
    return { ok: false as const, error: 'label 과 keyword 가 필요합니다.' }
  }

  const config = {
    groupName: label,
    keywords,
    proposed_from: 'seed-coverage-audit',
    blindspot_category: input.category,
  }

  const { error } = await sbLoose()
    .from('jimscanner_trends_seeds')
    .insert({
      source: 'naver_search_trend',
      kind: 'keyword_group',
      label: `[제안] ${label}`,
      config,
      is_active: false, // draft — 운영자 승인 대기
      display_order: 999,
    })

  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/sources/audit')
  return { ok: true as const }
}

/** dead seed 폐기 후보를 비활성화(is_active=false). 삭제하지 않고 보존. */
export async function retireSeed(id: string) {
  const { error } = await sbLoose()
    .from('jimscanner_trends_seeds')
    .update({ is_active: false })
    .eq('id', id)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/sources/audit')
  return { ok: true as const }
}
