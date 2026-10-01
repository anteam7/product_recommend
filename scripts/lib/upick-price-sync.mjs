/**
 * 유픽 매입가·최저판매가(MSP) 변동 → 쿠팡·네이버 판매가 반영 공용 모듈.
 *   · CLI  : scripts/upickb2b-coupang-reprice.mjs (쿠팡 전체 점검·수동 반영)
 *   · 크론 : scripts/local-cron-stock-sync.mjs (매시 재고싱크 때 유픽 가격 반영 + 네이버 재고·가격)
 *
 * 목표가 = upickb2b-register.mjs computePrice 와 동일: max(MSP, 손익분기) 100원 올림, MSP 없으면 목표 순마진 10%.
 * 네이버 판매가는 등록 시 쿠팡가와 같게 잡았으므로(naver-register.mjs) 같은 목표가를 쓴다.
 *
 * 정책(2026-10-01 사용자 결정): **인상만 자동**(MSP 위반·손익분기 미달). 인하는 하지 않는다.
 * 공급사가 오픈마켓 판매금지로 바꾼 상품(BANNED)은 가격을 건드리지 않고 보고만 한다.
 * 판매중 쿠팡 상품 가격은 vendor-item 가격 API 로만 바꾼다(full PUT 은 임시저장 강등).
 */
import crypto from 'node:crypto'
import { fetchUpickDetail, saveUpickProduct } from './upick-catalog.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 가격 (upickb2b-register.mjs computePrice 와 동기화) ──
export const OUTBOUND_SHIP = 3000, FEE_RATE = 0.106, TARGET_NET = 0.10
export const priceForNet = (cost, m) => Math.ceil((0.9091 * cost / (0.8031 - m)) / 100) * 100
export function targetPrice(dome, msp) {
  const realCost = dome + OUTBOUND_SHIP
  const breakeven = priceForNet(realCost, 0)
  const p = msp > 0 ? Math.max(msp, breakeven) : priceForNet(realCost, TARGET_NET)
  return Math.ceil(p / 100) * 100
}
/** 인상 하한: MSP 있으면 목표가(=max(MSP,손익분기)), 자율판매는 손익분기 — 흑자인 자율판매가는 건드리지 않는다. */
export const raiseFloor = (dome, msp) => (msp > 0 ? targetPrice(dome, msp) : priceForNet(dome + OUTBOUND_SHIP, 0))
export function marginAt(price, dome) {
  const spread = price - (dome + OUTBOUND_SHIP)
  const fee = Math.round(price * FEE_RATE)
  const margin = spread - fee - Math.max(0, Math.round(spread / 11))
  return { fee, margin, pct: +(margin / price * 100).toFixed(2) }
}
/** (수동 리스팅용) 옵션명의 "N박스/N통/N세트/N병"(우선) 또는 "N개"(개입 제외) → 묶음 수량. 예: "90정 1박스"·"1박스 30정"·"1개 15g" → 1. */
export function packQty(itemName) {
  const s = String(itemName || '')
  const m = s.match(/(\d+)\s*(?:박스|세트|통|병)/) || s.match(/(\d+)\s*개(?!입)/)
  return m ? parseInt(m[1]) : null
}
/** 유픽 판매정책상 오픈마켓(쿠팡·네이버) 판매 불가 여부. coupang_allowed 는 쿠팡 전용 금지까지 섞여 있어 네이버엔 이걸 쓴다. */
export function openMarketBanned(p) {
  const plat = p.sellable_platforms || '', blob = `${plat} ${p.sale_policy || ''}`
  // 플랫폼 칸의 "폐쇄몰"(단독 표기 포함)은 금지 신호. 판매정책 본문엔 "폐쇄몰 최저판매가" 류 안내가 흔해 "폐쇄몰 전용"만 본다.
  return /폐쇄몰|오프라인\s*전용/.test(plat) || /폐쇄몰\s*전용/.test(blob) ||
    /오픈\s*마켓[^./]{0,15}(금지|불가|제한|제외)/.test(blob) || /(네이버|스마트\s*스토어)[^./]{0,12}(금지|불가|제외)/.test(blob)
}

// ── 쿠팡 API (HMAC — 쿼리도 서명에 포함) ──
export function coupangClient({ host, accessKey, secretKey }) {
  if (!accessKey || !secretKey) throw new Error('COUPANG_ACCESS_KEY/SECRET_KEY 없음(.env.local)')
  return async (method, urlPath, query = '') => {
    const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
    const sig = crypto.createHmac('sha256', secretKey).update(dt + method + urlPath + query).digest('hex')
    const res = await fetch(`${host}${urlPath}${query ? '?' + query : ''}`, {
      method,
      headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' },
    })
    const t = await res.text()
    try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
  }
}
const apiSuccess = (r) => r.status === 200 && ['SUCCESS', 200, '200'].includes(r.body?.code)

/**
 * 쿠팡 유픽 리스팅 1건: 라이브가 조회 → 분류 → (apply) 인상 + DB 매입가·MSP·마진 최신화.
 * @param l  jimscanner_coupang_listings 행 (id, seller_product_id, source_goods_no, status, dome_price_krw, msp_price_krw, reg_name)
 * @param p  jimscanner_upickb2b_products 행 (member_price_krw, min_sell_price_krw, tiered_msp, coupang_allowed, sellable_platforms, title)
 * @returns {{kind:'RAISE'|'LOWER'|'OK'|'BANNED'|'REVIEW'|'ERROR', why?, live?, target?, dome?, msp?, oldDome?, oldMsp?, mNow?, mNew?, done?, err?}}
 */
export async function repriceCoupangListing(api, sb, l, p, { apply = false, lower = false } = {}) {
  // 공급사가 오픈마켓·쿠팡 판매를 막은 상품 — 가격이 아니라 판매중지 대상이다(가격·DB 건드리지 않음)
  if (p.coupang_allowed === false) return { kind: 'BANNED', why: `유픽 "${p.sellable_platforms || '판매정책 변경'}" (현재명 ${p.title})` }
  const dome = p.member_price_krw || 0, msp = p.min_sell_price_krw || 0
  if (!dome) return { kind: 'REVIEW', why: '매입가 파싱 실패' }
  // MSP 가 있다가 사라지면 파싱 누락·정책 변경일 수 있다 — MSP 를 0 으로 덮으면 MSP 가드가 무력화되므로 사람 확인
  if (!msp && l.msp_price_krw > 0) return { kind: 'REVIEW', why: `MSP ${l.msp_price_krw}→없음 (유픽 상세 확인 필요)` }

  const d = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${l.seller_product_id}`)
  await sleep(150)
  const items = d.body?.data?.items
  if (!items?.length) return { kind: 'ERROR', why: `GET ${d.status} ${JSON.stringify(d.body).slice(0, 80)}` }
  if (items.length > 1) return { kind: 'REVIEW', why: `옵션 ${items.length}개` }
  const it = items[0], live = it.salePrice, vid = it.vendorItemId
  // 등록기(upickb2b-register)로 올린 리스팅은 항상 유픽 1단위다 — 옵션명은 구매옵션 표기("90개"=총 낱개 수)라 묶음 신호가 아니다.
  // 수동 등록·매칭 리스팅만 옵션명에서 묶음 수량을 읽는다.
  const qty = l.reg_name ? 1 : packQty(it.itemName)
  if (qty == null) return { kind: 'REVIEW', why: `수량 파싱 불가(옵션명 "${it.itemName}")`, live }
  if (qty > 1) {
    const floor = p.tiered_msp?.[qty] ?? msp * qty
    return { kind: 'REVIEW', why: `${qty}개 묶음 — 목표 ${targetPrice(dome * qty, floor)} (MSP ${floor})`, live }
  }
  const target = targetPrice(dome, msp)
  const kind = live < raiseFloor(dome, msp) ? 'RAISE' : live > target ? 'LOWER' : 'OK'
  const row = { kind, dome, msp, live, target, vid, oldDome: l.dome_price_krw, oldMsp: l.msp_price_krw, mNow: marginAt(live, dome).margin, mNew: marginAt(target, dome).margin }
  if (!apply) return row

  const changePrice = kind === 'RAISE' || (kind === 'LOWER' && lower)
  const finalPrice = changePrice ? target : live
  if (changePrice) {
    if (!vid) return { ...row, err: 'vendorItemId 없음' }
    if (msp > 0 && finalPrice < msp) return { ...row, err: 'MSP 미만 차단' }  // price_msp_floor_policy
    const rp = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/prices/${finalPrice}`, 'forceSalePriceAddUp=true')
    await sleep(400)
    if (!apiSuccess(rp)) return { ...row, err: JSON.stringify(rp.body).slice(0, 140) }
    row.done = true
  }
  const m = marginAt(finalPrice, dome)
  const { error } = await sb.from('jimscanner_coupang_listings').update({
    dome_price_krw: dome, msp_price_krw: msp, list_price_krw: finalPrice,   // msp_price_krw NOT NULL — 자율판매는 0
    estimated_fee_krw: m.fee, estimated_margin_krw: m.margin, estimated_margin_pct: m.pct, last_synced_at: new Date().toISOString(),
  }).eq('id', l.id)
  if (error) row.err = `DB ${error.message}`
  return row
}

// ── 네이버 ──
/** 스토어 전체 상품의 채널상품(가격·재고·상태) — /v1/products/search 는 번호 필터를 무시하므로 전량 페이지 조회. */
export async function fetchNaverChannelProducts(naverApi) {
  const map = new Map()
  for (let page = 1; page <= 20; page++) {
    const r = await naverApi('POST', '/v1/products/search', { page, size: 500 })
    if (r.status !== 200) throw new Error(`네이버 상품목록 ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`)
    const c = r.body?.contents || []
    for (const x of c) { const ch = x.channelProducts?.[0]; if (ch) map.set(Number(x.originProductNo), ch) }
    if (c.length < 500) break
    await sleep(300)
  }
  return map
}

/**
 * 네이버 유픽 리스팅 1건: 재고(유픽 품절↔판매) + 가격(인상만) 판정 → (apply) GET→수정→PUT 한 번에 반영.
 *   stock: 'in_stock'|'sold_out'|'unknown'|undefined (재고싱크의 유픽 재고맵)
 *   재고: 품절&판매중 → 수량0(OUTOFSTOCK) / 재입고&OUTOFSTOCK → 판매+수량 / 판매중&수량<minQty → 보충
 *   사람이 내린 판매중지(SUSPENSION)는 건드리지 않는다.
 * @returns {{price:'RAISE'|'LOWER'|'OK'|'BANNED'|'REVIEW'|'SKIP', stock:'soldout'|'restock'|'refill'|null, why?, live?, target?, done?, err?}}
 */
export async function syncNaverUpickListing(naverApi, sb, nl, ch, p, stock, { apply = false, minQty = 3, targetQty = 10 } = {}) {
  if (!ch) return { price: 'SKIP', stock: null, why: '네이버 목록에 없음(삭제?)' }
  if (ch.statusType === 'SUSPENSION') return { price: 'SKIP', stock: null, why: '판매중지(수동) — 건드리지 않음' }
  const res = { price: 'OK', stock: null, live: ch.discountedPrice ?? ch.salePrice }

  // 가격 — 인상만
  let newPrice = null
  if (!p) res.price = 'SKIP'
  else if (openMarketBanned(p)) { res.price = 'BANNED'; res.why = `유픽 "${p.sellable_platforms || ''}"` }
  else if (!p.member_price_krw) { res.price = 'REVIEW'; res.why = '매입가 없음' }
  else {
    const dome = p.member_price_krw, msp = p.min_sell_price_krw || 0
    res.target = targetPrice(dome, msp)
    if (ch.discountedPrice != null && ch.discountedPrice !== ch.salePrice) { res.price = 'REVIEW'; res.why = `즉시할인 적용 중(${ch.salePrice}→${ch.discountedPrice})` }
    else if (ch.salePrice < raiseFloor(dome, msp)) { res.price = 'RAISE'; newPrice = res.target }
    else if (ch.salePrice > res.target) res.price = 'LOWER'
  }

  // 재고 — 매입처 신호가 확실할 때만(unknown 은 아무것도 안 함)
  let newQty = null, newStatus = null
  if (stock === 'sold_out' && ch.statusType === 'SALE' && ch.stockQuantity > 0) { res.stock = 'soldout'; newQty = 0 }
  else if (stock === 'in_stock' && ch.statusType === 'OUTOFSTOCK') { res.stock = 'restock'; newQty = targetQty; newStatus = 'SALE' }
  else if (stock === 'in_stock' && ch.statusType === 'SALE' && ch.stockQuantity < minQty) { res.stock = 'refill'; newQty = targetQty }

  if (!apply || (newPrice == null && newQty == null)) return res
  const g = await naverApi('GET', `/v2/products/origin-products/${nl.origin_product_no}`)
  if (g.status !== 200 || !g.body?.originProduct) return { ...res, err: `GET ${g.status} ${JSON.stringify(g.body).slice(0, 120)}` }
  const prod = g.body
  if (newPrice != null) prod.originProduct.salePrice = newPrice
  if (newQty != null) prod.originProduct.stockQuantity = newQty
  if (newStatus) prod.originProduct.statusType = newStatus
  const u = await naverApi('PUT', `/v2/products/origin-products/${nl.origin_product_no}`, prod)
  await sleep(300)
  if (u.status !== 200) return { ...res, err: `PUT ${u.status} ${JSON.stringify(u.body?.invalidInputs || u.body?.message || u.body).slice(0, 160)}` }
  res.done = true
  const patch = {}
  if (newPrice != null) patch.sale_price = newPrice
  if (newQty === 0) patch.status_type = 'OUTOFSTOCK'
  else if (newStatus) patch.status_type = newStatus
  if (Object.keys(patch).length) {
    const { error } = await sb.from('jimscanner_naver_listings').update(patch).eq('origin_product_no', nl.origin_product_no)
    if (error) res.err = `DB ${error.message}`
  }
  return res
}

// ── 유픽 카탈로그 갱신(크론용) ──
const normText = (s) => String(s || '').replace(/\s+/g, '')
/**
 * 판매 중인 유픽 상품의 상세(매입가·MSP·판매정책)를 다시 읽는다.
 *   ① 목록 스캔 회원가(ec-data-price)·판매가능플랫폼이 DB 와 다른 상품 — 즉시
 *   ② 나머지는 last_seen_at 오래된 순으로 rolling 개 — MSP 만 바뀌는 경우 대비
 * @param meta  cafe24BuildStockMap 의 meta (product_no → {price, platforms})
 * @returns {{refreshed:number, changed:string[], failed:string[]}}
 */
export async function refreshUpickCatalog(session, base, sb, nos, meta, { rolling = 40, staleHours = 12, max = 150 } = {}) {
  const products = await loadUpickProducts(sb, nos)
  const urgent = [], idle = []
  for (const no of nos) {
    const p = products.get(no), m = meta?.get(no)
    // 목록 스캔에 없음 = 유픽에서 삭제·비공개(상세도 안 열림) → 재조회해도 실패만 반복하고 rolling 앞자리를 막는다
    if (!m) continue
    if (!p) { urgent.push(no); continue }
    if (m.price != null && m.price !== p.member_price_krw) { urgent.push(no); continue }
    if (m.platforms && normText(m.platforms) !== normText(p.sellable_platforms)) { urgent.push(no); continue }
    idle.push(p)
  }
  const staleBefore = Date.now() - staleHours * 3600e3
  const roll = idle.filter((p) => !p.last_seen_at || Date.parse(p.last_seen_at) < staleBefore)
    .sort((a, b) => Date.parse(a.last_seen_at || 0) - Date.parse(b.last_seen_at || 0)).slice(0, rolling).map((p) => p.product_no)
  const targets = [...urgent, ...roll].slice(0, max)
  const changed = [], failed = []
  for (const no of targets) {
    try {
      const d = await fetchUpickDetail(session.fx, base, no)
      if (!d?.title) { failed.push(no); continue }   // 삭제·비공개 상품은 상세가 안 열린다
      if (await saveUpickProduct(sb, d)) changed.push(no)
    } catch { failed.push(no) }
    await sleep(300)
  }
  return { refreshed: targets.length, urgent: urgent.length, changed, failed }
}

export async function loadUpickProducts(sb, nos) {
  const map = new Map()
  const list = [...new Set(nos)].filter(Boolean)
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await sb.from('jimscanner_upickb2b_products')
      .select('product_no, title, member_price_krw, min_sell_price_krw, tiered_msp, last_seen_at, coupang_allowed, sellable_platforms, sale_policy')
      .in('product_no', list.slice(i, i + 200))
    if (error) throw new Error(`upick 조회 실패: ${error.message}`)
    for (const p of data) map.set(p.product_no, p)
  }
  return map
}
