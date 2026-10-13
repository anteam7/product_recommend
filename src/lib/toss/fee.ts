/**
 * 토스쇼핑 수수료 상수 — node 의존 없음(클라이언트 컴포넌트에서도 import 가능).
 * 판매 8% + 결제 3% (VAT 별도) = 11%. 주문 API에 수수료 실값이 없어 요율로 추정한다.
 */
export const TOSS_FEE_RATE = 0.11

/** 수수료 금액 = round(결제금액 × 요율) */
export function tossFee(revenue: number): number {
  return Math.round(revenue * TOSS_FEE_RATE)
}
