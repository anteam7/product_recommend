/**
 * 반품률(Return Rate) 추정 점수 — 5번째 차원 '운영비용'.
 *
 * 산식:
 *   (a) 카테고리 베이스라인 (jimscanner_returns_baseline.return_rate_mid, %)
 *   (b) SERP 리뷰 부정 시그널 (low_star_ratio + 부정 키워드 빈도)
 *
 * 두 신호를 가중합해 0~100 으로 정규화.
 *   - 0   = 반품률 거의 0% (최안전)
 *   - 100 = 반품률 50%+ (최위험)
 *
 * 베이스라인만 있고 리뷰 신호가 없을 땐 베이스라인 기반 점수만 산출.
 */

export interface ReturnRiskInput {
  baselinePct: number | null              // 0~100 (%) 카테고리 반품률 추정
  lowStarRatio?: number | null            // 0.0~1.0 (1~2점 비율)
  negativeKeywordCount?: number | null    // 부정 키워드 누적 카운트
  totalReviews?: number | null            // 표본 (정규화용)
}

export interface ReturnRiskResult {
  score: number                            // 0~100
  components: {
    baseline_pct: number | null
    baseline_pts: number                   // baseline 기여 점수
    low_star_pts: number                   // 1~2점 기여 점수
    negative_kw_pts: number                // 부정 키워드 기여 점수
    sample_size: number | null
  }
}

const BASELINE_WEIGHT = 0.55
const LOWSTAR_WEIGHT = 0.30
const NEGKW_WEIGHT   = 0.15

/**
 * 반품률 % → 0~100 점수 매핑.
 *   - 0%  → 0pt
 *   - 30% → 60pt
 *   - 50%+ → 100pt (clamp)
 */
function baselinePctToPoints(pct: number): number {
  const capped = Math.max(0, Math.min(50, pct))
  return Math.round((capped / 50) * 100)
}

/**
 * 1~2점 비율 (0~1) → 0~100.
 *   - 0.0 → 0
 *   - 0.5 → 100
 */
function lowStarRatioToPoints(ratio: number): number {
  const capped = Math.max(0, Math.min(0.5, ratio))
  return Math.round((capped / 0.5) * 100)
}

/**
 * 부정 키워드 카운트 → 0~100.
 *   - reviews 대비 비율로 정규화. 표본 없으면 absolute count fallback.
 */
function negativeKeywordsToPoints(count: number, totalReviews: number | null | undefined): number {
  if (totalReviews && totalReviews > 0) {
    const ratio = count / totalReviews
    const capped = Math.max(0, Math.min(0.3, ratio))
    return Math.round((capped / 0.3) * 100)
  }
  const capped = Math.max(0, Math.min(20, count))
  return Math.round((capped / 20) * 100)
}

export function computeReturnRisk(input: ReturnRiskInput): ReturnRiskResult {
  const baseline_pts =
    input.baselinePct != null ? baselinePctToPoints(input.baselinePct) : 0
  const low_star_pts =
    input.lowStarRatio != null ? lowStarRatioToPoints(input.lowStarRatio) : 0
  const negative_kw_pts =
    input.negativeKeywordCount != null
      ? negativeKeywordsToPoints(input.negativeKeywordCount, input.totalReviews ?? null)
      : 0

  // 베이스라인만 있을 땐 베이스라인 가중치를 1.0 으로.
  const hasReviewSignal =
    input.lowStarRatio != null || input.negativeKeywordCount != null
  const score = hasReviewSignal
    ? Math.round(
        baseline_pts * BASELINE_WEIGHT +
          low_star_pts * LOWSTAR_WEIGHT +
          negative_kw_pts * NEGKW_WEIGHT,
      )
    : baseline_pts

  return {
    score: Math.max(0, Math.min(100, score)),
    components: {
      baseline_pct: input.baselinePct,
      baseline_pts,
      low_star_pts,
      negative_kw_pts,
      sample_size: input.totalReviews ?? null,
    },
  }
}

/**
 * 위험도 라벨 — UI 칩 표시용.
 */
export function returnRiskLabel(score: number | null | undefined): {
  label: string
  tone: 'safe' | 'caution' | 'warn' | 'danger' | 'unknown'
} {
  if (score == null) return { label: '미산출', tone: 'unknown' }
  if (score < 20) return { label: '안전', tone: 'safe' }
  if (score < 40) return { label: '주의', tone: 'caution' }
  if (score < 70) return { label: '경고', tone: 'warn' }
  return { label: '위험', tone: 'danger' }
}

export const RETURN_RISK_TONE_CLASS: Record<
  ReturnType<typeof returnRiskLabel>['tone'],
  string
> = {
  safe:    'bg-emerald-50 text-emerald-700 border-emerald-200',
  caution: 'bg-amber-50 text-amber-700 border-amber-200',
  warn:    'bg-orange-50 text-orange-700 border-orange-200',
  danger:  'bg-red-50 text-red-700 border-red-200',
  unknown: 'bg-gray-50 text-gray-500 border-gray-200',
}
