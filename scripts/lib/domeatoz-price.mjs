/**
 * 도매아토즈 가격 모델 — docs/plan-domeatoz.md §2 (2026-10-26)
 *
 *   매입원가 cost = 도매가 W + 배송비 S(주문 1건당). 묶음배송 가능 수량 1개라 n개 = n×(W+S) → 1개 단위만 등록.
 *   순이익·목표·하한 공식은 campingmoon-price 공용 함수(net = P − cost − fee×P − (P − cost)/11, src/lib/margin.ts 와 동일).
 *   2026-11-20 사장님 "10%는 최소마진 — 더 높일 수 있으면 높여도 돼, 시세를 모를 때는 15%":
 *   floor = max(순마진 10%, 순이익 2,000원) — 최소. 시세(같은 규격 쿠팡 최저가 low)가 있으면 price = low − 1,000원(11/04 인상 규칙과 같음),
 *   그러면 하한 밑이면 기준 시세 ref(일치 3건↑ P25, 아니면 최저가) −1%, 그래도 하한 밑 = STRUCTURAL. 시세 없음 = NO_MATCH → decideNoMarket 이 15%.
 *   (전엔 price = clamp(목표 10%, 하한 7%, ref −1%) — 10%가 상한이라 시세가 높아도 10%로 팔았다)
 *   ⚠ 수수료는 쿠팡 식품 기본 10.6%(src/lib/coupang/fee.ts 기본값) — 별도 항목 없음.
 */
import { netProfit, priceAtMargin, priceAtAbs, ceil10 } from './campingmoon-price.mjs'

export const COUPANG_FEE = 0.106
export const MIN_MARGIN = 0.10 // 최소 순마진(사장님 2026-11-20, 전엔 7%)
export const NO_MARKET_MARGIN = 0.15 // 시세를 모를 때(사장님 2026-11-20, 전엔 10%)
export const TARGET_MARGIN = NO_MARKET_MARGIN // 옛 이름(domeatoz-market.mjs 표시용)
export const MIN_ABS = 2000
export const UNDERCUT_KRW = 1000 // 같은 상품 최저가보다 1,000원 싸게
export const UNDERCUT = 0.01 // 1,000원을 못 깎으면 1%
export const MIN_P25_MATCHES = 3

export const costOf = (wholesale, ship) => (wholesale > 0 ? wholesale + (ship || 0) : null)
export const floorPrice = (cost, fee = COUPANG_FEE) => Math.max(priceAtMargin(cost, MIN_MARGIN, fee), priceAtAbs(cost, MIN_ABS, fee))
/** 시세를 모를 때 가격(순마진 15%) */
export const targetPrice = (cost, fee = COUPANG_FEE) => priceAtMargin(cost, NO_MARKET_MARGIN, fee)

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
  const ps = (prices || []).filter((n) => n > 0)
  const ref = refPrice(ps), low = ps.length ? Math.min(...ps) : null
  let ceiling = low ? Math.floor((low - UNDERCUT_KRW) / 10) * 10 : null
  // 1,000원을 못 깎으면 최저가 −1%, 그것도 하한 밑이면 기준 시세(P25) −1% — 로켓·특가 최저가 아래로는 못 팔아도 대부분보다는 싸게(옛 규칙)
  if (ceiling != null && ceiling < floor) ceiling = ceil10(low * (1 - UNDERCUT))
  if (ceiling != null && ceiling < floor) ceiling = ceil10(ref * (1 - UNDERCUT))
  let price = null, verdict
  if (ceiling == null) verdict = 'NO_MATCH'
  else if (ceiling < floor) verdict = 'STRUCTURAL'
  else { price = ceiling; verdict = 'OK' }
  const net = price ? Math.round(netProfit(price, cost, fee)) : null
  return { cost, floor, target, ref, ceiling, price, net, margin: price ? +(net / price).toFixed(3) : null, verdict }
}

/**
 * 시세 판정 없이 등록할 가격 — 사장님 2026-10-30 "시세조회하지말고 등록해, 시세조회 때문에 등록이 안 되는 게 더 안 좋다".
 * 시세가 OK 면 decide 그대로(최저가 −1,000원), 시세 없음(미조회·NO_MATCH)은 순마진 15%, STRUCTURAL(시세가 하한보다 낮음)은 하한(10%) · verdict 'TARGET'.
 */
export function decideNoMarket(wholesale, ship, prices, { fee = COUPANG_FEE } = {}) {
  const d = decide(wholesale, ship, prices, { fee })
  if (d.verdict === 'OK' || d.verdict === 'NO_COST') return d
  const price = d.verdict === 'STRUCTURAL' ? d.floor : d.target
  const net = Math.round(netProfit(price, d.cost, fee))
  return { ...d, price, net, margin: +(net / price).toFixed(3), verdict: 'TARGET', basis: d.verdict === 'STRUCTURAL' ? 'floor' : 'no-market' }
}
