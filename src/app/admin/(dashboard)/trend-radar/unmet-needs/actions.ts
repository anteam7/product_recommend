'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// jimscanner_unmet_needs / jimscanner_trends_seeds 가 generated 타입에 미반영
// → `as any` 우회 (rpc_type_workaround 패턴).
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

export async function promoteNeedToSeed(needText: string, categoryGuess: string | null) {
  const need = needText.trim()
  if (!need) return { ok: false as const, error: 'empty need_text' }

  const sb = sbLoose()
  const label = `[unmet] ${need}`.slice(0, 80)

  const { data: existing } = await sb
    .from('jimscanner_trends_seeds')
    .select('id')
    .eq('source', 'naver_search_trend')
    .eq('label', label)
    .maybeSingle()

  let seedId: string | undefined = existing?.id
  if (!seedId) {
    const { data: ins, error } = await sb
      .from('jimscanner_trends_seeds')
      .insert({
        source: 'naver_search_trend',
        kind: 'keyword_group',
        label,
        config: {
          groupName: need,
          keywords: [need],
          origin: 'unmet_needs_manual',
          category_guess: categoryGuess ?? 'other',
        },
        is_active: true,
      })
      .select('id')
      .single()
    if (error) return { ok: false as const, error: error.message as string }
    seedId = ins?.id
  }

  if (seedId) {
    await sb
      .from('jimscanner_unmet_needs')
      .update({ promoted_seed_id: seedId })
      .eq('need_text', need)
      .is('promoted_seed_id', null)
  }

  revalidatePath('/admin/trend-radar/unmet-needs')
  return { ok: true as const, seedId }
}

export async function pinNeedAsKeyword(needText: string) {
  const kw = needText.trim().slice(0, 80)
  if (!kw) return { ok: false as const, error: 'empty need_text' }
  const sb = sbLoose()
  const { error } = await sb.from('jimscanner_trends_keywords').insert({
    keyword: kw,
    source: 'unmet_needs',
    pinned: true,
    notes: 'pinned from unmet-needs board',
  })
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/trend-radar/unmet-needs')
  return { ok: true as const }
}
