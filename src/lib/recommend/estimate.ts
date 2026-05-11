// 카트 → 무게 추정 + 운송수단 분기 + 국가 추천 로직
// DB 조회는 호출자가 담당. 이 모듈은 순수 함수만.

import type {
  CartItemInput,
  CartItemEstimate,
  CartEstimate,
  Country,
  ShippingMode,
  Confidence,
} from './types'

// jimscanner_category_weights 행 (lookup용 부분 집합)
export type WeightRow = {
  source_country: Country | null
  shipping_mode: 'air' | 'boat' | 'mixed' | null // manifest 측 표기
  category_tag: string
  brand: string | null
  sample_n: number
  weight_p25_kg: number | null
  weight_median_kg: number
  weight_p75_kg: number | null
  confidence: Confidence
}

function asNum(v: number | null | undefined, fallback: number): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : fallback
}

// 우선순위 매칭: country+brand → brand만 → country만 → 카테고리 통합
export function lookupWeight(
  rows: WeightRow[],
  category_tag: string,
  brand: string | null,
  country: Country | null,
): { row: WeightRow | null; matched: CartItemEstimate['matched_source'] } {
  const cat = rows.filter((r) => r.category_tag === category_tag)
  if (cat.length === 0) return { row: null, matched: 'no_match' }

  if (brand) {
    if (country) {
      const r = cat.find((r) => r.brand === brand && r.source_country === country)
      if (r) return { row: r, matched: 'category_brand_country' }
    }
    const r = cat.find((r) => r.brand === brand && r.source_country === null)
    if (r) return { row: r, matched: 'category_brand' }
  }

  if (country) {
    const r = cat.find((r) => r.brand === null && r.source_country === country)
    if (r) return { row: r, matched: 'category_country' }
  }

  const r = cat.find((r) => r.brand === null && r.source_country === null)
  if (r) return { row: r, matched: 'category_only' }
  return { row: null, matched: 'no_match' }
}

// 카트 항목별 무게 추정
export function estimateItem(
  weights: WeightRow[],
  item: CartItemInput,
  country: Country | null,
): CartItemEstimate {
  const { row, matched } = lookupWeight(weights, item.category_tag, item.brand, country)
  if (!row) {
    return {
      input: item,
      weight_per_pc_kg: null,
      sample_n: 0,
      confidence: 'low',
      matched_source: 'no_match',
    }
  }
  return {
    input: item,
    weight_per_pc_kg: {
      p25: asNum(row.weight_p25_kg, row.weight_median_kg),
      median: row.weight_median_kg,
      p75: asNum(row.weight_p75_kg, row.weight_median_kg),
    },
    sample_n: row.sample_n,
    confidence: row.confidence,
    matched_source: matched,
  }
}

// 전체 카트 합산
export function buildCartEstimate(items: CartItemEstimate[]): CartEstimate {
  let p25 = 0,
    median = 0,
    p75 = 0
  let minN = Number.POSITIVE_INFINITY
  let allMatched = true
  for (const it of items) {
    if (!it.weight_per_pc_kg) {
      allMatched = false
      continue
    }
    const pcs = Math.max(1, it.input.pcs)
    p25 += it.weight_per_pc_kg.p25 * pcs
    median += it.weight_per_pc_kg.median * pcs
    p75 += it.weight_per_pc_kg.p75 * pcs
    if (it.sample_n < minN) minN = it.sample_n
  }

  // 카트 전체 신뢰도 = 최약 항목의 신뢰도 (chain 강도)
  let confidence: Confidence = 'low'
  if (allMatched && items.length > 0) {
    if (minN >= 10) confidence = 'high'
    else if (minN >= 5) confidence = 'mid'
  }

  return {
    items,
    total_weight_kg: {
      p25: Math.round(p25 * 1000) / 1000,
      median: Math.round(median * 1000) / 1000,
      p75: Math.round(p75 * 1000) / 1000,
    },
    confidence,
  }
}

// 국가 추천 — 사용자 미지정 시 카트 항목들의 default_country 다수결
export function recommendCountry(
  defaults: Array<Country | null>,
  override: Country | null | undefined,
): Country | null {
  if (override) return override
  const counts = new Map<Country, number>()
  for (const c of defaults) {
    if (!c) continue
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best: Country | null = null
  let bestN = 0
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c
      bestN = n
    }
  }
  return best
}

// 운송수단 자동 분기
// 룰: < 2kg → air / 5kg+ → sea / 그 외 → air (기본).
// FURNITURE 카테고리 포함 시 무게 무관 sea.
export function recommendShippingMode(
  totalMedianKg: number,
  categoryTags: string[],
  override?: ShippingMode | null,
): ShippingMode {
  if (override) return override
  if (categoryTags.includes('FURNITURE')) return 'sea'
  if (totalMedianKg >= 5) return 'sea'
  return 'air'
}

// 합산 무게가 어느 무게 구간에 들어가는지 결정
// shipping_rates는 weight_min <= w < weight_max (관례).
// 단, 0kg 입력 시 NaN 안 되도록 1g 보정.
export function weightToBracketKg(totalKg: number): number {
  return totalKg < 0.001 ? 0.001 : totalKg
}

// 부가서비스가 단순 토글 가능한지 판정
// 단순 = price_numeric 있음 + price_text 에 '~', '별도', '문의', '실비', '청구' 없음
export function isSimplePrice(priceText: string | null, priceNumeric: number | null): boolean {
  if (priceNumeric === null) return false
  if (priceNumeric < 0) return false // -1 같은 sentinel
  if (!priceText) return true
  const lower = priceText.toLowerCase()
  if (priceText.includes('~') || priceText.includes('별도') || priceText.includes('문의')) return false
  if (priceText.includes('실비') || priceText.includes('청구')) return false
  if (lower.includes('quote') || lower.includes('contact')) return false
  return true
}
