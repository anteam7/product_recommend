/**
 * 캠핑문 가격 모델 — docs/plan-campingmoon.md §2 (2026-10-14)
 *
 *   매입원가 cost(n) = 사업자 35% 할인 적용값. 묶음 n개는 배송비 1회만 들어 단가가 내려간다(1개 마진이 낮을 때 2·3개 묶음 전략).
 *     DISCOUNT_BASE = 'total'   → (n × P_opt + S) × 0.65     ← 사장님 설명(상품금액+배송비 총액의 35%)
 *     DISCOUNT_BASE = 'product' → n × P_opt × 0.65 + S       ← 보수안(공지 "정상가 기준"). 첫 실주문 결제예정금액으로 확정하기 전 기본값
 *   순이익 net(price) = price − cost − fee×price − (price − cost)/11        (src/lib/margin.ts 와 동일)
 *   목표가 target  = net/price = TARGET_MARGIN 이 되는 price
 *   하한가 floor   = max( net/price = MIN_MARGIN, net ≥ MIN_ABS )            이 아래로는 등록·리프라이스 금지
 *   천장   ceiling = 쿠팡 매칭 최저가 × (1 − UNDERCUT) (묶음은 × n)       없으면(매칭 0) target 그대로
 *   결정   price   = clamp(target, floor, ceiling) ; ceiling < floor 면 STRUCTURAL(등록 보류)
 *   ⚠ 수수료는 TS 쪽(src/lib/coupang/fee.ts FEE_RATE_BY_SOURCE)·toss-price.mjs 와 수동 동기화.
 */
export const DISCOUNT_RATE = 0.35
export const SHIP = 3000                     // 캠핑문 주문 1건당 배송비(15만원↑ 무료는 위탁 단건에 해당 없음)
export const COUPANG_FEE = Number(process.env.CAMPINGMOON_COUPANG_FEE || 0.108) // 스포츠/레저 추정 — Wing 확인 전까지 10.8%
if (!(COUPANG_FEE >= 0 && COUPANG_FEE < 0.5)) throw new Error(`CAMPINGMOON_COUPANG_FEE 값 이상: ${process.env.CAMPINGMOON_COUPANG_FEE}`)
export const TOSS_FEE = 0.11
export const VAT = 1 / 11
export const TARGET_MARGIN = 0.10
export const MIN_MARGIN = 0.07
export const MIN_ABS = 2000
export const UNDERCUT = 0.01
export const DISCOUNT_BASE = process.env.CAMPINGMOON_DISCOUNT_BASE || 'product'
if (!['product', 'total'].includes(DISCOUNT_BASE)) throw new Error(`CAMPINGMOON_DISCOUNT_BASE 는 product|total: ${DISCOUNT_BASE}`)

export const ceil10 = (n) => Math.ceil(n / 10) * 10
/** 묶음 n개 매입원가 */
export function costFor(optionPrice, n = 1, base = DISCOUNT_BASE) {
  const p = Number(optionPrice) || 0
  if (!p) return null
  return base === 'total' ? Math.round((n * p + SHIP) * (1 - DISCOUNT_RATE)) : Math.round(n * p * (1 - DISCOUNT_RATE) + SHIP)
}
export const netProfit = (price, cost, fee = COUPANG_FEE) => price - cost - fee * price - (price - cost) * VAT
/** net/price = m 이 되는 가격 */
export const priceAtMargin = (cost, m, fee = COUPANG_FEE) => ceil10((cost * (1 - VAT)) / (1 - fee - VAT - m))
/** net ≥ abs 가 되는 가격 */
export const priceAtAbs = (cost, abs, fee = COUPANG_FEE) => ceil10((abs + cost * (1 - VAT)) / (1 - fee - VAT))
export function floorPrice(cost, fee = COUPANG_FEE) { return Math.max(priceAtMargin(cost, MIN_MARGIN, fee), priceAtAbs(cost, MIN_ABS, fee)) }
export function targetPrice(cost, fee = COUPANG_FEE) { return priceAtMargin(cost, TARGET_MARGIN, fee) }

/**
 * 묶음 n(1..maxN) 별 판정. marketLow = 쿠팡 매칭 최저가(1개 기준, null = 매칭 없음).
 * @returns {{n, cost, floor, target, ceiling, price, net, margin, verdict:'OK'|'STRUCTURAL'|'NO_MATCH'}[]}
 */
export function decide(optionPrice, marketLow, { maxN = 3, fee = COUPANG_FEE, base = DISCOUNT_BASE } = {}) {
  const out = []
  for (let n = 1; n <= maxN; n++) {
    const cost = costFor(optionPrice, n, base)
    if (!cost) break
    const floor = floorPrice(cost, fee), target = targetPrice(cost, fee)
    const ceiling = marketLow ? ceil10(marketLow * n * (1 - UNDERCUT)) : null
    // target 은 보통 floor 위지만 원가가 아주 작으면(배송비만 한 상품) 절대 하한(2,000원) 쪽 floor 가 더 높다 → 항상 floor 로 받친다
    let price, verdict
    if (ceiling == null) { price = Math.max(floor, target); verdict = 'NO_MATCH' }
    else if (ceiling < floor) { price = null; verdict = 'STRUCTURAL' }
    else { price = Math.max(floor, Math.min(target, ceiling)); verdict = 'OK' }
    const net = price ? Math.round(netProfit(price, cost, fee)) : null
    out.push({ n, cost, floor, target, ceiling, price, net, margin: price ? +(net / price).toFixed(3) : null, verdict })
  }
  return out
}
/** 등록할 묶음 선택: 1개가 OK/NO_MATCH 면 1개, 아니면 OK 인 가장 작은 n. 전부 STRUCTURAL 이면 null */
export function pickPack(rows) {
  return rows.find((r) => r.n === 1 && r.verdict !== 'STRUCTURAL') || rows.find((r) => r.verdict === 'OK') || rows.find((r) => r.verdict === 'NO_MATCH') || null
}
