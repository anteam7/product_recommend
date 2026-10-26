/**
 * 도매아토즈 가격 모델 — docs/plan-domeatoz.md §2 (2026-10-26)
 *
 *   매입원가 cost = 도매가 W + 배송비 S(주문 1건당). 묶음배송 가능 수량 1개라 n개 = n×(W+S) → 1개 단위만 등록.
 *   순이익·목표·하한 공식은 campingmoon-price 공용 함수(net = P − cost − fee×P − (P − cost)/11, src/lib/margin.ts 와 동일).
 *   기준 시세 ref = 쿠팡 규격 일치가의 하위 25%(일치 3건 이상), 2건 이하면 최저가. 식품 최저가는 로켓·특가라 그 아래로는 못 판다.
 *   price = clamp(target, floor, ref × (1 − UNDERCUT)) ; ref 없음 = NO_MATCH(보류) ; ref×0.99 < floor = STRUCTURAL(보류)
 *   ⚠ 수수료는 쿠팡 식품 기본 10.6%(src/lib/coupang/fee.ts 기본값) — 별도 항목 없음.
 */
import { netProfit, priceAtMargin, priceAtAbs, ceil10 } from './campingmoon-price.mjs'

export const COUPANG_FEE = 0.106
export const TARGET_MARGIN = 0.10
export const MIN_MARGIN = 0.07
export const MIN_ABS = 2000
export const UNDERCUT = 0.01
export const MIN_P25_MATCHES = 3

export const costOf = (wholesale, ship) => (wholesale > 0 ? wholesale + (ship || 0) : null)
export const floorPrice = (cost, fee = COUPANG_FEE) => Math.max(priceAtMargin(cost, MIN_MARGIN, fee), priceAtAbs(cost, MIN_ABS, fee))
export const targetPrice = (cost, fee = COUPANG_FEE) => priceAtMargin(cost, TARGET_MARGIN, fee)

/** 정렬된 가격들의 하위 q 분위(최근접 순위) */
export function quantile(prices, q) {
  const a = prices.filter((n) => n > 0).sort((x, y) => x - y)
  if (!a.length) return null
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]
}
/** 기준 시세: 일치 3건 이상이면 P25, 아니면 최저가 */
export function refPrice(prices) {
  const a = prices.filter((n) => n > 0)
  if (!a.length) return null
  return a.length >= MIN_P25_MATCHES ? quantile(a, 0.25) : Math.min(...a)
}

/** @returns {{cost, floor, target, ref, ceiling, price, net, margin, verdict:'OK'|'STRUCTURAL'|'NO_MATCH'|'NO_COST'}} */
export function decide(wholesale, ship, prices, { fee = COUPANG_FEE } = {}) {
  const cost = costOf(wholesale, ship)
  if (!cost) return { cost: null, floor: null, target: null, ref: null, ceiling: null, price: null, net: null, margin: null, verdict: 'NO_COST' }
  const floor = floorPrice(cost, fee), target = Math.max(floor, targetPrice(cost, fee))
  const ref = refPrice(prices || [])
  const ceiling = ref ? ceil10(ref * (1 - UNDERCUT)) : null
  let price = null, verdict
  if (ceiling == null) verdict = 'NO_MATCH'
  else if (ceiling < floor) verdict = 'STRUCTURAL'
  else { price = Math.max(floor, Math.min(target, ceiling)); verdict = 'OK' }
  const net = price ? Math.round(netProfit(price, cost, fee)) : null
  return { cost, floor, target, ref, ceiling, price, net, margin: price ? +(net / price).toFixed(3) : null, verdict }
}
