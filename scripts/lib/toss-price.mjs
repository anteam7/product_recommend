/**
 * 토스쇼핑 등록가 — 쿠팡 판매가에 수수료 차이를 보정해 같은 순이익이 나오게 한다 (2026-10-13 사용자 요청).
 *
 *   순이익 = 가격 − 매입원가 − 수수료(요율×가격) − 납부부가세((가격−매입원가)÷11)   (src/lib/margin.ts 와 동일)
 *   매입원가는 마켓 무관이므로 가격에 비례하는 항만 맞추면 된다:
 *   P_t × (1 − f_t − 1/11) = P_c × (1 − f_c − 1/11)  →  P_t = P_c × (1 − f_c − 1/11) / (1 − f_t − 1/11)
 *   f_c = 쿠팡 수수료(매입처별, src/lib/coupang/fee.ts), f_t = 토스 11% (src/lib/toss/fee.ts). 기본 10.6% → 11% 는 약 +0.5%.
 *   결과는 10원 단위 올림. MSP 는 호출측이 별도 검사(쿠팡가가 이미 MSP 이상이고 보정은 인상이라 위반 불가).
 *
 * ⚠ 상수는 TS 쪽(src/lib/coupang/fee.ts, src/lib/toss/fee.ts)과 수동 동기화 — .mjs 는 TS 를 import 못 한다.
 */
export const TOSS_FEE_RATE = 0.11 // 판매 8% + 결제 3%
export const COUPANG_FEE_RATE = 0.106 // 기타 영양제 기본
export const COUPANG_FEE_BY_SOURCE = { cmtstory: 0.096 } // 화장품스토리 = 뷰티
const VAT = 1 / 11

export const coupangFeeRateFor = (source) => COUPANG_FEE_BY_SOURCE[source ?? ''] ?? COUPANG_FEE_RATE

/** 쿠팡 판매가 → 같은 순이익이 나오는 토스 판매가(10원 올림). 잘못된 입력은 그대로 돌려준다. */
export function tossPriceFromCoupang(coupangPrice, source) {
  const p = Number(coupangPrice)
  if (!Number.isFinite(p) || p <= 0) return coupangPrice
  const fc = coupangFeeRateFor(source)
  const ratio = (1 - fc - VAT) / (1 - TOSS_FEE_RATE - VAT)
  return Math.ceil((p * ratio) / 10) * 10
}

/** 보정 배율(로그·설명용) */
export const tossPriceRatio = (source) => (1 - coupangFeeRateFor(source) - VAT) / (1 - TOSS_FEE_RATE - VAT)
