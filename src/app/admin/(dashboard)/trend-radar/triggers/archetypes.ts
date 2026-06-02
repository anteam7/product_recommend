// 트렌드 촉발 아키타입 표시 메타 — page.tsx(triggers) + trend-radar 메인 카드 배지에서 공유.
// jimscanner_trend_trigger_classify RPC 의 trigger_archetype 값에 대응.

export type Archetype = 'tv' | 'news' | 'community' | 'search' | 'season'

export interface ArchetypeMeta {
  key: Archetype
  label: string
  emoji: string
  badgeClass: string
  durabilityLabel: string
  posture: string        // 권장 소싱 포스처 (사람이 읽는 한글)
  postureHint: string
}

export const ARCHETYPES: Record<Archetype, ArchetypeMeta> = {
  tv: {
    key: 'tv',
    label: 'TV 출연',
    emoji: '📺',
    badgeClass: 'bg-purple-100 text-purple-800 border-purple-200',
    durabilityLabel: '플래시',
    posture: '얕게-빠르게',
    postureHint: '스파이크형 단기 소진 — 소량·빠른 회전, 재고 길게 묶지 말 것',
  },
  community: {
    key: 'community',
    label: '커뮤니티·밈',
    emoji: '💬',
    badgeClass: 'bg-pink-100 text-pink-800 border-pink-200',
    durabilityLabel: '입소문',
    posture: '얕게-빠르게',
    postureHint: '입소문·밈 — 단기~중기, 화제 식기 전 진입',
  },
  search: {
    key: 'search',
    label: '검색 유기',
    emoji: '🔍',
    badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
    durabilityLabel: '점진',
    posture: '중간',
    postureHint: '유기 검색 수요 — 중기, 표준 재고 운영',
  },
  news: {
    key: 'news',
    label: '뉴스·규제',
    emoji: '📰',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    durabilityLabel: '구조적',
    posture: '깊게-길게',
    postureHint: '뉴스·규제발 구조적 수요 — 깊게·길게, 재고 확보 유리',
  },
  season: {
    key: 'season',
    label: '계절',
    emoji: '🗓️',
    badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
    durabilityLabel: '주기적',
    posture: '깊게-길게',
    postureHint: '시즌 주기 수요 — 시즌 전 깊게 확보, 시즌 후 소진',
  },
}

export function archetypeMeta(key: string | null | undefined): ArchetypeMeta {
  return ARCHETYPES[(key as Archetype)] ?? ARCHETYPES.search
}

// 지속성 1~4 막대 (플래시→구조적) 의 색
export function durabilityColor(d: number): string {
  if (d <= 1) return 'bg-red-400'
  if (d === 2) return 'bg-orange-400'
  if (d === 3) return 'bg-blue-400'
  return 'bg-emerald-500'
}
