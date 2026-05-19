/**
 * Product Lifecycle Stage (PLC) 분류 — 룰 + LLM 어시스트 하이브리드.
 *
 * 입력 시그널:
 *   (a) Naver search/shopping 볼륨 30일 1차/2차 미분 (slope / curvature)
 *   (b) Smartstore SERP 리뷰 누적 곡선 모양
 *   (c) 판매자 수 성장률
 *   (d) 가격 중앙값 추세
 *   (e) ggsan 재입고 빈도
 *
 * 출력:
 *   - stage: 'introduction' | 'growth' | 'maturity' | 'decline' | 'extinct'
 *   - velocity: -1.0 ~ +1.0 (방향성 강도)
 *   - evidence: 시그널별 정규화 값 + 룰 어떤 게이트 통과했는지
 *
 * cron 매일 KST 06:00 의 마지막 step 에서 src/scoring/recompute.ts 가
 * classifyLifecycle() 을 product 별 호출 후 supabase 에 upsert.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type LifecycleStage =
  | 'introduction'
  | 'growth'
  | 'maturity'
  | 'decline'
  | 'extinct'

export interface LifecycleSignals {
  /** Naver volume 30일 1차 미분 정규화 (-1 ~ +1). 양수=상승 추세 */
  volume_slope: number | null
  /** 2차 미분 정규화 (-1 ~ +1). 양수=가속, 음수=감속 */
  volume_curvature: number | null
  /** Smartstore SERP 리뷰 누적 30일 slope */
  review_slope: number | null
  /** 신규 판매자 진입 속도 정규화 (-1 ~ +1) */
  seller_growth: number | null
  /** 가격 중앙값 30일 추세 (-1 ~ +1, 음수=하락) */
  price_trend: number | null
  /** ggsan 재입고 빈도 (회/30d, 정규화 0 ~ +1) */
  restock_freq: number | null
  /** 데이터가 쌓이기 시작한 후 경과일 */
  age_days: number | null
}

export interface LifecycleResult {
  stage: LifecycleStage | null
  velocity: number
  evidence: Record<string, unknown>
  /** 같은 stage 라도 신뢰도. 0.0 ~ 1.0 */
  confidence: number
}

const STAGE_LABELS: Record<LifecycleStage, string> = {
  introduction: '도입',
  growth: '성장',
  maturity: '성숙',
  decline: '쇠퇴',
  extinct: '소멸',
}

export function stageLabel(s: LifecycleStage | null | undefined): string {
  if (!s) return '미분류'
  return STAGE_LABELS[s]
}

const STAGE_PLAYBOOKS: Record<LifecycleStage, { title: string; actions: string[] }> = {
  introduction: {
    title: '선점 · 저단가 테스트',
    actions: [
      '소량 발주(MOQ 최소) 로 시장 반응 측정',
      '광고 예산 보수적(일 1만원 이하) · 키워드 폭 좁게',
      '상세페이지 A/B 테스트로 후킹 카피 검증',
      '리뷰 5건 확보까지 가격 마진 −5% 감수',
    ],
  },
  growth: {
    title: '재고확대 · 광고 · 번들',
    actions: [
      '재고 2~3배 확대, 도매처 2nd 라인 확보',
      '광고 ROAS 3.0 까지 공격적 확장',
      '번들/세트 상품 SKU 추가로 객단가 ↑',
      '체험단 / 인플루언서 시딩으로 리뷰 가속',
    ],
  },
  maturity: {
    title: '차별화 SKU · 가격 최적화',
    actions: [
      '경쟁사 추적, 가격 ±5% 내 유지',
      '컬러·사이즈·옵션 SKU 다변화로 점유율 방어',
      '리텐션 쿠폰 / 재구매 트리거 강화',
      '광고 ROAS 최적화 (수익성 위주)',
    ],
  },
  decline: {
    title: '청산 · 대체핀 전환',
    actions: [
      '재고 −30% 감축, 신규 발주 중단',
      '할인 (−15~25%) 으로 재고 회전 가속',
      '광고 예산 50% 컷, 잔량 소진까지만 유지',
      '대체 핀(같은 카테고리 신상품) 으로 트래픽 이전',
    ],
  },
  extinct: {
    title: '아카이브',
    actions: [
      '판매 페이지 비활성화 / 노출 제거',
      '잔여 재고 클리어런스 처리',
      '학습된 패턴(시즌·키워드) 만 보관, 상품은 archive',
    ],
  },
}

export function playbookFor(stage: LifecycleStage | null | undefined) {
  if (!stage) return { title: '데이터 부족', actions: ['최소 14일 누적 데이터가 필요합니다.'] }
  return STAGE_PLAYBOOKS[stage]
}

/**
 * 다음 스테이지 ETA 추정 (단순 룰): velocity 절대값이 클수록 빠르게 전이.
 * 반환: 일(day) 단위 추정치. null = 정체 / 추정 불가.
 */
export function nextStageEtaDays(
  stage: LifecycleStage | null,
  velocity: number,
): number | null {
  if (!stage) return null
  const v = Math.abs(velocity)
  if (v < 0.05) return null

  const baseline: Record<LifecycleStage, number> = {
    introduction: 30,
    growth: 60,
    maturity: 90,
    decline: 45,
    extinct: 0,
  }
  if (stage === 'extinct') return null
  return Math.max(7, Math.round(baseline[stage] / Math.max(0.1, v)))
}

/**
 * Heuristic 룰 기반 1차 분류. 시그널 부족 시 null 반환 (LLM 어시스트로 패스).
 *
 * Stage decision tree:
 *   - 데이터 < 14일 → introduction (or null)
 *   - volume_slope 강한 양수 + curvature 양수 → growth
 *   - volume_slope ≈ 0 + age > 90 + review 누적 큼 → maturity
 *   - volume_slope 강한 음수 + price 하락 → decline
 *   - 모든 시그널 ≈ 0 + age > 180 → extinct
 */
export function classifyByRules(s: LifecycleSignals): LifecycleResult | null {
  const age = s.age_days ?? 0
  const vs = s.volume_slope ?? 0
  const vc = s.volume_curvature ?? 0
  const rs = s.review_slope ?? 0
  const sg = s.seller_growth ?? 0
  const pt = s.price_trend ?? 0
  const rf = s.restock_freq ?? 0

  const composite =
    0.35 * vs + 0.2 * vc + 0.2 * rs + 0.15 * sg + 0.1 * rf
  const velocity = clamp(composite, -1, 1)

  const evidence = {
    volume_slope: vs,
    volume_curvature: vc,
    review_slope: rs,
    seller_growth: sg,
    price_trend: pt,
    restock_freq: rf,
    age_days: age,
    composite,
  }

  if (age < 14) {
    return {
      stage: 'introduction',
      velocity,
      evidence: { ...evidence, gate: 'age<14' },
      confidence: 0.55,
    }
  }

  const flat = Math.abs(vs) < 0.08 && Math.abs(vc) < 0.08 && Math.abs(rs) < 0.05

  if (flat && age > 180 && rf < 0.05 && sg < -0.1) {
    return {
      stage: 'extinct',
      velocity,
      evidence: { ...evidence, gate: 'flat+age>180+no-restock' },
      confidence: 0.75,
    }
  }

  if (vs < -0.15 && pt < -0.05) {
    return {
      stage: 'decline',
      velocity,
      evidence: { ...evidence, gate: 'volume_slope<-0.15 & price↓' },
      confidence: 0.7,
    }
  }

  if (vs > 0.15 && vc > -0.05) {
    return {
      stage: 'growth',
      velocity,
      evidence: { ...evidence, gate: 'volume_slope>0.15 & not-decelerating' },
      confidence: 0.7,
    }
  }

  if (age > 60 && flat) {
    return {
      stage: 'maturity',
      velocity,
      evidence: { ...evidence, gate: 'age>60 & flat' },
      confidence: 0.65,
    }
  }

  // 룰 게이트 미통과 → LLM 어시스트 필요
  return null
}

/**
 * LLM 어시스트 분류 (룰 게이트 미통과 시 호출).
 * MVP 단계에서는 룰 기반 fallback 으로 maturity 처리 + 낮은 confidence.
 * 추후 Claude API 연동 시 prompt 에 evidence 전부 전달 + 5단계 분류 강제.
 */
export function classifyByLlmAssist(s: LifecycleSignals): LifecycleResult {
  const composite =
    0.35 * (s.volume_slope ?? 0) +
    0.2 * (s.volume_curvature ?? 0) +
    0.2 * (s.review_slope ?? 0) +
    0.15 * (s.seller_growth ?? 0) +
    0.1 * (s.restock_freq ?? 0)
  const velocity = clamp(composite, -1, 1)

  let stage: LifecycleStage
  if (composite > 0.05) stage = 'growth'
  else if (composite < -0.05) stage = 'decline'
  else stage = 'maturity'

  return {
    stage,
    velocity,
    evidence: {
      volume_slope: s.volume_slope,
      volume_curvature: s.volume_curvature,
      review_slope: s.review_slope,
      seller_growth: s.seller_growth,
      price_trend: s.price_trend,
      restock_freq: s.restock_freq,
      age_days: s.age_days,
      composite,
      gate: 'llm-assist-fallback',
    },
    confidence: 0.45,
  }
}

export function classifyLifecycle(s: LifecycleSignals): LifecycleResult {
  return classifyByRules(s) ?? classifyByLlmAssist(s)
}

/**
 * Supabase product 1건의 시그널을 시계열 raw 데이터에서 도출.
 * 30일 윈도우. 데이터가 부족하면 null 시그널로 반환.
 */
export async function deriveSignalsForProduct(
  supabase: SupabaseClient,
  productId: string,
): Promise<LifecycleSignals> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()

  // 점수 시계열에서 trend_score / supplier_score 의 slope·curvature 추출.
  // 보조 시그널이 없으면 0 으로 처리.
  const { data: scoreRows } = await (supabase as any)
    .from('jimscanner_trends_scores')
    .select('trend_score, commerce_score, supplier_score, competition_score, computed_at')
    .eq('product_id', productId)
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })

  const rows = (scoreRows ?? []) as Array<{
    trend_score: number
    commerce_score: number
    supplier_score: number
    competition_score: number
    computed_at: string
  }>

  if (rows.length < 3) {
    return {
      volume_slope: null,
      volume_curvature: null,
      review_slope: null,
      seller_growth: null,
      price_trend: null,
      restock_freq: null,
      age_days: rows.length,
    }
  }

  const trendSeries = rows.map((r) => r.trend_score)
  const commerceSeries = rows.map((r) => r.commerce_score)
  const supplierSeries = rows.map((r) => r.supplier_score)
  const compSeries = rows.map((r) => r.competition_score)

  const { data: prod } = await (supabase as any)
    .from('jimscanner_trends_products')
    .select('first_seen_at')
    .eq('id', productId)
    .maybeSingle()

  const firstSeen = prod?.first_seen_at ? new Date(prod.first_seen_at).getTime() : Date.now()
  const ageDays = Math.max(0, Math.floor((Date.now() - firstSeen) / 86400_000))

  return {
    volume_slope: normalizedSlope(trendSeries),
    volume_curvature: normalizedCurvature(trendSeries),
    review_slope: normalizedSlope(commerceSeries),
    seller_growth: -normalizedSlope(compSeries), // 경쟁점수↓ 가 셀러 증가
    price_trend: normalizedSlope(commerceSeries) * 0.5, // proxy
    restock_freq: clamp(avg(supplierSeries) / 100, 0, 1),
    age_days: ageDays,
  }
}

// ─────────────────────────────────────────────────────────
// math helpers
// ─────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/**
 * 선형 회귀 slope 를 [-1, +1] 로 정규화.
 * 점수가 0~100 스케일이라고 가정 → slope 절대값 1.0 이면 30일에 30점 변화.
 */
function normalizedSlope(series: number[]): number {
  if (series.length < 2) return 0
  const n = series.length
  const xMean = (n - 1) / 2
  const yMean = avg(series)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (series[i] - yMean)
    den += (i - xMean) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  // 1 step 당 점수 변화 → 30 step 으로 환산 후 30점 = 1.0 으로 정규화
  return clamp((slope * 30) / 30, -1, 1)
}

/**
 * 2차 미분 (curvature) 근사: 인접 slope 차이.
 */
function normalizedCurvature(series: number[]): number {
  if (series.length < 4) return 0
  const half = Math.floor(series.length / 2)
  const firstHalf = series.slice(0, half)
  const secondHalf = series.slice(half)
  const s1 = normalizedSlope(firstHalf)
  const s2 = normalizedSlope(secondHalf)
  return clamp(s2 - s1, -1, 1)
}
