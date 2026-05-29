import crypto from 'node:crypto'

/**
 * 쿠팡 Open API 서버 전용 클라이언트 (HMAC-SHA256).
 * COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY / COUPANG_API_HOST 환경변수 사용.
 * 관리자 라우트·크론에서만 사용 (서버 전용).
 */
const HOST = process.env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'

function sign(method: string, urlPath: string, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const secret = process.env.COUPANG_SECRET_KEY!
  // 쿼리가 있으면 서명에도 포함해야 함 (쿠팡 규약)
  const signature = crypto.createHmac('sha256', secret).update(dt + method + urlPath + (query || '')).digest('hex')
  return { datetime: dt, signature }
}

export async function coupangApi(method: string, urlPath: string, body: unknown = null, query = '') {
  const { datetime, signature } = sign(method, urlPath, query)
  const access = process.env.COUPANG_ACCESS_KEY!
  const res = await fetch(`${HOST}${urlPath}${query ? '?' + query : ''}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { status: res.status, body: text as unknown }
  }
}

/** sellerProductId → 그 상품의 vendorItemId 목록 */
export async function getVendorItemIds(sellerProductId: number): Promise<number[]> {
  const d = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)
  const data = (d.body as { data?: { items?: Array<{ vendorItemId?: number }> } })?.data
  return (data?.items ?? []).map((i) => i.vendorItemId).filter((x): x is number => typeof x === 'number')
}

function isSuccess(body: unknown): boolean {
  const code = (body as { code?: unknown })?.code
  return code === 'SUCCESS' || code === 200 || code === '200'
}

/**
 * vendor-item 판매가 변경: PUT /vendor-items/{vendorItemId}/prices/{price}
 * forceSalePriceAddUp=true → 판매가가 정가(originalPrice)보다 높아질 때 정가를 자동 상향(인상 허용).
 * MSP 검증은 호출 측에서.
 */
export async function changeVendorItemPrice(vendorItemId: number, price: number, forceAddUp = true) {
  const query = forceAddUp ? 'forceSalePriceAddUp=true' : ''
  const r = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/prices/${price}`, null, query)
  return { ok: r.status === 200 && isSuccess(r.body), status: r.status, body: r.body }
}

/**
 * sellerProductId의 모든 vendor-item 판매가를 price로 변경.
 * 하나라도 실패하면 ok=false.
 */
export async function changeProductPrice(sellerProductId: number, price: number) {
  const vendorItemIds = await getVendorItemIds(sellerProductId)
  if (vendorItemIds.length === 0) return { ok: false, reason: 'no_vendor_item', results: [] }
  const results: Array<{ vendorItemId: number; ok: boolean; body: unknown }> = []
  for (const vid of vendorItemIds) {
    const r = await changeVendorItemPrice(vid, price)
    results.push({ vendorItemId: vid, ok: r.ok, body: r.body })
    await new Promise((s) => setTimeout(s, 200))
  }
  return { ok: results.every((r) => r.ok), reason: null, results }
}

// ─── 마진 계산 (모든 가격 경로의 단일 출처) ───
// FEE_RATE는 register/reprice/match 스크립트와 반드시 동일해야 함 (현재 0.13 = 카테고리 수수료 + 결제 수수료 근사).
// 스크립트는 .mjs라 이 상수를 import할 수 없으므로, 값 변경 시 scripts/coupang-{register-*,reprice-ship3000,match-manual}.mjs도 같이 맞출 것.
export const SHIP = 3000          // 위탁 dropship: 고객 출고 배송 1회분
export const FEE_RATE = 0.106     // 쿠팡 판매수수료 — 기타 영양제(73137) 카테고리 10.6% (결제비 포함). 카테고리 다르면 조정
export const VAT_DIVISOR = 11     // 부가세 = 판매가 / 11

export function computeMargin(listPrice: number, dome: number, shipping: number = SHIP) {
  const realCost = dome + shipping
  const fee = Math.round(listPrice * FEE_RATE)
  const vat = Math.round(listPrice / VAT_DIVISOR)
  const margin = listPrice - realCost - fee - vat
  return {
    realCost,
    fee,
    margin,
    marginPct: listPrice ? +((margin / listPrice) * 100).toFixed(2) : 0,
  }
}

// ─── 반품 버퍼 마진 (위탁 드롭십 손익 기대치) ───
// 위탁은 마진이 얇아 반품 1건이 정상 판매 수 건의 이익을 상쇄한다.
// return_risk_score(0~100) → 예상 반품률 → 회수불가 비용(왕복 배송 + 재고 손실)을
// 건당 기대 손실로 환산해 마진에서 차감, "반품 보정 후 기대 마진"을 구한다.
//
// 모델: expectedReturnRate = score/100 * MAX_RETURN_RATE
//       건당 반품 손실 = 왕복배송(2*SHIP) + 검수/재고폐기 손실(dome 의 RESTOCK_LOSS 비율)
//       반품버퍼 = expectedReturnRate * 건당손실  (정상판매 1건당 안분)
export const MAX_RETURN_RATE = 0.25   // score=100 → 반품률 25% 상한 가정 (의류 핏 최악 케이스)
export const RESTOCK_LOSS = 0.5       // 반품품 1건당 도매원가의 50%는 회수 불가(재판매 불가/감가)로 가정

export function computeMarginWithReturnBuffer(
  listPrice: number,
  dome: number,
  returnRiskScore: number,
  shipping: number = SHIP,
) {
  const base = computeMargin(listPrice, dome, shipping)
  const score = Math.max(0, Math.min(100, returnRiskScore || 0))
  const expectedReturnRate = (score / 100) * MAX_RETURN_RATE
  // 반품 1건당 회수불가 비용 = 왕복 배송 + 도매원가 일부 손실
  const lossPerReturn = shipping * 2 + Math.round(dome * RESTOCK_LOSS)
  // 정상 판매 1건에 안분되는 반품 버퍼(기대 손실)
  const returnBuffer = Math.round(expectedReturnRate * lossPerReturn)
  const adjustedMargin = base.margin - returnBuffer
  return {
    ...base,
    expectedReturnRate: +(expectedReturnRate * 100).toFixed(1), // %
    lossPerReturn,
    returnBuffer,
    adjustedMargin,
    adjustedMarginPct: listPrice ? +((adjustedMargin / listPrice) * 100).toFixed(2) : 0,
  }
}
