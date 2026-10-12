/**
 * 쿠팡 판매수수료·배송 상수 — node 의존 없음(클라이언트 컴포넌트에서도 import 가능).
 * price.ts(서버 전용)가 이 값을 재export 한다. .mjs 스크립트는 import 못 하므로 값 변경 시 scripts/ 쪽도 같이 맞출 것.
 */
export const SHIP = 3000 // 위탁 dropship: 고객 출고 배송 1회분

/** 기본 수수료 — 기타 영양제(73137) 10.6% (결제비 포함, VAT 별도). 카테고리 수수료는 API로 조회 불가. */
export const FEE_RATE = 0.106

/**
 * 매입처별 수수료 — 매입처가 곧 카테고리인 경우(화장품스토리=뷰티 9.6%).
 * 리스팅 카테고리 컬럼이 없어 매입처(source)로 근사한다. 미등록 매입처는 FEE_RATE.
 */
export const FEE_RATE_BY_SOURCE: Record<string, number> = {
  cmtstory: 0.096, // 화장품스토리 — 뷰티
}

export function feeRateFor(source?: string | null): number {
  return FEE_RATE_BY_SOURCE[source ?? ''] ?? FEE_RATE
}

/** 수수료 금액 = round(결제금액 × 요율) */
export function coupangFee(revenue: number, source?: string | null): number {
  return Math.round(revenue * feeRateFor(source))
}
