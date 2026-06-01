// 위탁 등록 규제 진입장벽 메타 — /regulatory 보드 + 상품 상세 배지 공용.

export type BarrierType =
  | 'none'
  | 'kc_safety'
  | 'food_health'
  | 'cosmetic'
  | 'medical_device'
  | 'other'

export interface BarrierMeta {
  label: string
  short: string
  // 즉시 등록 가능(none)을 0, 장벽 높을수록 큰 값 — 칸반 컬럼 정렬용
  order: number
  badgeClass: string // 배지/카드 색
}

export const BARRIER_META: Record<string, BarrierMeta> = {
  none: { label: '즉시 등록 가능', short: '즉시', order: 0, badgeClass: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  kc_safety: { label: 'KC 인증 (전안법)', short: 'KC', order: 2, badgeClass: 'bg-orange-100 text-orange-700 border-orange-200' },
  food_health: { label: '식약처 신고 (식품·건기식)', short: '식약처', order: 3, badgeClass: 'bg-red-100 text-red-700 border-red-200' },
  cosmetic: { label: '화장품책임판매업', short: '화장품', order: 3, badgeClass: 'bg-pink-100 text-pink-700 border-pink-200' },
  medical_device: { label: '의료기기 판매업', short: '의료기기', order: 4, badgeClass: 'bg-purple-100 text-purple-700 border-purple-200' },
  other: { label: '기타 인증 필요', short: '기타', order: 2, badgeClass: 'bg-amber-100 text-amber-700 border-amber-200' },
  unclassified: { label: '미분류', short: '미분류', order: 9, badgeClass: 'bg-gray-100 text-gray-500 border-gray-200' },
}

// 보드 컬럼 표시 순서 (왼쪽 즉시등록 → 오른쪽 인증필요)
export const BARRIER_COLUMNS: BarrierType[] = [
  'none',
  'kc_safety',
  'cosmetic',
  'food_health',
  'medical_device',
  'other',
]

export function barrierMeta(t: string | null | undefined): BarrierMeta {
  if (!t) return BARRIER_META.unclassified
  return BARRIER_META[t] ?? BARRIER_META.other
}

export const COST_BAND_LABEL: Record<string, string> = {
  free: '무비용',
  low: '낮음',
  mid: '중간',
  high: '높음',
}

export function isNoBarrier(t: string | null | undefined): boolean {
  return t === 'none'
}
