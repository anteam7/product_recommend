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

// ─── 필수 바닥가 (price-fit 게이트) ───
// margin >= targetMargin 을 만족하는 최소 판매가.
//   margin = list*(1 - FEE_RATE - 1/VAT_DIVISOR) - (dome+ship)
//   list  >= (dome+ship+targetMargin) / (1 - FEE_RATE - 1/VAT_DIVISOR)
// WTP 천장(수요측 지불의사 상한)과 겹쳐 '가격 헤드룸 = WTP천장 − 필수바닥가' 를 산출한다.
export function computeFloorPrice(dome: number, targetMargin = 0, shipping: number = SHIP): number {
  const variableRate = 1 - FEE_RATE - 1 / VAT_DIVISOR // 판매가 1원당 셀러에게 남는 비율 (배송·도매 제외 전)
  if (variableRate <= 0) return Infinity
  return Math.ceil((dome + shipping + targetMargin) / variableRate)
}

// WTP 천장 대비 헤드룸 — 음수면 '마진불가'(조기 킬), 넓으면 '가격결정력'.
export function computeHeadroom(wtpHigh: number | null, dome: number, targetMargin = 0, shipping: number = SHIP) {
  const floor = computeFloorPrice(dome, targetMargin, shipping)
  if (wtpHigh == null || !Number.isFinite(floor)) {
    return { floor, headroom: null as number | null, headroomPct: null as number | null, verdict: 'unknown' as const }
  }
  const headroom = wtpHigh - floor
  const headroomPct = wtpHigh > 0 ? +((headroom / wtpHigh) * 100).toFixed(1) : 0
  const verdict: 'kill' | 'tight' | 'power' = headroom < 0 ? 'kill' : headroomPct < 15 ? 'tight' : 'power'
  return { floor, headroom, headroomPct, verdict }
}
