import crypto from 'node:crypto'
import { SHIP, FEE_RATE } from './fee'
import { netVat } from '../margin'

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
// 상수는 fee.ts(수수료·배송, 클라이언트 안전) / margin.ts(부가세·실수익) 에 있고 여기서 재export.
// 스크립트는 .mjs라 import할 수 없으므로, 값 변경 시 scripts/coupang-{register-*,reprice-ship3000,match-manual}.mjs도 같이 맞출 것.
// 부가세(2026-10-13): 결제액÷11 → (결제액 − 매입원가)÷11 (매입세액 공제). 수수료는 매입처별(feeRateFor).
export { SHIP, FEE_RATE, FEE_RATE_BY_SOURCE, feeRateFor } from './fee'
export { VAT_DIVISOR } from '../margin'

export function computeMargin(listPrice: number, dome: number, shipping: number = SHIP, feeRate: number = FEE_RATE) {
  const realCost = dome + shipping
  const fee = Math.round(listPrice * feeRate)
  const vat = netVat(listPrice, realCost)
  const margin = listPrice - realCost - fee - vat
  return {
    realCost,
    fee,
    margin,
    marginPct: listPrice ? +((margin / listPrice) * 100).toFixed(2) : 0,
  }
}
