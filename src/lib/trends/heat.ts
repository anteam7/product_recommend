/**
 * Engagement Heat (화제 열량) — 커뮤니티/뉴스 신호의 '도달 깊이' 축.
 *
 * 기존 트렌드 점수는 '언급 1건 = 가중치 1' 빈도(COUNT)로만 집계해,
 * 댓글 0개 단발 글 10건의 얕은 메아리와 댓글 500개 단일 토론의 깊은 수요를
 * 구분하지 못했다. 이 모듈은 글당 조회/댓글/추천/랭킹을 하나의 '열량 가중치'로
 * 환산한다.
 *
 *   heat = log1p(views + α·comments + β·recommends + γ·rankBonus)
 *
 * - log1p 로 조회수 폭발(수십만)이 점수를 독식하지 않게 수축
 * - 댓글/추천은 조회보다 '깊은 참여'이므로 α, β 로 증폭
 * - metadata 가 비어 있으면(엔게이지먼트 미수집 소스) 1.0 = 기존 빈도 1건과 동일
 *
 * DB 측 동일 공식: supabase/trends_engagement_heat.sql 의 jimscanner_heat_weight().
 * 두 구현은 반드시 동기화 유지.
 */

// 댓글 1개는 조회 COMMENT_ALPHA 회, 추천 1개는 조회 RECOMMEND_BETA 회와 동급.
export const COMMENT_ALPHA = 8
export const RECOMMEND_BETA = 20
// 게시판/검색 상위 랭크 가산 (rank 1 → +RANK_GAMMA, 멀어질수록 감쇠)
export const RANK_GAMMA = 30

export interface EngagementMetadata {
  views?: number | null
  comments?: number | null
  recommends?: number | null
  rank?: number | null
  [key: string]: unknown
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 랭킹(1=최상위)을 가산 신호로 환산. rank 없으면 0.
 * rank 1 → RANK_GAMMA, rank 10 → RANK_GAMMA/10 … (1/rank 감쇠)
 */
function rankBonus(rank: unknown): number {
  const r = num(rank)
  if (r <= 0) return 0
  return RANK_GAMMA / r
}

/**
 * 글 1건의 열량 가중치. 엔게이지먼트가 전혀 없으면 1.0(=빈도 1건).
 */
export function computeHeatWeight(meta: EngagementMetadata | null | undefined): number {
  if (!meta) return 1
  const raw =
    num(meta.views) +
    COMMENT_ALPHA * num(meta.comments) +
    RECOMMEND_BETA * num(meta.recommends) +
    rankBonus(meta.rank)
  if (raw <= 0) return 1
  // log1p 로 수축. base 보정으로 '엔게이지먼트 1건' 이 1.0 근방에서 시작하도록.
  return 1 + Math.log1p(raw)
}

/**
 * 단순 빈도(occurrences) 대비 열량 가중합을 한 쌍으로 묶어 2축 비교에 사용.
 */
export interface HeatVsFrequency {
  frequency: number // 언급 건수 (COUNT)
  heat: number // Σ heatWeight
  /** heat / frequency — 1.0 이면 얕은 메아리, 높을수록 깊은 토론 */
  depth: number
}

export function summarizeHeat(metas: Array<EngagementMetadata | null | undefined>): HeatVsFrequency {
  const frequency = metas.length
  const heat = metas.reduce((acc, m) => acc + computeHeatWeight(m), 0)
  return {
    frequency,
    heat: Math.round(heat * 100) / 100,
    depth: frequency > 0 ? Math.round((heat / frequency) * 100) / 100 : 0,
  }
}
