// ────────────────────────────────────────────────────────────
// 순마진 워터폴 — 카테고리별 쿠팡 수수료 반영 실수령 마진 분해
// ────────────────────────────────────────────────────────────
// 발굴 보드(recommend / products[id])에서 '이 후보가 실제로 얼마를 남기나'를 ₩로 보여준다.
// 상수는 scripts/coupang-recompute-margins.mjs 와 동기화:
//   SHIP=3000, VAT_DIVISOR=11, FEE_RATE(기타영양제 73137)=0.106
// 카테고리 수수료율은 DB(jimscanner_coupang_category_fee)가 단일 출처이나,
// generated 타입 미반영 + RPC 미수정 단계에서는 아래 폴백 맵을 쓴다.
// ────────────────────────────────────────────────────────────

export const SHIP_KRW = 3000
export const VAT_DIVISOR = 11
export const DEFAULT_FEE_RATE = 0.106 // 기타영양제(73137)

/** 도매가 → 예상 판매가 배수 (쿠팡 SERP 중앙값 부재 시 폴백). */
export const DEFAULT_SALE_MULTIPLIER = 2.2

/** ggsan cate_cd → 쿠팡 판매수수료율. DB jimscanner_coupang_category_fee 의 시드와 동일. */
export const CATEGORY_FEE_RATE: Record<string, number> = {
  '001': 0.108,
  '002': 0.108,
  '003': 0.108,
  '005': 0.108,
  '006': 0.108,
  '007': 0.108,
  '008': 0.108,
  '009': 0.106,
  '010': 0.108,
  '011': 0.108,
  '012': 0.106,
  '013': 0.106,
  '014': 0.106,
  '020': 0.106,
}

export function feeRateForCategory(cateCd: string | null | undefined): number {
  if (!cateCd) return DEFAULT_FEE_RATE
  return CATEGORY_FEE_RATE[cateCd] ?? DEFAULT_FEE_RATE
}

export interface MarginWaterfall {
  /** 예상 판매가 (쿠팡 등록가 추정) */
  salePrice: number
  /** 도매 원가 (ggsan) */
  cost: number
  /** 쿠팡 판매수수료 (부가세 별도) */
  fee: number
  /** 적용 수수료율 */
  feeRate: number
  /** 배송비 */
  ship: number
  /** 매출 부가세 (판매가/11) */
  vat: number
  /** 실수령 순마진 ₩ */
  netMargin: number
  /** 판매가 대비 마진율 % */
  marginPct: number
  /** 수수료+배송만으로 적자(원가 빼기 전에도 마진 음수)면 '수수료로 죽는 후보' */
  killedByFee: boolean
}

/**
 * 도매가(원가)와 카테고리로 순마진 워터폴 산출.
 * salePrice 가 주어지면 그대로, 없으면 cost × multiplier 로 추정.
 */
export function computeMarginWaterfall(opts: {
  cost: number
  cateCd?: string | null
  salePrice?: number | null
  feeRate?: number
  saleMultiplier?: number
}): MarginWaterfall | null {
  const cost = Math.max(0, Math.round(opts.cost || 0))
  if (cost <= 0) return null

  const feeRate = opts.feeRate ?? feeRateForCategory(opts.cateCd)
  const multiplier = opts.saleMultiplier ?? DEFAULT_SALE_MULTIPLIER
  const salePrice =
    opts.salePrice && opts.salePrice > 0 ? Math.round(opts.salePrice) : Math.round(cost * multiplier)

  const fee = Math.round(salePrice * feeRate)
  const ship = SHIP_KRW
  const vat = Math.round(salePrice / VAT_DIVISOR)
  const netMargin = salePrice - cost - fee - ship - vat
  const marginPct = salePrice > 0 ? +((netMargin / salePrice) * 100).toFixed(1) : 0
  // 원가를 빼기 전(판매가 − 수수료 − 배송 − 부가세)에도 이미 음수면 수수료 구조상 답 없음
  const killedByFee = salePrice - fee - ship - vat <= cost

  return { salePrice, cost, fee, feeRate, ship, vat, netMargin, marginPct, killedByFee }
}

export function formatKRW(n: number): string {
  return `${Math.round(n).toLocaleString()}원`
}
