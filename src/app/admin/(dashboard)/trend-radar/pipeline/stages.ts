// 파이프라인 단계 정의 — 서버/클라이언트 공유 (값을 server component 에서 import 하려면
// 'use client' 모듈이 아니어야 한다. PipelineBoard 는 여기서 re-import).

export type StageKey = 'discovered' | 'reviewing' | 'sourcing' | 'listed' | 'selling' | 'dropped'

export const STAGES: { key: StageKey; label: string; tone: string }[] = [
  { key: 'discovered', label: '발굴', tone: 'bg-gray-100 text-gray-700' },
  { key: 'reviewing', label: '검토', tone: 'bg-blue-100 text-blue-700' },
  { key: 'sourcing', label: '소싱확정', tone: 'bg-indigo-100 text-indigo-700' },
  { key: 'listed', label: '등록', tone: 'bg-violet-100 text-violet-700' },
  { key: 'selling', label: '판매', tone: 'bg-emerald-100 text-emerald-700' },
  { key: 'dropped', label: '이탈', tone: 'bg-rose-100 text-rose-700' },
]

export const DROP_REASONS = ['마진부족', '반품위험', '소싱불가', '경쟁과포화', '인증장벽', '기타'] as const

export interface PipelineCard {
  product_id: string
  name: string
  category: string
  stage: StageKey
  stage_changed_at: string | null
  dropped_reason: string | null
  note: string | null
  final_score: number | null
  virtual?: boolean
}
