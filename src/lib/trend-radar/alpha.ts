/**
 * 고유알파 분해 — 카테고리 동조(베타)를 빼낸 단독 상승(알파) 산출.
 *
 *  배경: final_score 는 절대 점수라 "카테고리 전체가 뜨는 바람에 같이 뜬 제품(베타)"과
 *        "제 카테고리를 역행해 단독으로 뜬 제품(알파)"을 구분하지 못한다.
 *        전자는 모두가 보는 레드오션, 후자가 1인 셀러가 노릴 진짜 엣지.
 *
 *  방법: jimscanner_trends_scores 의 trend_score 시계열을 category_top 으로 묶어,
 *        각 카테고리의 공통 추세지수(동일 카테고리 제품 일별 점수의 중앙값) 변화를 베타로,
 *        각 제품의 총상승에서 베타를 뺀 잔차를 알파로 분해한다.
 *
 *        총상승(totalDelta) = 베타(beta) + 알파(alpha)
 *        beta  = 카테고리 인덱스(일별 중앙값)의 윈도우 순변화 — 카테고리 공통 상승분
 *        alpha = 제품 총상승 − beta — 카테고리를 초과한 단독 상승분(잔차)
 */

export interface AlphaSeriesPoint {
  date: string
  score: number
}

export interface CategoryIndex {
  category: string
  /** 일별 중앙값 인덱스 시계열 */
  series: AlphaSeriesPoint[]
  /** 윈도우 순변화 = beta */
  beta: number
  memberCount: number
}

export type AlphaLabel = 'alpha' | 'beta' | 'neutral'

export interface AlphaRow {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
  firstScore: number
  lastScore: number
  totalDelta: number
  beta: number
  alpha: number
  label: AlphaLabel
  days: number
  series: AlphaSeriesPoint[]
}

export interface AlphaResult {
  days: number
  rows: AlphaRow[]
  categories: Record<string, CategoryIndex>
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

interface RawScore {
  product_id: string
  trend_score: number | null
  computed_at: string
}
interface RawProduct {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number | null
}

/**
 * 알파/베타 분해 랭킹을 산출한다.
 *  - 같은 날(date) 안에 여러 score row 가 있으면 가장 최근 것을 그 날의 값으로 채택.
 *  - 윈도우 안에 2일 이상 데이터가 있는 제품만 분해 대상.
 */
export async function computeAlphaRanking(
  // service-role supabase client (createAdminClient()). 타입은 마이그레이션 무관하게 any 로 둠.
  sb: any,
  opts: { days?: number; category?: string } = {},
): Promise<AlphaResult> {
  const days = Math.max(2, Math.min(30, opts.days ?? 7))
  // 경계 포함을 위해 하루 여유.
  const since = new Date(Date.now() - (days + 1) * 86400_000).toISOString()

  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })
    .limit(20000)

  const scores = (scoreData ?? []) as RawScore[]
  if (scores.length === 0) return { days, rows: [], categories: {} }

  // product_id → (date → 그 날 최신 trend_score)
  const perProductDaily = new Map<string, Map<string, number>>()
  for (const s of scores) {
    if (s.trend_score == null) continue
    const date = s.computed_at.slice(0, 10)
    let m = perProductDaily.get(s.product_id)
    if (!m) {
      m = new Map()
      perProductDaily.set(s.product_id, m)
    }
    // ascending 정렬이므로 같은 날 마지막(최신) 값이 덮어쓰기됨.
    m.set(date, s.trend_score)
  }

  const productIds = [...perProductDaily.keys()]
  const { data: prodData } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', productIds)
  const products = (prodData ?? []) as RawProduct[]
  const prodMap = new Map(products.map((p) => [p.id, p]))

  // 윈도우 안의 날짜 축 (전 제품 통합)
  const allDates = new Set<string>()
  for (const m of perProductDaily.values()) for (const d of m.keys()) allDates.add(d)
  const sortedDates = [...allDates].sort()

  // 카테고리별 일별 점수 모음 → 중앙값 인덱스
  const catDailyScores = new Map<string, Map<string, number[]>>()
  const catMembers = new Map<string, Set<string>>()
  for (const [pid, m] of perProductDaily) {
    const p = prodMap.get(pid)
    if (!p) continue
    if (opts.category && opts.category !== 'all' && p.category_top !== opts.category) continue
    const cat = p.category_top
    if (!catMembers.has(cat)) catMembers.set(cat, new Set())
    catMembers.get(cat)!.add(pid)
    let dm = catDailyScores.get(cat)
    if (!dm) {
      dm = new Map()
      catDailyScores.set(cat, dm)
    }
    for (const [date, score] of m) {
      if (!dm.has(date)) dm.set(date, [])
      dm.get(date)!.push(score)
    }
  }

  const categories: Record<string, CategoryIndex> = {}
  for (const [cat, dm] of catDailyScores) {
    const series: AlphaSeriesPoint[] = sortedDates
      .filter((d) => dm.has(d))
      .map((d) => ({ date: d, score: Math.round(median(dm.get(d)!) * 10) / 10 }))
    const beta = series.length >= 2 ? series[series.length - 1].score - series[0].score : 0
    categories[cat] = {
      category: cat,
      series,
      beta: Math.round(beta * 10) / 10,
      memberCount: catMembers.get(cat)?.size ?? 0,
    }
  }

  const rows: AlphaRow[] = []
  for (const [pid, m] of perProductDaily) {
    const p = prodMap.get(pid)
    if (!p) continue
    if (opts.category && opts.category !== 'all' && p.category_top !== opts.category) continue
    const series: AlphaSeriesPoint[] = sortedDates
      .filter((d) => m.has(d))
      .map((d) => ({ date: d, score: m.get(d)! }))
    if (series.length < 2) continue
    const firstScore = series[0].score
    const lastScore = series[series.length - 1].score
    const totalDelta = Math.round((lastScore - firstScore) * 10) / 10
    const beta = categories[p.category_top]?.beta ?? 0
    const alpha = Math.round((totalDelta - beta) * 10) / 10

    // 라벨: 알파가 총상승의 주동인 → 'alpha'(고유 상승), 베타가 주동인 → 'beta'(동조)
    let label: AlphaLabel = 'neutral'
    if (totalDelta > 0.5 || alpha > 0.5) {
      if (alpha >= Math.abs(beta) && alpha > 0.5) label = 'alpha'
      else if (beta > 0.5 && beta > alpha) label = 'beta'
    }

    rows.push({
      id: pid,
      canonical_name: p.canonical_name,
      category_top: p.category_top,
      alias_count: p.alias_count ?? 0,
      firstScore,
      lastScore,
      totalDelta,
      beta,
      alpha,
      label,
      days,
      series,
    })
  }

  rows.sort((a, b) => b.alpha - a.alpha)
  return { days, rows, categories }
}
