/**
 * 트렌드 라이프사이클 5단계 분류 — 어드민용 시각 메타 + sourcing 액션.
 * 산출은 scripts/compute-lifecycle.mjs (cron) 가 담당하고, 결과는
 * jimscanner_trends_lifecycle 테이블에 적재된다. 이 모듈은 표시 메타만 보유.
 */

export type LifecycleStage = 'emerging' | 'rising' | 'peak' | 'declining' | 'dormant'

export const STAGE_ORDER: LifecycleStage[] = ['emerging', 'rising', 'peak', 'declining', 'dormant']

export interface StageMeta {
  stage: LifecycleStage
  label: string
  emoji: string
  badgeClass: string
  columnClass: string
  /** 단계별 sourcing 액션 권고 */
  action: string
  /** 카드 하단 한줄 권고 */
  blurb: string
}

export const STAGE_META: Record<LifecycleStage, StageMeta> = {
  emerging: {
    stage: 'emerging',
    label: '발아',
    emoji: '🌱',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    columnClass: 'border-emerald-200 bg-emerald-50/50',
    action: '관찰',
    blurb: '히스토리 짧음 — 가벼운 표본 발주로 신호 검증',
  },
  rising: {
    stage: 'rising',
    label: '상승',
    emoji: '🚀',
    badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
    columnClass: 'border-blue-200 bg-blue-50/50',
    action: '즉시 검토',
    blurb: '상승 추세 — 도매 발주 우선순위. 최대 매출 구간 임박',
  },
  peak: {
    stage: 'peak',
    label: '정점',
    emoji: '⭐',
    badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
    columnClass: 'border-amber-200 bg-amber-50/50',
    action: '재고만 확보',
    blurb: '정점 구간 — 신규 진입은 위험, 기존 재고 회전에 집중',
  },
  declining: {
    stage: 'declining',
    label: '쇠퇴',
    emoji: '📉',
    badgeClass: 'bg-rose-100 text-rose-800 border-rose-200',
    columnClass: 'border-rose-200 bg-rose-50/50',
    action: '신규 진입 금지',
    blurb: '하락 추세 — 신규 발주 보류, 보유 재고는 할인 처분 고려',
  },
  dormant: {
    stage: 'dormant',
    label: '휴면',
    emoji: '💤',
    badgeClass: 'bg-gray-100 text-gray-700 border-gray-200',
    columnClass: 'border-gray-200 bg-gray-50/50',
    action: '대기',
    blurb: '신호 약함 — 모니터링만, 재점화 시그널 대기',
  },
}

export function getStageMeta(stage: string | null | undefined): StageMeta {
  if (stage && (stage as LifecycleStage) in STAGE_META) {
    return STAGE_META[stage as LifecycleStage]
  }
  return STAGE_META.dormant
}
