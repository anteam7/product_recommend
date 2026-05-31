// ─────────────────────────────────────────────────────────────
// 예상 월 시장규모(원) 추정 — 상대점수(0~100) → 절대 KRW 환산
// ─────────────────────────────────────────────────────────────
// 입력:
//   ① 검색량 절대 앵커 (검색광고 월간 검색수). #38 미적재 시 trend_score 로 근사.
//   ② 카테고리 추정 구매전환율 (보수/기본/낙관 3밴드)
//   ③ 평균 판매가 (supplier.price_krw × 소매 마크업 또는 쿠팡 시장가)
// 출력:
//   - 예상 월 거래액(GMV, 원): 시장 전체 파이
//   - 획득가능 매출(SAM, 원): competition_score 로 분배한 '내 몫'
//
// ⚠️ 모든 수치는 추정. 과신 방지를 위해 항상 3밴드로 노출한다.
// 근거 문서: platform_direction.md, supabase/trends_v4_market_size.sql

export type Band = 'conservative' | 'base' | 'optimistic'

/** 카테고리별 추정 구매전환율 (기본밴드, 검색→구매). 보수/낙관은 배수로 파생. */
const CONVERSION_BASE: Record<string, number> = {
  health: 0.015, // 영양제/건강 — 반복구매·고관여
  living: 0.02, // 생활용품 — 충동구매 비중 ↑
  digital: 0.01, // 디지털/가전 — 비교탐색 길어 전환 ↓
  shopping_tv: 0.018,
  community: 0.012,
  all: 0.015,
}

/** 카테고리별 도매가→소매 판매가 마크업 (쿠팡 시장가 부재 시 fallback). */
const RETAIL_MARKUP: Record<string, number> = {
  health: 2.4,
  living: 2.2,
  digital: 1.8,
  shopping_tv: 2.3,
  community: 2.0,
  all: 2.2,
}

/**
 * 카테고리별 월간 검색수 앵커 상한 (trend_score=100 이 가리키는 절대 검색수).
 * #38(검색광고 월간 검색수)이 score_components.trend.monthly_searches 로 적재되면
 * 그 값을 직접 쓰고, 없으면 이 상한 × (trend_score/100) 으로 근사한다.
 */
const SEARCH_ANCHOR_MAX: Record<string, number> = {
  health: 90_000,
  living: 120_000,
  digital: 70_000,
  shopping_tv: 60_000,
  community: 40_000,
  all: 80_000,
}

/** 밴드별 배수 — 전환율·앵커에 동일 적용해 보수/기본/낙관 시나리오 생성. */
const BAND_MULT: Record<Band, { conv: number; anchor: number }> = {
  conservative: { conv: 0.6, anchor: 0.7 },
  base: { conv: 1.0, anchor: 1.0 },
  optimistic: { conv: 1.6, anchor: 1.35 },
}

const cat = (c: string | null | undefined) => (c && c in CONVERSION_BASE ? c : 'all')

/**
 * 검색량 절대 앵커(월간 검색수) 산출.
 * score_components.trend.monthly_searches(#38) 우선, 없으면 trend_score 근사.
 */
export function resolveMonthlySearches(input: {
  category: string
  trendScore: number
  scoreComponents?: any
}): { value: number; source: 'anchor' | 'estimated' } {
  const anchored = Number(
    input.scoreComponents?.trend?.monthly_searches ??
      input.scoreComponents?.monthly_searches ??
      NaN,
  )
  if (Number.isFinite(anchored) && anchored > 0) {
    return { value: anchored, source: 'anchor' }
  }
  const max = SEARCH_ANCHOR_MAX[cat(input.category)]
  const t = Math.max(0, Math.min(100, input.trendScore)) / 100
  // 저점 노이즈 억제를 위해 살짝 볼록(power 1.3)하게.
  return { value: Math.round(max * Math.pow(t, 1.3)), source: 'estimated' }
}

/**
 * 추정 평균 판매가(원). 쿠팡 시장가 우선, 없으면 도매가 × 카테고리 마크업.
 */
export function resolveAvgPrice(input: {
  category: string
  supplierPriceKrw?: number | null
  marketPriceKrw?: number | null
}): { value: number; source: 'market' | 'wholesale_markup' | 'none' } {
  if (input.marketPriceKrw && input.marketPriceKrw > 0) {
    return { value: Math.round(input.marketPriceKrw), source: 'market' }
  }
  if (input.supplierPriceKrw && input.supplierPriceKrw > 0) {
    return {
      value: Math.round(input.supplierPriceKrw * RETAIL_MARKUP[cat(input.category)]),
      source: 'wholesale_markup',
    }
  }
  return { value: 0, source: 'none' }
}

/**
 * competition_score(0~100, 높을수록 경쟁 약함) → 추정 경쟁 셀러 수 + 내 획득 점유율.
 * 경쟁 약하면 셀러 수 적고 → 신규 진입자(나) 점유율 ↑.
 */
export function resolveCapture(competitionScore: number): {
  estimatedSellers: number // 이미 시장에 있는 셀러 수(추정)
  myRank: number // 내가 진입 시 N번째
  captureShare: number // 0~1, 균등분배 가정 시 내 몫
} {
  const c = Math.max(0, Math.min(100, competitionScore)) / 100
  // 경쟁 약함(c→1) 이면 셀러 ~2, 경쟁 강함(c→0) 이면 셀러 ~40.
  const sellers = Math.max(1, Math.round(2 + (1 - c) * 38))
  const myRank = sellers + 1
  // 균등분배가 아니라 후순위 페널티(조화감쇠)를 반영: 내 몫 = 1 / (sellers+1).
  return { estimatedSellers: sellers, myRank, captureShare: 1 / myRank }
}

export interface MarketSizeBandResult {
  band: Band
  monthlySearches: number
  conversionRate: number
  avgPrice: number
  /** 예상 월 거래액(시장 전체, 원) */
  gmvKrw: number
  /** 내가 진입 시 획득가능 월 매출(SAM, 원) */
  samKrw: number
}

export interface MarketSizeEstimate {
  searchSource: 'anchor' | 'estimated'
  priceSource: 'market' | 'wholesale_markup' | 'none'
  estimatedSellers: number
  myRank: number
  captureShare: number
  bands: Record<Band, MarketSizeBandResult>
  /** 정렬·버블 크기용 기준값 = base 밴드 GMV */
  sortKey: number
}

export function estimateMarketSize(input: {
  category: string
  trendScore: number
  competitionScore: number
  supplierPriceKrw?: number | null
  marketPriceKrw?: number | null
  scoreComponents?: any
}): MarketSizeEstimate {
  const c = cat(input.category)
  const search = resolveMonthlySearches({
    category: c,
    trendScore: input.trendScore,
    scoreComponents: input.scoreComponents,
  })
  const price = resolveAvgPrice({
    category: c,
    supplierPriceKrw: input.supplierPriceKrw,
    marketPriceKrw: input.marketPriceKrw,
  })
  const capture = resolveCapture(input.competitionScore)
  const convBase = CONVERSION_BASE[c]

  const bands = {} as Record<Band, MarketSizeBandResult>
  for (const band of ['conservative', 'base', 'optimistic'] as Band[]) {
    const m = BAND_MULT[band]
    const searches = Math.round(search.value * m.anchor)
    const conv = convBase * m.conv
    const gmv = Math.round(searches * conv * price.value)
    bands[band] = {
      band,
      monthlySearches: searches,
      conversionRate: conv,
      avgPrice: price.value,
      gmvKrw: gmv,
      samKrw: Math.round(gmv * capture.captureShare),
    }
  }

  return {
    searchSource: search.source,
    priceSource: price.source,
    estimatedSellers: capture.estimatedSellers,
    myRank: capture.myRank,
    captureShare: capture.captureShare,
    bands,
    sortKey: bands.base.gmvKrw,
  }
}

/** 원화 압축 표기: 12,300,000 → "1,230만", 230,000,000 → "2.3억". */
export function formatKrwShort(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '–'
  if (v >= 100_000_000) {
    const eok = v / 100_000_000
    return `${eok >= 10 ? Math.round(eok) : eok.toFixed(1)}억`
  }
  if (v >= 10_000) {
    return `${Math.round(v / 10_000).toLocaleString('ko-KR')}만`
  }
  return `${Math.round(v).toLocaleString('ko-KR')}`
}
