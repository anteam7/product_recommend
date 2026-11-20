/**
 * 도매아토즈 식품 규격 해석 — 시세 대조(domeatoz-market.mjs)와 쿠팡 등록(domeatoz-register.mjs) 공용. docs/plan-domeatoz.md §2.1
 *
 *   총량 = 첫 용량(ml·g, L·kg 환산) × 그 뒤 수량들의 곱(괄호 안 내역은 제외: "10g x 45T (15개입x3개)" = 450g).
 *   세트("+", "각N개")는 규격 비교 불가.
 */
// 단위 뒤 영문자는 단위가 아님(…"gold" 등) — 단, 곱하기 x 는 붙여 쓴다("355mlx48캔"·"30gx30스틱", 2026-11-01 이걸로 7건 등록 실패)
const VOL = /(\d+(?:\.\d+)?)\s*(ml|mL|ML|g|G|kg|KG|Kg|l|L)(?![a-wyzA-WYZ])/
const VOL_G = new RegExp(VOL.source, 'g')
const CNT_G = /[x×*]\s*(\d+)|(\d+)\s*(?:개입|개|입|캔|병|매|팩|페트|PET|pet|번들|롤|포|봉지|봉|박스|BOX|box|EA|ea|스틱|컵|통|T|P|p)(?![a-zA-Z가-힣])/g
function normVol(n, u) {
  let v = parseFloat(n); u = u.toLowerCase()
  if (u === 'l') { v *= 1000; u = 'ml' } else if (u === 'kg') { v *= 1000; u = 'g' }
  return { v, u }
}
// 삼일유통 밖 공급사 표기(2026-11-20, 00000684): 괄호가 내역이 아니라 실제 수량인 두 꼴을 괄호 밖으로 꺼낸다
//   "48g 1BOX (50개입)" → "48g 50개입"   ·   "340ml (24캔)"·"1000ml (6페트)" → "340ml 24캔"
//   용기 단위(캔·페트·병·팩)만 — "보노 스프 63g(3개입)"은 63g 안의 내역이라 그대로 둔다(삼일유통 표기)
// 대문자 X 곱하기는 규격 바로 뒤에서만 소문자 x 로 바꾼다("15스틱 X2"·"424g X 5개"·"(… 1kg)X15")
//   모델명("BMW X5")·치수("170X70mm")·단위 없는 숫자("12 X 3")·뒤에 영문 단위("100mm X 10m")는 그대로
const UPPER_X = /(\d\s*[가-힣A-Za-z]{1,3}\)?|\))\s*X(?=\s*\d+(?![\d.]*\s*[a-zA-Z]))/g
const BOX_OF = /1\s*(?:BOX|Box|box|박스)\s*\(\s*(\d+)\s*개입\s*\)/g
const VOL_PAREN_CNT = new RegExp(`(${VOL.source})\\s*\\(\\s*(\\d+)\\s*(캔|페트|PET|병|팩)\\s*\\)`, 'g')
// 용량 바로 뒤 "(N개입)"은 개당 용량인지 전체 용량인지 이름만으로 모른다 — 삼일유통 밖 공급사 등록 때 보류 판단용
export const ambiguousPack = (name) => new RegExp(`${VOL.source}\\s*\\(\\s*\\d+\\s*(?:개입|입|개)\\s*\\)`).test(String(name))
export function specOf(name) {
  const s = String(name || '').replace(UPPER_X, '$1 x').replace(BOX_OF, ' $1개입 ').replace(VOL_PAREN_CNT, '$1 $4$5 ')
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
// 브랜드(이름 첫 단어)의 앞 2글자(영문은 영문 부분 전체) — 회사명·브랜드명이 달라도("해태음료"↔"해태", "광동제약"↔"광동") 통과
const brandKey = (name) => {
  const all = String(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/[\s,/]+/).filter((w) => /[가-힣a-zA-Z]{2,}/.test(w) && !/\d/.test(w))
  if (all.length < 2) return null // 단어 하나뿐이면 브랜드인지 상품명인지 모름
  const w = all[0].replace(/[^가-힣a-zA-Z&]/g, '')
  if (/^[a-zA-Z]/.test(w)) return w.replace(/[^a-zA-Z&].*$/, '').toLowerCase() || null
  return w.length >= 2 ? w.slice(0, 2) : null
}
export function titleMatches(ourName, ourSpec, title) {
  const toks = brandless(ourName)
  const flat = String(title).replace(/\s/g, '')
  // 이름이 "브랜드 + 일반 단어 하나"(꽃샘 생강차플러스·동일 생강차·오뚜기 유자차)면 브랜드가 쿠팡 제목에 있어야 같은 상품 —
  // "꽃샘 생강차플러스 30T"가 "담터 생강차플러스 30g 30개"와 붙어 시세 5배로 등록됐던 문제(2026-11-20).
  // 단어가 2개 이상("롯데 레쓰비 마일드")이면 그 단어들이 이미 상품을 가르고, 쿠팡 제목엔 회사명(롯데·동서·오리온)이 자주 빠져 요구하지 않는다.
  const bk = toks.length === 1 ? brandKey(ourName) : null
  if (bk && !flat.toLowerCase().includes(bk)) return false
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

/**
 * 사람 입력 규격(관리자 /admin/domeatoz-spec → jimscanner_domeatoz_products.manual_spec, 2026-11-20) → purchaseSpecOf 와 같은 형식.
 *   { unit: 'g'|'ml', per: 1개당 중량·용량, pieces: 총 개수, attrs: { 구매옵션 이름: 값 } }
 *   per 있음 → 개당 중량·용량 × 개수 · per 없이 개수만 → count(카페믹스 50T 꼴) · 둘 다 없음 → null(이름·이미지 규격을 씀)
 */
export function manualSpecOf(m) {
  if (!m || typeof m !== 'object') return null
  const per = Number(m.per), pieces = Math.round(Number(m.pieces) || 1)
  if (per > 0 && (m.unit === 'g' || m.unit === 'ml') && pieces >= 1) {
    const weightG = m.unit === 'g' ? per : null, volumeMl = m.unit === 'ml' ? per : null
    return pieces > 1 ? { mode: 'piece', weightG, volumeMl, pieces, perPack: pieces, packs: 1 } : { mode: 'single', weightG, volumeMl, packs: 1 }
  }
  return pieces > 1 ? { mode: 'count', weightG: null, volumeMl: null, pieces } : null
}
