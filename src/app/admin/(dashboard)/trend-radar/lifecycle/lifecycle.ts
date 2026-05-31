// 수요 곡선 라이프사이클 단계 분류기
//
// jimscanner_trends_scores 의 product 별 final_score 시계열(곡선 형태)을 분석해
// 각 상품을 5단계로 자동 분류한다:
//   introduction(도입기) · growth(성장기) · peak(피크) · decline(쇠퇴기) · fad(반짝유행)
//
// 핵심 특징량:
//  (1) 피크 위치가 현재 대비 과거인가 (이미 지났으면 too-late)
//  (2) 1차 도함수 부호 (상승/하락)
//  (3) 2차 도함수 = 가속도 (성장 가속 중인 pre-peak 가 진입 sweet-spot)
//  (4) 피크 첨도 (좁고 날카로우면 fad)
//
// score_components.lifecycle 에 저장하는 recompute 스크립트와 동일한 로직을 공유한다.

export type LifecycleStage =
  | 'introduction'
  | 'growth'
  | 'peak'
  | 'decline'
  | 'fad'
  | 'unknown'

export interface LifecyclePoint {
  t: number // epoch ms (정렬용)
  v: number // score (final_score 권장, 0~100 가정)
}

export interface LifecycleResult {
  stage: LifecycleStage
  /** 진입 우선순위 정렬용 점수 (성장기 최상위, fad 최하위) */
  priority: number
  /** 최근 1차 도함수 (선형회귀 기울기, 단위: score/step) */
  slope: number
  /** 2차 도함수 = 가속도 */
  accel: number
  /** 피크가 과거인가 (true = 이미 지남) */
  peakPast: boolean
  /** 0~1, 피크 대비 현재 하락률 */
  dropFromPeak: number
  /** 첨도 근사: peak / mean (클수록 날카로움) */
  sharpness: number
  /** 사람이 읽는 한 줄 액션 라벨 */
  action: string
}

export const STAGE_META: Record<
  LifecycleStage,
  { label: string; action: string; color: string; order: number }
> = {
  growth: { label: '성장기', action: '진입 적기', color: 'emerald', order: 0 },
  introduction: { label: '도입기', action: '관찰·선점 검토', color: 'sky', order: 1 },
  peak: { label: '피크', action: '관망', color: 'amber', order: 2 },
  decline: { label: '쇠퇴기', action: '철수', color: 'rose', order: 3 },
  fad: { label: '반짝유행', action: '리드타임 위험 회피', color: 'fuchsia', order: 4 },
  unknown: { label: '판정불가', action: '데이터 누적 대기', color: 'gray', order: 5 },
}

// 최근 n 점에 대한 선형회귀 기울기
function recentSlope(v: number[], n = 3): number {
  const m = Math.min(n, v.length)
  if (m < 2) return 0
  const ys = v.slice(v.length - m)
  const xs = ys.map((_, i) => i)
  const mx = (m - 1) / 2
  const my = ys.reduce((a, b) => a + b, 0) / m
  let num = 0
  let den = 0
  for (let i = 0; i < m; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

/**
 * 시계열(정렬 무관, 내부에서 t 오름차순 정렬)을 단계로 분류한다.
 * 데이터가 3점 미만이면 'unknown'.
 */
export function classifyLifecycle(rawPoints: LifecyclePoint[]): LifecycleResult {
  const pts = [...rawPoints].sort((a, b) => a.t - b.t)
  const v = pts.map((p) => p.v).filter((x) => Number.isFinite(x))

  const base: Omit<LifecycleResult, 'stage' | 'priority' | 'action'> = {
    slope: 0,
    accel: 0,
    peakPast: false,
    dropFromPeak: 0,
    sharpness: 1,
  }

  if (v.length < 3) {
    return { ...base, stage: 'unknown', priority: 99, action: STAGE_META.unknown.action }
  }

  const last = v.length - 1
  const lastV = v[last]

  // 피크 위치 / 값
  let peakIdx = 0
  for (let i = 1; i < v.length; i++) if (v[i] > v[peakIdx]) peakIdx = i
  const peakV = v[peakIdx]

  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sharpness = mean > 0 ? peakV / mean : 1

  // 1차 도함수(최근 기울기) & 2차 도함수(가속도)
  const slope = recentSlope(v, 3)
  const d1Last = v[last] - v[last - 1]
  const d1Prev = v[last - 1] - v[last - 2]
  const accel = d1Last - d1Prev

  // 피크가 분명히 과거인가: 끝에서 2점 이상 이전 + 이후 하락 발생
  const peakPast = peakIdx <= last - 2
  const dropFromPeak = peakV > 0 ? Math.max(0, (peakV - lastV) / peakV) : 0

  // 첨도 근사: 피크 주변이 얼마나 좁은가. peak*0.6 이상인 점 개수가 적을수록 날카롭다.
  const aboveThresh = v.filter((x) => x >= peakV * 0.6).length
  const narrow = aboveThresh <= Math.max(2, Math.ceil(v.length * 0.25))

  let stage: LifecycleStage

  if (peakPast && narrow && sharpness >= 1.8 && dropFromPeak >= 0.45) {
    // 좁고 날카로운 봉우리를 지난 급락 → 반짝유행
    stage = 'fad'
  } else if (peakPast && slope < 0 && dropFromPeak >= 0.15) {
    // 완만한 피크 이후 하락 → 쇠퇴기
    stage = 'decline'
  } else if (!peakPast && slope > 0) {
    // 아직 상승 중(피크가 현재 근처/미래)
    if (accel > 0 && lastV < 40) {
      stage = 'introduction' // 낮은 베이스에서 막 가속 시작 → 도입기
    } else if (accel >= 0) {
      stage = 'growth' // 가속 유지 상승 → 성장기(진입 sweet-spot)
    } else {
      stage = 'peak' // 상승하나 감속 → 피크 임박/도달
    }
  } else {
    // 상승 정체 또는 피크 부근 평탄
    stage = dropFromPeak < 0.1 ? 'peak' : 'decline'
  }

  // 우선순위: 성장기 최상위, 동일 단계 내에서는 가속도/기울기 높은 순
  const order = STAGE_META[stage].order
  const priority = order * 1000 - (slope + accel)

  return {
    ...base,
    stage,
    slope,
    accel,
    peakPast,
    dropFromPeak,
    sharpness,
    priority,
    action: STAGE_META[stage].action,
  }
}
