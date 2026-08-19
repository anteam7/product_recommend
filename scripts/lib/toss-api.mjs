/**
 * 토스쇼핑 셀러 Open API 클라이언트 (docs: https://shopping-docs.toss.im/dev , 정리: docs/plan-toss-shopping.md)
 *
 * - 인증: OAuth2 client_credentials → Bearer (실측 만료 3599s). 토큰은 프로세스 내 캐시, 만료 60s 전 갱신.
 * - base: https://shopping-fep.toss.im/api/v3/shopping-fep  (테스트: shopping-fep-alpha / oauth2-alpha.cert)
 * - 응답은 거의 항상 HTTP 200 + { resultType: 'SUCCESS'|'FAIL', success?, error?: { errorCode, reason } }.
 *   → tossApi()는 resultType 기준으로 { ok, status, data, error, raw } 를 돌려준다 (throw 안 함).
 * - 한도: 쓰기 30/s·읽기 50/s(등록 가이드는 등록/수정 10/s) → 호출 간 최소 간격 120ms 스로틀.
 * - env: TOSS_SHOPPING_ACCESS_KEY / TOSS_SHOPPING_SECRET_KEY (.env.local), TOSS_SHOPPING_ENV=alpha 면 테스트 환경
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          let v = l.slice(i + 1).trim()
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
          return [l.slice(0, i).trim(), v]
        }),
    )
  } catch { return {} }
}
const env = { ...loadEnv(), ...process.env }
const ALPHA = env.TOSS_SHOPPING_ENV === 'alpha'
export const TOSS_BASE = ALPHA ? 'https://shopping-fep-alpha.toss.im/api/v3/shopping-fep' : 'https://shopping-fep.toss.im/api/v3/shopping-fep'
const TOKEN_URL = ALPHA ? 'https://oauth2-alpha.cert.toss.im/token' : 'https://oauth2.cert.toss.im/token'
export const PARTNER_NAME = 'jimscanner-personal'

let tokenCache = { token: null, exp: 0 }
export async function tossToken(force = false) {
  const now = Date.now()
  if (!force && tokenCache.token && now < tokenCache.exp - 60_000) return tokenCache.token
  const id = env.TOSS_SHOPPING_ACCESS_KEY, secret = env.TOSS_SHOPPING_SECRET_KEY
  if (!id || !secret) throw new Error('TOSS_SHOPPING_ACCESS_KEY / TOSS_SHOPPING_SECRET_KEY 가 .env.local 에 없습니다')
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=UTF-8' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'toss-shopping-fep:write' }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error(`토스 토큰 발급 실패 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)} (IP 허용목록 확인)`)
  tokenCache = { token: j.access_token, exp: now + (Number(j.expires_in) || 3599) * 1000 }
  return tokenCache.token
}

let lastCall = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function throttle(minGapMs = 120) {
  const wait = lastCall + minGapMs - Date.now()
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()
}

/**
 * tossApi('GET', '/products/categories/children', { query: { id: 50995 } })
 * tossApi('POST', '/products/v2', { body: {...}, timeoutMs: 120000 })
 * → { ok, status, data(success), error({errorCode, reason}), raw }
 */
export async function tossApi(method, urlPath, { query, body, timeoutMs = 60_000, retry401 = true } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString() : ''
  await throttle()
  const token = await tossToken()
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs)
  let res, text
  try {
    res = await fetch(`${TOSS_BASE}${urlPath}${qs}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    text = await res.text()
  } catch (e) {
    clearTimeout(t)
    return { ok: false, status: 0, data: null, error: { errorCode: 'NETWORK', reason: e.message }, raw: null }
  }
  clearTimeout(t)
  if (res.status === 401 && retry401) { await tossToken(true); return tossApi(method, urlPath, { query, body, timeoutMs, retry401: false }) }
  let j = null; try { j = JSON.parse(text) } catch { /* non-json */ }
  const ok = res.ok && j && j.resultType === 'SUCCESS'
  return {
    ok,
    status: res.status,
    data: j?.success ?? null,
    error: ok ? null : (j?.error ?? { errorCode: `HTTP_${res.status}`, reason: (text || '').slice(0, 300) }),
    raw: j ?? text,
  }
}

// ── 편의 함수 ──
export const tossCategoryChildren = (id) => tossApi('GET', '/products/categories/children', { query: { id } })
export const tossConstraintTemplate = (categoryId) => tossApi('GET', `/category/${categoryId}/constraint-templates`)
export const tossNotices = (categoryCode) => tossApi('GET', '/notices', { query: { categoryCode } })
export const tossProduct = (productId) => tossApi('GET', `/products/${productId}/v2`)
export const tossProducts = (query) => tossApi('GET', '/products/v2', { query })
export const tossRegisterProduct = (payload) => tossApi('POST', '/products/v2', { body: { ...payload, partnerName: payload.partnerName ?? PARTNER_NAME }, timeoutMs: 30 * 60_000 }) // 이미지 다운로드 포함 최대 30분
export const tossHideProduct = (productId) => tossApi('POST', '/products/hide', { body: { productId } })
export const tossShowProduct = (productId) => tossApi('POST', '/products/show', { body: { productId } })
export const tossRemoveProduct = (productId) => tossApi('POST', '/products/remove', { body: { productId } })
export const tossSetSalePrice = (productId, productItemId, salePrice) => tossApi('PUT', `/product-items/${productItemId}/sale-price`, { body: { productId, salePrice } })
export const tossSetOriginPrice = (productId, productItemId, originPrice) => tossApi('PUT', `/product-items/${productItemId}/origin-price`, { body: { productId, originPrice } })
export const tossSetStock = (productId, productItemId, remainingCount) => tossApi('PUT', `/product-items/${productItemId}/stocks/normal-stock/remaining-count`, { body: { productId, remainingCount } })
export const tossOrders = (query) => tossApi('GET', '/orders/v2', { query })
export const tossOrderProduct = (orderProductId) => tossApi('GET', `/orders/products/${orderProductId}`)
export const tossSetOrderStatus = (body) => tossApi('PUT', '/orders/products/status', { body })
export const tossSetDelivery = (orderProductId, deliveryCompany, trackingNumber) => tossApi('PUT', '/orders/products/delivery', { body: { orderProductId, deliveryCompany, trackingNumber } })
export const tossClaims = (query) => tossApi('GET', '/claims', { query })
export const tossExchangeRefundLocations = () => tossApi('GET', '/merchants/group-delivery/exchange-refund-location/v2')
export const tossDeliveryLocations = () => tossApi('GET', '/merchants/group-delivery/delivery-location/v2')
export const tossDeliveryCompanies = () => tossApi('GET', '/delivery-companies')

/** 카테고리 트리에서 leaf 찾기 — names: ['식품','건강식품',...] 경로 또는 leaf 이름 1개(서브트리 탐색) */
export async function tossFindLeaf(rootId, leafName, maxDepth = 5) {
  const stack = [{ id: rootId, depth: 0 }]
  while (stack.length) {
    const { id, depth } = stack.pop()
    const r = await tossCategoryChildren(id)
    for (const c of r.data?.items ?? []) {
      if (c.isLeaf && c.name === leafName) return c
      if (!c.isLeaf && depth < maxDepth) stack.push({ id: c.id, depth: depth + 1 })
    }
  }
  return null
}
