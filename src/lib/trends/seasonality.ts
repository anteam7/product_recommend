/**
 * 계절성 분해 (Seasonal decomposition)
 * ─────────────────────────────────────────────
 * 후보 키워드의 현재 상승분을 "매년 반복되는 월별 계절성" 과
 * "진짜 신규 수요(residual)" 로 분해한다.
 *
 * Naver DataLab 의 다년치 월별 시계열(timeUnit='month')을 받아,
 * 같은 month-of-year 의 과거 중앙값(baseline) 대비 현재값(current)으로:
 *   - seasonal_index      (0~1): 이번 값 중 몇 %가 "매년 이맘때 으레 오르는" 캘린더 효과인지
 *   - deseasonalized_novelty   : 캘린더로 설명되지 않는 잔차 신규 수요 (0~100 ratio level)
 *
 * 절대값이 아니라 DataLab ratio(0~100) 기반이므로 비율 해석만 의미가 있다.
 */

import {
  fetchSearchTrend,
  type DatalabResultItem,
} from './naver-datalab'

export type MonthlyPoint = { period: string; ratio: number; month: number }

export type SeasonalDecomposition = {
  /** 분해 기준 현재값 (가장 최근 월의 ratio, 0~100) */
  current: number
  /** 같은 month-of-year 과거값들의 중앙값 — 캘린더 기준선 */
  baseline: number
  /** 0~1: 이번 값 중 계절(캘린더)로 설명되는 비율. 1 = 완전 계절상품 */
  seasonal_index: number
  /** 캘린더로 설명되지 않는 잔차 신규 수요 (0~100 ratio level) */
  deseasonalized_novelty: number
  /** 비교에 쓰인 같은 월 과거 표본 수 */
  same_month_samples: number
  /** 전체 월 시계열 표본 수 */
  total_months: number
  /** 분해 신뢰 가능 여부 (과거 같은-월 표본 ≥ 1) */
  reliable: boolean
  /** 분해의 기준이 된 월 (1~12) */
  month_of_year: number
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** DataLab 월별 데이터 → MonthlyPoint[] (period 'YYYY-MM-DD' 또는 'YYYY-MM' 모두 지원) */
export function toMonthlyPoints(data: DatalabResultItem[]): MonthlyPoint[] {
  return (data ?? [])
    .map((d) => {
      const m = Number(d.period.slice(5, 7))
      return { period: d.period, ratio: d.ratio ?? 0, month: m }
    })
    .filter((p) => p.month >= 1 && p.month <= 12)
}

/**
 * 월별 다년치 시계열을 계절성과 잔차 신규성으로 분해.
 * 가장 최근 월을 current 로, 그 이전의 "같은 month-of-year" 들의 중앙값을 baseline 으로 사용.
 */
export function decomposeSeasonality(points: MonthlyPoint[]): SeasonalDecomposition | null {
  if (points.length === 0) return null
  // period 오름차순 정렬 보장
  const sorted = [...points].sort((a, b) => a.period.localeCompare(b.period))
  const latest = sorted[sorted.length - 1]
  const current = latest.ratio
  const monthOfYear = latest.month

  // 같은 월(month-of-year)의 과거값들 (현재값 제외)
  const sameMonthPast = sorted
    .slice(0, sorted.length - 1)
    .filter((p) => p.month === monthOfYear)
    .map((p) => p.ratio)

  const baseline = median(sameMonthPast)
  // seasonal_index: 현재값 중 계절(과거 같은-월 중앙값)으로 설명되는 비율
  const seasonalIndex = current > 0 ? clamp01(baseline / current) : 0
  // 잔차 신규성 = 현재값 중 계절로 설명되지 않는 부분
  const novelty = Math.max(0, current * (1 - seasonalIndex))

  return {
    current,
    baseline,
    seasonal_index: Number(seasonalIndex.toFixed(3)),
    deseasonalized_novelty: Number(novelty.toFixed(2)),
    same_month_samples: sameMonthPast.length,
    total_months: sorted.length,
    reliable: sameMonthPast.length >= 1,
    month_of_year: monthOfYear,
  }
}

/**
 * 키워드 1개에 대해 다년치 월별 시계열을 on-demand 로 받아 분해.
 * @param keyword 대표 키워드 (보통 product 의 최고 confidence alias)
 * @param years 거슬러 올라갈 연수 (기본 3년)
 * @param nowKst 'YYYY-MM-DD' (테스트 주입용; 미지정 시 현재 KST)
 */
export async function fetchAndDecompose(
  keyword: string,
  years = 3,
  nowKst?: string,
): Promise<SeasonalDecomposition | null> {
  const today = nowKst ? new Date(nowKst + 'T00:00:00Z') : new Date(Date.now() + 9 * 3600_000)
  const endDate = today.toISOString().slice(0, 10)
  const start = new Date(today.getTime())
  start.setUTCFullYear(start.getUTCFullYear() - years)
  const startDate = start.toISOString().slice(0, 10)

  const resp = await fetchSearchTrend({
    startDate,
    endDate,
    timeUnit: 'month',
    keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
  })
  const group = resp.results?.[0]
  if (!group) return null
  return decomposeSeasonality(toMonthlyPoints(group.data))
}

/**
 * 계절성 보정된 trend_score.
 * 캘린더로 설명되는 분을 discount 만큼 할인 → 잔차 신규성을 부각.
 * @param trendScore 원본 trend_score (0~100)
 * @param decomp 분해 결과 (null 이면 보정 없이 원본 반환)
 * @param discount 계절 비중에 곱할 할인 강도 (0~1, 기본 0.7)
 */
export function seasonalAdjustedTrendScore(
  trendScore: number,
  decomp: SeasonalDecomposition | null | undefined,
  discount = 0.7,
): number {
  if (!decomp || !decomp.reliable) return trendScore
  const factor = 1 - decomp.seasonal_index * discount
  return Math.round(Math.max(0, Math.min(100, trendScore * factor)))
}
