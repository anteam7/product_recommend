// 결제진행(order-server.mjs)이 purchase_note 에 남기는 결제 기록을 읽는다 — 행에서 "어디로 얼마를 보낼지"를 메모 원문 대신 보여주려고.
//   [가상계좌] 기업은행 00000000000000 (예금주 가상계좌예금주) 14,300원을 2026-09-18 까지 입금   (77바이오, 주문마다 새 번호)
//   [무통장] 우리은행 0000000000000 (예금주 (주)매입처) 3,000원 입금                                 (무통장 매입처 공통)
//   [적립금] 26,000원 사용                                                                         (캠핑문 적립금 먼저 — 남은 금액만 무통장, 2026-11-01)
//   [적립금] 11,311원 결제완료 · 잔액 85,874원                                                     (선충전 결제 — 도매아토즈 적립금·웰루트 예치금, '약' = 계산값)
// 메모는 ' / ' 로 이어 붙는다(매입처 변경 기록 등이 앞에 올 수 있음). 적립금을 쓴 주문은 매입 합계(purchase_total_cost)가 아니라
// [무통장] 금액이 실제 입금액이다 — 합계를 보고 이체하면 과입금된다(2026-11-01 캠핑문 29,000원 중 입금 3,000원).

export interface DepositTarget {
  kind: 'virtual' | 'cash'
  bank: string
  account: string
  holder: string | null
  amount: number
  deadline: string | null
}

/** 선충전 잔액으로 이미 결제된 주문 — 결제 후 남은 잔액을 행에서 보여 충전 시점을 알게(사장님 2026-11-01 "결제하고 남은 적립금") */
export interface PrepaidPayment {
  label: '적립금' | '예치금'
  paid: number
  balanceAfter: number | null
  /** 사이트에서 다시 읽은 값이 아니라 (결제 전 잔액 − 결제액) 계산값 */
  approx: boolean
}

export interface ParsedPurchaseNote {
  deposit: DepositTarget | null
  prepaid: PrepaidPayment | null
  /** 매입처 적립금 사용액 — 매입 합계 중 이체하지 않는 몫 */
  mileageUsed: number | null
  /** 결제 기록이 아닌 나머지 메모 조각 */
  rest: string[]
}

// 예금주에 괄호가 들어간다("(주)소리") → 금액 앞 닫는 괄호까지 최소 일치. 금액은 숫자로 시작(쉼표만이면 NaN)
const VIRTUAL_RE = /^\[가상계좌\]\s*(\S+)\s+([\d-]+)\s*(?:\(예금주\s*(.*?)\)\s*)?(\d[\d,]*)원을\s*(.*?)\s*(?:까지\s*)*입금/
const CASH_RE = /^\[무통장\]\s*(\S*)\s+([\d-]+)\s*(?:\(예금주\s*(.*?)\)\s*)?(\d[\d,]*)원\s*입금/
const MILEAGE_RE = /^\[적립금\]\s*(\d[\d,]*)원\s*사용/
const PREPAID_RE = /^\[(적립금|예치금)\]\s*(\d[\d,]*)원\s*결제완료(?:\s*·\s*잔액\s*(약\s*)?(\d[\d,]*)원)?/

const num = (s: string) => parseInt(s.replace(/,/g, ''), 10)

export function parsePurchaseNote(note: string | null | undefined): ParsedPurchaseNote {
  const out: ParsedPurchaseNote = { deposit: null, prepaid: null, mileageUsed: null, rest: [] }
  for (const part of (note ?? '').split(' / ').map((s) => s.trim()).filter(Boolean)) {
    const v = VIRTUAL_RE.exec(part)
    if (v) { out.deposit = { kind: 'virtual', bank: v[1], account: v[2], holder: v[3] || null, amount: num(v[4]), deadline: v[5] || null }; continue }
    const c = CASH_RE.exec(part)
    if (c) { out.deposit = { kind: 'cash', bank: c[1], account: c[2], holder: c[3] || null, amount: num(c[4]), deadline: null }; continue }
    const m = MILEAGE_RE.exec(part)
    if (m) { out.mileageUsed = num(m[1]); continue }
    const pp = PREPAID_RE.exec(part)
    if (pp) { out.prepaid = { label: pp[1] as PrepaidPayment['label'], paid: num(pp[2]), balanceAfter: pp[4] ? num(pp[4]) : null, approx: !!pp[3] }; continue }
    out.rest.push(part)
  }
  return out
}
