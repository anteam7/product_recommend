import type { SupabaseClient } from '@supabase/supabase-js'

export interface ReturnRiskRow {
  goods_no: string
  risk_score: number
  risk_tier: 'low' | 'medium' | 'high'
  baseline_rate: number
  baseline_source: string
  signals: string[]
}

export interface ReturnRiskDetailRow extends ReturnRiskRow {
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  option_variance_score: number
  price_penalty_score: number
  category_score: number
}

/**
 * 추천 후보 goods_no 배열을 받아 반품위험 점수를 일괄 조회.
 * RPC 미반영 시 빈 Map 반환 (UI 는 위험 미표시로 graceful degrade).
 */
export async function fetchReturnRiskBatch(
  sb: SupabaseClient,
  goodsNos: string[],
): Promise<Map<string, ReturnRiskRow>> {
  const m = new Map<string, ReturnRiskRow>()
  if (goodsNos.length === 0) return m

  // RPC 타입 미반영 — `as never` 캐스팅
  const { data, error } = await sb.rpc('jimscanner_return_risk_batch' as never, {
    p_goods_nos: goodsNos,
  } as never)

  if (error || !data) return m

  for (const r of data as ReturnRiskRow[]) {
    if (r && r.goods_no) m.set(r.goods_no, r)
  }
  return m
}

export async function fetchReturnRiskDetail(
  sb: SupabaseClient,
  goodsNo: string,
): Promise<ReturnRiskDetailRow | null> {
  const { data, error } = await sb.rpc('jimscanner_return_risk_score' as never, {
    p_goods_no: goodsNo,
    p_keyword: null,
  } as never)
  if (error || !data) return null
  const rows = data as ReturnRiskDetailRow[]
  return rows[0] ?? null
}

export function riskBadge(tier: 'low' | 'medium' | 'high'): {
  label: string
  className: string
} {
  switch (tier) {
    case 'high':
      return { label: '⚠ 반품위험 高', className: 'bg-red-100 text-red-700 border-red-200' }
    case 'medium':
      return { label: '⚠ 반품위험 中', className: 'bg-amber-100 text-amber-700 border-amber-200' }
    default:
      return { label: '반품위험 低', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  }
}
