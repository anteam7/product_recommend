/**
 * 단위경제성(unit economics) 환산 — 발굴 후보를 '원(₩) 단위 기대 순이익'으로 게이트.
 *
 * 공식 출처: scripts/coupang-recompute-margins.mjs (등록 단계 마진 공식)을 발굴 단계로 끌어옴.
 *   - FEE_RATE = 0.106  (기타 영양제 73137 실제 판매수수료, 결제비 포함)
 *   - SHIP     = 3000   (출고 배송비)
 *   - VAT      = 판매가 / 11 (공급가액 기준 부가세)
 *   net = 판매가 − 랜디드원가 − 배송 − 판매수수료 − 부가세
 *
 * 관련 메모리: coupang_pricing_model, tiered_msp_rule
 */

export const FEE_RATE = 0.106
export const SHIP = 3000
export const VAT_DIVISOR = 11

export interface UnitEconomics {
  estimatedSellPrice: number
  landedCost: number
  fee: number
  vat: number
  ship: number
  expectedNetUnit: number
  netMarginPct: number
  gateStatus: 'pass' | 'thin' | 'loss'
}

export interface GateFloor {
  /** 최소 기대 순이익 (₩) */
  minNet: number
  /** 최소 순마진 (%) */
  minMarginPct: number
}

export const DEFAULT_FLOOR: GateFloor = { minNet: 2000, minMarginPct: 15 }

/**
 * 기대 단위순이익 환산. sell/landed 가 없거나 0 이면 null.
 */
export function computeUnitEconomics(
  estimatedSellPrice: number | null | undefined,
  landedCost: number | null | undefined,
  floor: GateFloor = DEFAULT_FLOOR,
): UnitEconomics | null {
  const sell = Number(estimatedSellPrice) || 0
  const landed = Number(landedCost) || 0
  if (sell <= 0 || landed <= 0) return null

  const fee = Math.round(sell * FEE_RATE)
  const vat = Math.round(sell / VAT_DIVISOR)
  const expectedNetUnit = Math.round(sell - landed - SHIP - fee - vat)
  const netMarginPct = +((expectedNetUnit / sell) * 100).toFixed(2)

  let gateStatus: UnitEconomics['gateStatus']
  if (expectedNetUnit < 0) gateStatus = 'loss'
  else if (expectedNetUnit < floor.minNet || netMarginPct < floor.minMarginPct) gateStatus = 'thin'
  else gateStatus = 'pass'

  return {
    estimatedSellPrice: sell,
    landedCost: landed,
    fee,
    vat,
    ship: SHIP,
    expectedNetUnit,
    netMarginPct,
    gateStatus,
  }
}

/**
 * 관찰된 경쟁사 판매가 추정. commerce 신호(score_components) 또는 supplier raw_payload
 * 에 관찰 판매가가 있으면 사용, 없으면 랜디드원가 기반 휴리스틱(×2.2) 폴백.
 */
export function estimateSellPrice(opts: {
  scoreComponents?: any
  supplierRaw?: any
  landedCost?: number | null
}): { value: number; source: 'observed' | 'heuristic' } | null {
  const { scoreComponents, supplierRaw, landedCost } = opts
  const observed =
    Number(scoreComponents?.commerce?.sell_price_krw) ||
    Number(scoreComponents?.commerce?.observed_price_krw) ||
    Number(supplierRaw?.observed_sell_price_krw) ||
    0
  if (observed > 0) return { value: Math.round(observed), source: 'observed' }
  const landed = Number(landedCost) || 0
  if (landed > 0) return { value: Math.round(landed * 2.2), source: 'heuristic' }
  return null
}

export function gateColor(status: UnitEconomics['gateStatus']): string {
  switch (status) {
    case 'pass':
      return 'text-emerald-600'
    case 'thin':
      return 'text-amber-600'
    case 'loss':
      return 'text-rose-600'
  }
}

export function gateLabel(status: UnitEconomics['gateStatus']): string {
  switch (status) {
    case 'pass':
      return '통과'
    case 'thin':
      return '박함'
    case 'loss':
      return '적자'
  }
}

export function won(n: number): string {
  return `₩${Math.round(n).toLocaleString('ko-KR')}`
}
