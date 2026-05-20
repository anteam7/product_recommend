/**
 * resale 시그널 → retention_factor (0~1) 변환 및 tone 분류.
 *
 * retention_factor 는 jimscanner_trends_scores 에 곱셈 게이팅 용도.
 *   1.0 = 후회구매 시그널 없음 (기존 final_score 그대로)
 *   0.0 = 강한 후회구매 시그널 (final_score 깎아내림)
 *
 * 입력: jimscanner_trends_resale_latest 뷰의 한 row.
 */

export interface ResaleSummary {
  price_ratio_avg: number | null
  days_to_sold_avg: number | null
  sold_completed_ratio_avg: number | null
  listings_active_total: number | null
  sold_count_30d_total: number | null
}

/**
 * 0~1 점수.
 *   잔존가 score: price_ratio ≥ 0.7 = 1.0, ≤ 0.3 = 0
 *   회전 score:   days_to_sold ≤ 14 = 1.0, ≥ 60 = 0
 *   매물밀도 score: active/(sold30d+1) ≤ 0.5 = 1.0, ≥ 5 = 0
 *
 * 세 축 기하평균 (한 축이라도 약하면 강하게 감점).
 */
export function computeRetentionFactor(s: ResaleSummary): number | null {
  const hasAny =
    s.price_ratio_avg != null || s.days_to_sold_avg != null || s.listings_active_total != null
  if (!hasAny) return null

  const priceScore =
    s.price_ratio_avg != null ? clamp01((s.price_ratio_avg - 0.3) / (0.7 - 0.3)) : 0.5

  const turnoverScore =
    s.days_to_sold_avg != null ? clamp01((60 - s.days_to_sold_avg) / (60 - 14)) : 0.5

  const sold30 = s.sold_count_30d_total ?? 0
  const active = s.listings_active_total ?? 0
  const density = active / (sold30 + 1)
  const densityScore = clamp01((5 - density) / (5 - 0.5))

  // 기하평균 (0이 되지 않게 살짝 보정)
  const a = Math.max(priceScore, 0.05)
  const b = Math.max(turnoverScore, 0.05)
  const c = Math.max(densityScore, 0.05)
  const geo = Math.cbrt(a * b * c)
  return Number(geo.toFixed(3))
}

export type Tone = 'red' | 'green' | 'gray'

export function classifyRetention(
  s: ResaleSummary,
  retention: number | null,
): { tone: Tone; label: string } {
  if (retention == null) return { tone: 'gray', label: '관찰' }
  // 빨강: 매물 많고 잔존가 낮음
  const lowPrice = (s.price_ratio_avg ?? 1) < 0.4
  const density = (s.listings_active_total ?? 0) / ((s.sold_count_30d_total ?? 0) + 1)
  const highDensity = density > 3
  if (retention < 0.4 || (lowPrice && highDensity)) {
    return { tone: 'red', label: '후회' }
  }
  // 초록: 잔존가 높고 회전 빠름
  const highPrice = (s.price_ratio_avg ?? 0) >= 0.6
  const fastTurnover = (s.days_to_sold_avg ?? 999) <= 21
  if (retention >= 0.7 || (highPrice && fastTurnover)) {
    return { tone: 'green', label: '회전↑' }
  }
  return { tone: 'gray', label: '관찰' }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
