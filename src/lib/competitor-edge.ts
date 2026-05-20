/**
 * Beat-Them-On-X — 1위 판매자 대비 우리가 차별화 가능한 실행 레버를
 * 우선순위 정렬해 보여주는 보드의 공용 유틸.
 *
 * 입력은 jimscanner_serp_competitor_listings 의 product_id 별 최근 스냅샷.
 * 본 모듈은 페이지 단에서 `as any` 로 받아온 raw row 를 받아 도메인 형태로
 * 정규화하고, competitor_edge_gap (0~100) 과 우선순위 레버 목록을 계산한다.
 */

export type CompetitorListingRow = {
  product_id: string
  channel: string | null
  rank: number
  seller: string | null
  listing_url: string | null
  title: string | null
  option_count: number | null
  detail_image_count: number | null
  has_video: boolean | null
  free_shipping: boolean | null
  ship_sla_hr: number | null
  review_count: number | null
  response_rate: number | null
  low_star_themes: unknown
  price_krw: number | null
  scraped_at: string
}

export type Lever = {
  key:
    | 'option_count'
    | 'detail_image_count'
    | 'has_video'
    | 'free_shipping'
    | 'ship_sla_hr'
    | 'review_response'
  label: string
  /** 1위 값 (사람이 읽을 수 있게 포맷한 문자열) */
  topValue: string
  /** 우리가 어떤 액션으로 이길 수 있는지 한 줄 */
  action: string
  /** 0~100 — 클수록 진입 ROI 가 큰 레버 */
  priority: number
}

/**
 * leader = rank==1 인 row. 없으면 가장 낮은 rank 사용.
 */
export function pickLeader(rows: CompetitorListingRow[]): CompetitorListingRow | null {
  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) => a.rank - b.rank)
  return sorted[0] ?? null
}

/**
 * 1위의 실행 변수를 보고, 약한 레버(=우리가 가산점 받을 영역)를 priority desc 로 정렬.
 *
 * 휴리스틱 (1차 — 후속에서 카테고리별 캘리브레이션 예정):
 *   - option_count       : <=3 → 매우 약함(80) / <=5 → 약함(50) / 그 외 → 20
 *   - detail_image_count : <=5 → 70 / <=10 → 40 / 그 외 → 15
 *   - has_video=false    : 60
 *   - free_shipping=false: 55
 *   - ship_sla_hr>48     : 65 (느림)
 *   - response_rate<0.7  : 40
 */
export function buildLevers(leader: CompetitorListingRow | null): Lever[] {
  if (!leader) return []
  const levers: Lever[] = []

  const opt = leader.option_count
  if (opt != null) {
    const priority = opt <= 3 ? 80 : opt <= 5 ? 50 : 20
    levers.push({
      key: 'option_count',
      label: '옵션 수',
      topValue: `${opt}개`,
      action: opt <= 3 ? '옵션 8개+ 로 추월 가능' : opt <= 5 ? '옵션 +2~3 늘려 차별화' : '옵션은 동등 — 다른 레버 활용',
      priority,
    })
  }

  const dic = leader.detail_image_count
  if (dic != null) {
    const priority = dic <= 5 ? 70 : dic <= 10 ? 40 : 15
    levers.push({
      key: 'detail_image_count',
      label: '상세컷 수',
      topValue: `${dic}장`,
      action: dic <= 5 ? '상세컷 15장+ / 사용씬 보강' : dic <= 10 ? '상세컷 +5~8 보강' : '상세컷은 충분 — 카피로 차별화',
      priority,
    })
  }

  if (leader.has_video === false) {
    levers.push({
      key: 'has_video',
      label: '동영상',
      topValue: '없음',
      action: '30~60초 사용 영상 추가',
      priority: 60,
    })
  }

  if (leader.free_shipping === false) {
    levers.push({
      key: 'free_shipping',
      label: '무료배송',
      topValue: '유료',
      action: '무료배송 정책으로 우위 확보',
      priority: 55,
    })
  }

  const sla = leader.ship_sla_hr
  if (sla != null && sla > 48) {
    levers.push({
      key: 'ship_sla_hr',
      label: '배송 SLA',
      topValue: `${sla}h`,
      action: '국내 출고 24h 이내로 단축',
      priority: 65,
    })
  }

  const resp = leader.response_rate
  if (resp != null && resp < 0.7) {
    levers.push({
      key: 'review_response',
      label: '리뷰 응답률',
      topValue: `${Math.round(resp * 100)}%`,
      action: '리뷰 응답률 95%+ 운영',
      priority: 40,
    })
  }

  return levers.sort((a, b) => b.priority - a.priority)
}

/**
 * competitor_edge_gap (0~100) — score_components 에 합산할 점수.
 *
 * 정의: 1위의 약한 레버 priority 의 가중합. levers 가 비면 0.
 * 의미: 값이 클수록 "1위가 허술하니 우리가 이길 여지가 크다".
 */
export function competitorEdgeGap(levers: Lever[]): number {
  if (!levers.length) return 0
  // top 3 lever 의 평균 — 단순하지만 캘리브레이션 용이.
  const top = levers.slice(0, 3)
  const avg = top.reduce((s, l) => s + l.priority, 0) / top.length
  return Math.round(Math.min(100, Math.max(0, avg)))
}

/**
 * 페이지에서 한 번에 쓰는 헬퍼.
 */
export function summarize(rows: CompetitorListingRow[]) {
  const leader = pickLeader(rows)
  const levers = buildLevers(leader)
  const gap = competitorEdgeGap(levers)
  return { leader, levers, gap, hasData: rows.length > 0 && leader != null }
}
