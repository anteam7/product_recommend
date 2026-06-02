// 프로모션 의존도 게이트 — alias.source 3계열 분류 + 의존지수 산출
//
// ① 딜/특가계열  : 딥할인이 만든 수요 (ppomppu_main, quasarzone_sale ...)
// ② 오가닉수요계열: 검색/쇼핑 인사이트 등 진짜 수요 (naver_search_trend, naver_shopping_insight/hot ...)
// ③ 커뮤니티화제계열: 입소문 (dcinside, natepan, 82cook, clien ...)
//
// 위탁 셀러는 딥할인 경쟁이 불가능 → 딜계열로만 뜬 상품은 정가에서 안 팔리는 함정.
// dependency_index = deal_heat / max(organic_heat + community_heat, 1)
//   높을수록(빨강) 프로모션 의존, 낮을수록(초록) 오가닉 주도.

export type SourceClass = 'deal' | 'organic' | 'community' | 'other'

// substring 매칭 (source 문자열 표기 흔들림 대비). 위에서부터 우선.
const DEAL_PATTERNS = ['ppomppu', 'quasarzone', 'hotdeal', 'fmkorea_hotdeal', 'eomisae', '_sale', 'deal']
const ORGANIC_PATTERNS = [
  'naver_search',
  'naver_shopping',
  'naver_datalab',
  'shopping_insight',
  'shopping_hot',
  'shopping_trend',
  'google_suggest',
  'gsc',
  'naver_tvtime',
]
const COMMUNITY_PATTERNS = ['dcinside', 'natepan', '82cook', 'clien', 'theqoo', 'instiz', 'ruliweb', 'community']

export function classifySource(source: string | null | undefined): SourceClass {
  if (!source) return 'other'
  const s = source.toLowerCase()
  // deal 우선 — fmkorea 는 hotdeal 일 때만 deal, 그 외 community 로 떨어지도록 deal 먼저 검사
  if (DEAL_PATTERNS.some((p) => s.includes(p))) return 'deal'
  if (ORGANIC_PATTERNS.some((p) => s.includes(p))) return 'organic'
  if (COMMUNITY_PATTERNS.some((p) => s.includes(p))) return 'community'
  return 'other'
}

export interface DemandQuality {
  deal_heat: number
  organic_heat: number
  community_heat: number
  dependency_index: number
  verdict: 'red' | 'amber' | 'green'
}

const RED_THRESHOLD = 1.5
const GREEN_THRESHOLD = 0.5

export function verdictFor(dealHeat: number, organicHeat: number, communityHeat: number): DemandQuality {
  const realDemand = organicHeat + communityHeat
  // 분모 0 방어: 오가닉/커뮤니티 heat 가 전혀 없고 딜만 있으면 강한 의존.
  const dependency_index = dealHeat / Math.max(realDemand, 1)
  let verdict: DemandQuality['verdict']
  if (dependency_index >= RED_THRESHOLD && dealHeat > 0) verdict = 'red'
  else if (dependency_index <= GREEN_THRESHOLD) verdict = 'green'
  else verdict = 'amber'
  return {
    deal_heat: dealHeat,
    organic_heat: organicHeat,
    community_heat: communityHeat,
    dependency_index: Math.round(dependency_index * 100) / 100,
    verdict,
  }
}

// alias.source 목록(confidence 가중)으로부터 heat 집계 → DemandQuality.
export function demandQualityFromAliases(
  aliases: { source: string | null; confidence?: number | null }[],
): DemandQuality {
  let deal = 0
  let organic = 0
  let community = 0
  for (const a of aliases) {
    // confidence 를 가중치로 (manual=1.0, llm 매핑=~0.7). 누락 시 0.5.
    const w = typeof a.confidence === 'number' && a.confidence > 0 ? a.confidence : 0.5
    switch (classifySource(a.source)) {
      case 'deal':
        deal += w
        break
      case 'organic':
        organic += w
        break
      case 'community':
        community += w
        break
    }
  }
  return verdictFor(
    Math.round(deal * 100) / 100,
    Math.round(organic * 100) / 100,
    Math.round(community * 100) / 100,
  )
}
