/**
 * 도매아토즈 식품 규격 해석 — 시세 대조(domeatoz-market.mjs)와 쿠팡 등록(domeatoz-register.mjs) 공용. docs/plan-domeatoz.md §2.1
 *
 *   총량 = 첫 용량(ml·g, L·kg 환산) × 그 뒤 수량들의 곱(괄호 안 내역은 제외: "10g x 45T (15개입x3개)" = 450g).
 *   세트("+", "각N개")는 규격 비교 불가.
 */
const VOL = /(\d+(?:\.\d+)?)\s*(ml|mL|ML|g|G|kg|KG|Kg|l|L)(?![a-zA-Z])/
const VOL_G = new RegExp(VOL.source, 'g')
const CNT_G = /[x×*]\s*(\d+)|(\d+)\s*(?:개입|개|입|캔|병|매|팩|PET|pet|번들|롤|포|봉지|봉|박스|BOX|box|EA|ea|스틱|컵|통|T|P|p)(?![a-zA-Z가-힣])/g
function normVol(n, u) {
  let v = parseFloat(n); u = u.toLowerCase()
  if (u === 'l') { v *= 1000; u = 'ml' } else if (u === 'kg') { v *= 1000; u = 'g' }
  return { v, u }
}
export function specOf(name) {
  const s = String(name || '')
  if (/\+|각\s*\d/.test(s)) return { set: true }
  const m = s.match(VOL)
  const vol = m ? normVol(m[1], m[2]) : null
  // 첫 용량 뒤(없으면 전체)에서 괄호 내역·다른 용량을 지우고 수량을 곱한다
  let rest = m ? s.slice(m.index + m[0].length) : s
  rest = rest.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[()[\]]/g, ' ').replace(VOL_G, ' ')
  const cnts = [...rest.matchAll(CNT_G)].map((x) => +(x[1] || x[2])).filter((n) => n >= 1 && n < 2000)
  // 쿠팡 제목은 수량을 용량 앞 칸에 쓰기도 한다("상품명, 2개, 367.5g") — 용량 앞의 쉼표 칸 중 수량만 있는 칸(첫 칸=상품명 제외)도 곱한다
  if (m) for (const seg of s.slice(0, m.index).split(',').slice(1)) { const c = seg.trim().match(/^(\d+)\s*(?:개입|개|입|팩|박스|봉|병|캔|PET|EA)$/i); if (c && +c[1] >= 1 && +c[1] < 2000) cnts.push(+c[1]) }
  const count = cnts.reduce((a, b) => a * b, 1)
  return { set: false, vol, count, total: vol ? vol.v * count : null }
}
// 같은 상품의 묶음 수 변형("… 230g x 2개 / x 4개 / x 8개")은 한 번만 검색한다 — 끝의 묶음 수량만 뗀 이름
export const baseOf = (name) => String(name).replace(/\s*[x×*]?\s*\d+\s*(?:개|박스|PET|팩|캔|병|봉|EA)\s*$/i, '').trim()
const brandless = (name) => {
  const toks = String(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/[\s,/]+/).filter((w) => /[가-힣a-zA-Z]{2,}/.test(w) && !/\d/.test(w)).slice(0, 5)
  return toks.length >= 2 ? toks.slice(1) : toks
}
export function titleMatches(ourName, ourSpec, title) {
  const toks = brandless(ourName)
  const flat = String(title).replace(/\s/g, '')
  const hit = toks.filter((w) => flat.includes(w)).length
  if (!toks.length || hit < Math.ceil((toks.length * 2) / 3)) return false // 3개 중 2개, 2개면 둘 다
  const t = specOf(title)
  if (t.set) return false
  if (ourSpec.vol && t.vol) return ourSpec.vol.u === t.vol.u && Math.abs(ourSpec.total - t.total) <= ourSpec.total * 0.02
  return ourSpec.count === t.count && ourSpec.count > 1
}
export const queryOf = (name) => String(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)

/**
 * 쿠팡 구매옵션용 규격 — lib/coupang-purchase-options.mjs buildPurchaseOptions 의 spec 형식으로.
 * 쿠팡 식품 norm "142g, 5개" = 개당 중량(첫 용량) + 수량(뒤 수량들의 곱). 공용 parseSpec 은 '개'를 수량으로 안 읽어
 * "초코하임 142g 5개"를 "142g, 1개"로 만든다 → 도매아토즈는 specOf 로 읽는다. 세트거나 용량·수량 둘 다 없으면 null(등록 보류).
 * 용량 없이 개수만 있는 이름("카페믹스 50T" 스틱·티백)은 수량만 — "50개"(사장님 2026-10-28 "T 옵션은 수량 50개처럼 개수로").
 */
export function purchaseSpecOf(name) {
  const s = specOf(name)
  if (s.set) return null
  if (!s.vol) return s.count > 1 ? { mode: 'count', weightG: null, volumeMl: null, pieces: s.count } : null
  const weightG = s.vol.u === 'g' ? s.vol.v : null, volumeMl = s.vol.u === 'ml' ? s.vol.v : null
  return s.count > 1
    ? { mode: 'piece', weightG, volumeMl, pieces: s.count, perPack: s.count, packs: 1 }
    : { mode: 'single', weightG, volumeMl, packs: 1 }
}
