/**
 * 유픽B2B(Cafe24) 상품 상세 파싱·저장 공용 모듈 — 수집기(upickb2b-collect.mjs)와 재고싱크 크론(가격반영)이 같이 쓴다.
 *   fetchUpickDetail(fx, base, productNo) → 회원가(매입가)·최저판매가(단품/수량별)·판매가능플랫폼·이미지 등
 *   saveUpickProduct(sb, d)               → content_hash 로 변동만 last_changed_at 갱신
 * fx 는 로그인된 세션의 fetch (supplier-stock makeSession + cafe24Login). 회원가는 로그인해야 보인다.
 */
import crypto from 'node:crypto'

const decodeEnt = s => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
const stripTags = s => decodeEnt((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const won = s => { const m = (s || '').match(/([\d,]{3,})\s*원/); return m ? parseInt(m[1].replace(/,/g, '')) : null }
function parseMsp(s) {
  if (!s) return { single: null, tiered: null }
  const tiered = {}
  for (const m of s.matchAll(/(\d+)\s*개[^\d]{0,6}([\d,]{4,})\s*원/g)) { const n = parseInt(m[1]); const p = parseInt(m[2].replace(/,/g, '')); if (n >= 1 && n <= 99 && p >= 1000 && p <= 3000000) tiered[n] = p }
  const keys = Object.keys(tiered)
  if (keys.length) return { single: tiered[1] ?? Math.min(...Object.values(tiered)), tiered: keys.length > 1 ? tiered : null }
  return { single: won(s), tiered: null }
}
// 최저판매가: 라벨이 "최저판매가" / "오픈마켓 최저판매가" 등으로 다양 → 모든 최저판매가 라벨 스캔, 최댓값(=floor) 채택.
function extractMsp(info) {
  // 오픈마켓 MSP만 사용 ("최저판매가"/"오픈마켓 최저판매가"). 폐쇄몰 최저판매가는 오픈마켓 floor 아님 → 제외.
  const keys = Object.keys(info).filter((k) => /최저\s*판매\s*가/.test(k) && !/폐쇄몰/.test(k))
  let single = null, tiered = null
  for (const k of keys) { const m = parseMsp(info[k]); if (m.single && (single == null || m.single > single)) single = m.single; if (m.tiered && !tiered) tiered = m.tiered }
  return { single, tiered }
}

function infoTable(html) {
  const map = {}
  for (const m of html.matchAll(/<tr[^>]*class="[^"]*xans-record-[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const th = stripTags((m[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) || [])[1])
    const td = stripTags((m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1])
    if (th && td && th.length < 30 && !(th in map)) map[th] = td
  }
  return map
}
function parseOptions(html) {
  const opts = []
  for (const sel of html.matchAll(/<select[^>]+(?:id|name)=["'][^"']*option[^"']*["'][\s\S]*?<\/select>/gi)) {
    const names = [...sel[0].matchAll(/<option[^>]*value=["'][^"'*]+["'][^>]*>([^<]+)<\/option>/g)].map(o => o[1].trim()).filter(t => t && !/^(필수|선택|옵션|=+|-{2,}|\.{2,}|\*)/.test(t))
    if (names.length) opts.push(names)
  }
  return opts
}
function deriveEligibility(platforms, policy, title) {
  const plat = platforms || ''
  const blob = `${plat} ${policy || ''} ${title || ''}`
  // 오픈마켓(쿠팡 포함) 판매 불가 신호 — 폐쇄몰/오프라인 전용/오픈마켓 금지 (ggsan extractRule 과 동일 취지)
  const openMarketBlocked = /폐쇄몰/.test(blob) || /오프라인\s*전용/.test(blob) || /오픈\s*마켓[^./]{0,15}(금지|불가|제한|제외)/.test(blob)
  // "쿠팡 아이템위너 매칭 금지"는 판매금지가 아니라 카탈로그 매칭만 금지 → 쿠팡 판매 가능
  const itemWinnerOnly = /아이템\s*위너|아이템위너|위너\s*매칭/.test(blob)
  const coupangBlocked = openMarketBlocked || ((/쿠팡[^./]{0,12}(금지|불가|제외)/.test(blob) || /쿠팡\s*판매\s*금지/.test(blob)) && !itemWinnerOnly)
  const rest = plat.replace(/모든\s*마켓\s*판매\s*가능/, '')
  const allMarkets = /모든\s*마켓\s*판매\s*가능/.test(plat) && !coupangBlocked && !/금지|불가|제외|제한|전용|만\s*가능/.test(rest)
  return { coupang_allowed: !coupangBlocked, all_markets_ok: allMarkets }
}

// 상세설명 이미지: #prdDetail 영역 콘텐츠 이미지(호스트 무관). 상대경로는 og:image 호스트로 해석(외부호스트 상세 대응). 스킨/아이콘/갤러리/카테고리로고 제외.
function detailImages(html, ogImage, base) {
  const ogHost = ogImage && /^https?:\/\//.test(ogImage) ? ogImage.match(/^https?:\/\/[^/]+/)[0] : base
  const start = html.search(/id=["']prdDetail["']/)
  let region = html
  if (start >= 0) {
    region = html.slice(start, start + 300000)
    const end = region.search(/id=["'](?:prdReview|prdQnA|prdInfo|guideArea)["']|<!--\s*\/?(?:상품후기|리뷰)/i)
    if (end > 0) region = region.slice(0, end)
  }
  const raw = [...region.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+\.(?:jpe?g|png|gif|webp)[^"']*)["']/gi)].map(m => m[1])
  const SKIP = /echosting\.cafe24\.com|\/SkinImg\/|\/design\/|\/skin\/|icon|btn_|ico_|loading|blank|\/web\/product\/|\/web\/upload\/category\//i
  const abs = u => u.startsWith('//') ? 'https:' + u : (u.startsWith('/') ? ogHost + u : u)
  return [...new Set(raw.filter(u => u && !SKIP.test(u)).map(abs))]
}

/** 상품 상세 → 파싱 결과. 상세가 안 열리면(삭제·비공개 → 리다이렉트) null. */
export async function fetchUpickDetail(fx, base, productNo) {
  const r = await fx(`${base}/product/x/${productNo}/category/1/display/1/`)
  if (!r.ok) return null
  const html = await r.text()
  const info = infoTable(html)
  const title = decodeEnt((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || info['상품명'] || '').replace(/\s*-\s*U-PICK B2B\s*$/, '').replace(/\s+/g, ' ').trim() || null
  const thumb = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null
  const images = detailImages(html, thumb, base)
  const member = won(info['회원가'])
  const msp = extractMsp(info)
  const elig = deriveEligibility(info['판매가능플랫폼'], info['판매정책'], title)
  const opts = parseOptions(html)
  return {
    product_no: String(productNo),
    self_code: info['자체상품코드'] || null,
    product_code: info['상품코드'] || null,
    title,
    member_price_krw: member,
    min_sell_price_krw: msp.single,
    tiered_msp: msp.tiered,
    sellable_platforms: info['판매가능플랫폼'] || null,
    sale_policy: info['판매정책'] || null,
    coupang_allowed: elig.coupang_allowed,
    all_markets_ok: elig.all_markets_ok,
    shipping_fee_text: info['배송비'] || null,
    expiry_text: info['소비기한'] || null,
    order_deadline: info['발주마감'] || null,
    image_thumb: thumb,
    images,
    has_option: opts.length > 0,
    options: opts.length ? opts : null,
    status: 'active',
    detail_url: `${base}/product/x/${productNo}/category/1/display/1/`,
    raw_info: info,
  }
}
export const hashOf = d => crypto.createHash('sha256').update(JSON.stringify([d.member_price_krw, d.min_sell_price_krw, d.sellable_platforms, d.status, d.title, d.image_thumb, (d.images || []).join('|')])).digest('hex').slice(0, 16)

/** 상세 파싱 결과 저장. 내용(가격·MSP·플랫폼·제목·이미지)이 같으면 last_seen_at 만, 다르면 전체 upsert + last_changed_at. @returns 변동 여부 */
export async function saveUpickProduct(sb, d) {
  const now = new Date().toISOString()
  const row = { ...d, content_hash: hashOf(d) }
  const { data: ex, error } = await sb.from('jimscanner_upickb2b_products').select('content_hash').eq('product_no', d.product_no).maybeSingle()
  if (error) throw new Error(`upick 조회 실패 ${d.product_no}: ${error.message}`)
  if (ex && ex.content_hash === row.content_hash) {
    const { error: e2 } = await sb.from('jimscanner_upickb2b_products').update({ last_seen_at: now, status: d.status }).eq('product_no', d.product_no)
    if (e2) throw new Error(`upick 갱신 실패 ${d.product_no}: ${e2.message}`)
    return false
  }
  const { error: e3 } = await sb.from('jimscanner_upickb2b_products').upsert({ ...row, last_seen_at: now, last_changed_at: now }, { onConflict: 'product_no' })
  if (e3) throw new Error(`upick 저장 실패 ${d.product_no}: ${e3.message}`)
  return true
}
