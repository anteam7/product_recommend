'use server'

import { createAdminClient } from '@/lib/auth/admin-supabase'

interface SavePick {
  productId: string
  name: string
  cluster: string
  supplier: string
  marginalValue: number
  rawValue: number
  estAdSpend: number
  effort: number
}

export async function savePortfolio(input: {
  slots: number
  adBudget: number
  corrPenalty: number
  picks: SavePick[]
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const sb = createAdminClient()
  // RPC jimscanner_save_portfolio 는 supabase/trends_portfolio_board.sql 에 정의 — generated 타입 미반영
  const { data, error } = await sb.rpc('jimscanner_save_portfolio' as never, {
    p_slots: input.slots,
    p_ad_budget: input.adBudget,
    p_corr_penalty: input.corrPenalty,
    p_picks: input.picks,
  } as never)
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: String(data) }
}
