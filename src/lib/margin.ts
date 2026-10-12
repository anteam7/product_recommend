/**
 * 실수익(순마진) 공통 계산 — 마켓 무관, 서버·클라이언트 양쪽에서 import 가능(node 의존 없음).
 *
 * 부가세(2026-10-13 사용자 결정): 납부세액 = 매출세액 − 매입세액 = (결제금액 − 매입원가) ÷ 11.
 *   매입처(건강산·화장품스토리 등)가 세금계산서를 발행하는 일반과세 전제. 매입가·배송비는 부가세 포함가.
 *   마켓 수수료에 붙는 부가세도 매입세액 공제되므로 수수료는 요율(VAT 별도)만 비용으로 본다.
 *   매입원가 미입력(null)이면 0으로 보아 부가세가 결제액÷11 로 과대 → 호출측에서 costMissing 경고.
 */
export const VAT_DIVISOR = 11

/** 납부 부가세 = max(0, (결제금액 − 매입원가) ÷ 11). 매입이 매출보다 크면 환급이지만 여기선 0으로 본다. */
export function netVat(revenue: number, cost: number | null | undefined): number {
  const c = cost ?? 0
  return Math.max(0, Math.round((revenue - c) / VAT_DIVISOR))
}

export interface NetProfit {
  revenue: number
  cost: number
  fee: number
  vat: number
  net: number
  /** net / revenue × 100, revenue 0이면 0 */
  netPct: number
}

/** 실수익 = 결제금액 − 매입원가 − 수수료(금액) − 납부부가세 */
export function netProfit(revenue: number, cost: number | null | undefined, fee: number): NetProfit {
  const c = cost ?? 0
  const vat = netVat(revenue, c)
  const net = revenue - c - fee - vat
  return { revenue, cost: c, fee, vat, net, netPct: revenue > 0 ? +((net / revenue) * 100).toFixed(2) : 0 }
}
