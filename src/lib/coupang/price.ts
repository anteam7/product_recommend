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

// 위탁 셀러가 손해 안 보고 들어갈 수 있는 쿠팡 최소 판매가(바닥가).
// computeMargin 을 거꾸로 푼 것: margin = list*(1 - FEE - 1/11) - (dome+ship) 에서
// margin 이 list 의 minMarginPct 이상이 되는 가장 낮은 list 를 구함.
//   list*(1 - FEE - 1/11 - minMarginPct) = dome + ship
// 이 floor 가 '직구 덤핑 위협 게이트'의 비교 기준(내 바닥가)이다.
export const MIN_MARGIN_PCT = 0.1 // 위탁 운영 최소 마진율 (판매가 대비)

export function computeViableFloor(
  dome: number,
  shipping: number = SHIP,
  minMarginPct: number = MIN_MARGIN_PCT,
): number | null {
  const denom = 1 - FEE_RATE - 1 / VAT_DIVISOR - minMarginPct
  if (denom <= 0) return null
  return Math.ceil((dome + shipping) / denom)
}
