/**
 * 고도몰5 상용몰(건강산 ggsan.com · 화장품스토리 cmtstory.com) 카탈로그 공용 파서 — 로그인 · 카테고리 리스트 · 상세.
 *
 * 세션·로그인은 supplier-stock.mjs(makeSession · mallLogin)를 그대로 쓴다(두 몰 모두 /member/login_ps.php 평문 POST).
 * 상세·절대준수가 파서는 ggsan-prep-goods.mjs(extractDetail · extractRule)를 이식하되
 *   - 이미지 CDN 호스트를 고정하지 않는다: 건강산 = godomall-storage.cdn-nhncommerce.com, 화장품스토리 = godomall.speedycdn.net.
 *     상품 이미지는 경로 `/goods/{goodsNo}/`, 상세설명 이미지는 `/editor/goods/` 로만 판별한다.
 *   - 가격은 화면 텍스트가 아니라 hidden input(set_goods_price · set_goods_fixedPrice)에서 읽는다.
 *   - 품절은 구매영역 마커(btn_restock_box · btn_add_soldout)만 믿는다(supplier-stock.mjs mallCheckStock 과 같은 근거).
 *
 *   import { makeSession, mallLogin, listCategory, parseGoodsView } from './lib/godomall-catalog.mjs'
 *   const s = makeSession(); await mallLogin(s, { base, user, pass, label })
 *   const { items, total } = await listCategory(s, base, '001')          // Map(goodsNo → { soldout })
 *   const d = parseGoodsView(await (await s.fx(`${base}/goods/goods_view.php?goodsNo=${no}`)).text())
 */
import { makeSession, mallLogin } from './supplier-stock.mjs'
export { makeSession, mallLogin }

const sleep = ms => new Promise(s => setTimeout(s, ms))
const decodeEnt = s => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
export const htmlToText = h => decodeEnt((h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const toInt = s => { const n = Math.round(parseFloat(String(s ?? '').replace(/,/g, ''))); return Number.isFinite(n) ? n : null }

/**
 * 카테고리 리스트 전 페이지 → Map(goodsNo → { soldout }). 품절은 `<li class="item_soldout">`(화장품스토리 스킨) 또는
 * 품절 아이콘(alt="품절" · soldout 이미지) 둘 중 하나라도 있으면 true. 새 상품이 안 나오는 페이지에서 멈춘다.
 * total 은 "총 N 개" 표기(스킨에 따라 태그가 끼어 있음) — 수집 누락 검증용.
 */
export async function listCategory(session, base, cateCd, { maxPages = 60, delayMs = 250 } = {}) {
  const items = new Map()
  let total = null
  for (let page = 1; page <= maxPages; page++) {
    const r = await session.fx(`${base}/goods/goods_list.php?cateCd=${encodeURIComponent(cateCd)}&page=${page}`)
    if (!r.ok) break
    const html = await r.text()
    if (total == null) { const m = html.match(/총\s*(?:<[^>]+>\s*)*([\d,]+)\s*(?:<[^>]+>\s*)*개/); if (m) total = toInt(m[1]) }
    let fresh = 0
    for (const b of html.matchAll(/<li\b([^>]*)>\s*<div class="item_cont">([\s\S]*?)<\/li>/g)) {
      const no = b[2].match(/goodsNo=(\d+)/)?.[1]
      if (!no || items.has(no)) continue
      fresh++
      const soldout = /item_soldout/.test(b[1]) || /alt=["']품절["']|soldout/i.test(b[2])
      items.set(no, { soldout })
    }
    if (!fresh) break
    await sleep(delayMs)
  }
  return { items, total }
}

/** hidden input 값 — name/value 순서가 스킨마다 달라 둘 다 본다. */
function hidden(html, name) {
  const a = html.match(new RegExp(`name=["']${name}["'][^>]*?value=["']([^"']*)["']`))
  if (a) return a[1]
  const b = html.match(new RegExp(`value=["']([^"']*)["'][^>]*?name=["']${name}["']`))
  return b ? b[1] : null
}

/**
 * 상세 텍스트의 판매 규정 — 판매가격절대준수 하한 + 폐쇄몰/오픈마켓 금지 문구. (ggsan-prep-goods.mjs extractRule 이식)
 *   "판매가격절대준수 1개 20,000원 / 2개 38,000원 / 3개 54,000원 이상 판매 부탁드립니다." → tiered {1:20000,2:38000,3:54000}
 *   "판매가격절대준수 2,900원 이상 판매 부탁드립니다."                                      → text_min 2900, tiered null
 */
export function extractSalesRule(html) {
  const text = htmlToText(html)
  const closedMall = /폐쇄몰/.test(text) || /오픈\s*마켓[^.]{0,15}(금지|불가|제한)/.test(text)
  const cands = []
  for (const re of [/([\d,]{4,})\s*원\s*이상\s*판매\s*부탁/g, /절대\s*준수[^0-9]{0,15}(?:1개\s*)?([\d,]{4,})\s*원/g, /폐쇄몰[^0-9]{0,10}([\d,]{4,})\s*원\s*이상/g]) {
    let m; while ((m = re.exec(text))) { const n = toInt(m[1]); if (n >= 1000 && n <= 1000000) cands.push(n) }
  }
  const tiered = {}
  const seg = text.match(/(?:절대\s*준수|판매가격\s*절대준수)[^]{0,200}/)
  if (seg) for (const mm of seg[0].matchAll(/(\d+)\s*개\s*(?:묶음)?\s*([\d,]{4,})\s*원/g)) { const n = parseInt(mm[1]); const p = toInt(mm[2]); if (n >= 1 && n <= 12 && p >= 1000 && p <= 2000000) tiered[n] = p }
  const tieredCount = Object.keys(tiered).length
  // 수량별 표기가 있으면 1개가를 단품 하한으로(묶음 최고가를 단품 MSP 로 잡던 건강산 과거 버그 방지)
  const textMin = tieredCount >= 2 ? (tiered[1] || Math.min(...Object.values(tiered))) : (cands.length ? Math.max(...cands) : null)
  return { closed_mall: closedMall, text_min_price: textMin, tiered_msp: tieredCount > 1 ? tiered : null }
}

/** 배송비 안내 레이어 "0원 이상 ~ 200,000원 미만 <span>3,000원" / "200,000원 이상 <span>0원" → { fee, freeThreshold } */
function parseShipping(html) {
  let fee = null, freeThreshold = null
  for (const m of html.matchAll(/([\d,]+)\s*원\s*이상(?:\s*~\s*([\d,]+)\s*원\s*미만)?\s*<span[^>]*>\s*([\d,]+)\s*원/g)) {
    const from = toInt(m[1]), f = toInt(m[3])
    if (from === 0 && fee == null) fee = f
    if (f === 0 && from > 0 && (freeThreshold == null || from < freeThreshold)) freeThreshold = from
  }
  return { fee, freeThreshold }
}

/**
 * goods_view.php → 상품 필드. goodsNo 는 `var goodsNo = '…'` 에서(없으면 hidden).
 * 반환값의 키는 jimscanner_cmtstory_products 컬럼명과 맞춰 두었다(몰 공통 필드만).
 */
export function parseGoodsView(html) {
  const goods_no = html.match(/var\s+goodsNo\s*=\s*['"](\d+)/)?.[1] ?? hidden(html, 'goodsNo')
  const title = decodeEnt(html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/)?.[1] ?? '').trim() || null
  const thumb_url = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/)?.[1] ?? null
  const allUrls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'\\)<>]+\.(?:jpe?g|png|gif|webp)/gi)].map(m => m[0].replace(/[\\)>"']+$/, '')))]
  const mine = goods_no ? allUrls.filter(u => u.includes(`/goods/${goods_no}/`)) : []
  const big = mine.filter(u => /\/(big|magnify)\//.test(u) && !/thumb/.test(u))
  const images_main = big.length ? big : mine.filter(u => /\/image\/(main|detail|add\d+)\//.test(u) && !/\/(list|thumb|small)\//.test(u))
  const images_content = allUrls.filter(u => /\/editor\/goods\//i.test(u))
  const rule = extractSalesRule(html)
  const ship = parseShipping(html)
  const manufacturer = htmlToText(html.match(/<dt>\s*제조사\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? '') || null
  const expiry_date = html.match(/<th[^>]*>\s*사용기한\s*<\/th>\s*<td[^>]*>\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null
  return {
    goods_no,
    title,
    cate_cd: hidden(html, 'cateCd'),
    wholesale_price_krw: toInt(hidden(html, 'set_goods_price')),
    fixed_price_krw: toInt(hidden(html, 'set_goods_fixedPrice')),
    has_option: String(hidden(html, 'optionFl') ?? 'n').toLowerCase() === 'y',
    soldout: /btn_restock_box|btn_add_soldout/.test(html),
    purchasable: /id=["']cartBtn["']|class=["']btn_add_cart["']/.test(html),
    manufacturer,
    expiry_date,
    thumb_url,
    images_main,
    images_content,
    has_msp_text: rule.text_min_price != null,
    msp_price_krw: rule.tiered_msp?.[1] ?? rule.text_min_price ?? null,
    tiered_msp: rule.tiered_msp ?? (rule.text_min_price ? { 1: rule.text_min_price } : null),
    closed_mall: rule.closed_mall,
    shipping_fee_krw: ship.fee,
    free_ship_threshold_krw: ship.freeThreshold,
  }
}
