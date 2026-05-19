/**
 * 국내 택배 단가 + 배송부담률 계산.
 *
 * 입력: 부피무게/실무게/최장변/위험속성 + ggsan 도매가.
 * 출력: 단가 택배비(원), 추정 판매가(원), burden_ratio(0~1).
 *
 * 데이터 소스 가정:
 *   - 국내 일반 택배 1단가 = 무게·부피 둘 중 큰 쪽으로 결정
 *   - 부피무게 = 가로*세로*높이(cm) / 5000 → kg
 *   - hazard_class 별 추가 비용 가산 (식품·액체 보냉/누액방지 패킹)
 *
 * 출처: 한진/CJ 일반 택배 2026 표준요금 + 자사 운영 경험.
 */

export type Fragility = 'low' | 'med' | 'high'
export type HazardClass = 'none' | 'food' | 'liquid' | 'electronics' | 'cosmetics' | 'battery'

export interface PhysicalProps {
  actualWeightG?: number | null
  dimWeightG?: number | null
  longestCm?: number | null
  fragility?: Fragility | null
  hazardClass?: HazardClass | null
}

const WEIGHT_TIERS_KRW: ReadonlyArray<{ maxKg: number; krw: number }> = [
  { maxKg: 2, krw: 3500 },
  { maxKg: 5, krw: 4500 },
  { maxKg: 10, krw: 5500 },
  { maxKg: 20, krw: 7500 },
  { maxKg: 30, krw: 10500 },
]
const OVERSIZED_KRW = 13500

const HAZARD_SURCHARGE_KRW: Record<HazardClass, number> = {
  none: 0,
  food: 800,
  liquid: 1200,
  electronics: 500,
  cosmetics: 400,
  battery: 1800,
}

const FRAGILITY_SURCHARGE_KRW: Record<Fragility, number> = {
  low: 0,
  med: 500,
  high: 1200,
}

/** 도매가→소비자 추정가 배율. 가격대별 마진율 차이 반영. */
function estimateMarginMultiplier(wholesaleKrw: number): number {
  if (wholesaleKrw < 3000) return 4.0
  if (wholesaleKrw < 10000) return 2.6
  if (wholesaleKrw < 30000) return 2.0
  if (wholesaleKrw < 100000) return 1.6
  return 1.4
}

export function estimateSellingPrice(wholesaleKrw: number): number {
  if (!wholesaleKrw || wholesaleKrw <= 0) return 0
  return Math.round(wholesaleKrw * estimateMarginMultiplier(wholesaleKrw))
}

/** 부피무게/실무게 중 큰 쪽 (g). */
export function effectiveWeightG(p: PhysicalProps): number | null {
  const dim = p.dimWeightG ?? null
  const act = p.actualWeightG ?? null
  if (dim == null && act == null) return null
  return Math.max(dim ?? 0, act ?? 0)
}

/** 국내 단가 택배비 (원). 무게+할증 합산. */
export function computeUnitShippingKrw(p: PhysicalProps): number | null {
  const wG = effectiveWeightG(p)
  if (wG == null) return null
  const wKg = wG / 1000

  let base = OVERSIZED_KRW
  for (const tier of WEIGHT_TIERS_KRW) {
    if (wKg <= tier.maxKg) {
      base = tier.krw
      break
    }
  }
  // 최장변 100cm 초과 시 오버사이즈 (대형화물) 강제 격상.
  if ((p.longestCm ?? 0) > 100 && base < OVERSIZED_KRW) {
    base = OVERSIZED_KRW
  }
  const hazard = HAZARD_SURCHARGE_KRW[(p.hazardClass ?? 'none') as HazardClass] ?? 0
  const frag = FRAGILITY_SURCHARGE_KRW[(p.fragility ?? 'low') as Fragility] ?? 0
  return base + hazard + frag
}

export interface BurdenResult {
  unitShippingKrw: number
  estimatedSellKrw: number
  burdenRatio: number
  tier: 'green' | 'yellow' | 'red'
}

export function computeBurden(
  props: PhysicalProps,
  wholesaleKrw: number,
): BurdenResult | null {
  const ship = computeUnitShippingKrw(props)
  if (ship == null) return null
  const sell = estimateSellingPrice(wholesaleKrw)
  if (sell <= 0) return null
  const ratio = ship / sell
  let tier: BurdenResult['tier'] = 'yellow'
  if (ratio <= 0.08) tier = 'green'
  else if (ratio >= 0.15) tier = 'red'
  return {
    unitShippingKrw: ship,
    estimatedSellKrw: sell,
    burdenRatio: Number(ratio.toFixed(4)),
    tier,
  }
}

export function tierBadge(tier: BurdenResult['tier']): { emoji: string; label: string } {
  if (tier === 'green') return { emoji: '🟢', label: '저부담' }
  if (tier === 'red') return { emoji: '🔴', label: '마진킬러' }
  return { emoji: '🟡', label: '주의' }
}
