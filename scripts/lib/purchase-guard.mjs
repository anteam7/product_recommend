/**
 * 결제진행 완주 전 "주문서 총액 = 기대값" 가드 — 고도몰5 매입처(건강산·화장품스토리·77바이오) 공용 (2026-10-16)
 *
 *   기대 총액 = 공급가 × 매입 수량 + 배송비(기본 3,000원, 20만원↑ 무료)
 *   2026-09-15~10-16 완주 38건 중 37건이 이 식과 원 단위까지 일치했다.
 *   나머지 1건(화장품스토리 도브 시어버터 1L 3개 주문)은 매입처 재고 부족으로 주문서가 1개(9,900원)로 떨어졌는데,
 *   기존 가드(order-server guardFail)는 "총액 > 허용 상한"만 봐서 그대로 [결제하기]를 눌렀다 → 기대값과 다르면(적어도 많아도) 완주 중단.
 *
 *   단가 후보: 매입처 상품표(수집기가 갱신, 1개 단가) 우선 + 묶음 아닌 리스팅의 공급가(쿠팡 domeCost ÷ 수량).
 *   어느 후보든 ±10원 안이면 통과. 제주·울릉 배송지는 기대값보다 최대 1만원 많은 것까지 도서산간 추가배송비로 본다.
 *   캠핑문(Cafe24, 35% 할인)은 order-server supplierOptionInfo 가 따로 expectTotals 를 만든다(같은 개념, 다른 식).
 */
export const GODOMALL_PRICE_TABLES = {
  ggsan:    { table: 'jimscanner_ggsan_products',    col: 'price_krw' },
  cmtstory: { table: 'jimscanner_cmtstory_products', col: 'wholesale_price_krw', shipCol: 'shipping_fee_krw', freeCol: 'free_ship_threshold_krw' },
  bio77:    { table: 'jimscanner_bio77_products',    col: 'dome_price_krw' },
}
export const DEFAULT_SHIP = 3000
export const DEFAULT_FREE_THRESHOLD = 200000
const TOL = 10
const ISLAND_EXTRA_MAX = 10000
const ISLAND_RE = /제주|울릉/

/** 단가 후보 × 수량 → 기대 총액 후보 배열 [{ base, total, unit }] (첫 항목 = 대표값) */
export function buildExpectTotals({ units, qty, ship = DEFAULT_SHIP, freeThreshold = DEFAULT_FREE_THRESHOLD }) {
  const out = []
  const seen = new Set()
  for (const raw of units) {
    const u = Math.round(Number(raw))
    if (!(u > 0) || seen.has(u)) continue
    seen.add(u)
    const goods = u * qty
    out.push({ base: `공급가 ${u.toLocaleString()}×${qty}+배송비 ${ship.toLocaleString()}`, total: goods + ship, unit: u })
    if (ship > 0 && freeThreshold > 0 && goods >= freeThreshold) out.push({ base: `공급가 ${u.toLocaleString()}×${qty}(${(freeThreshold / 10000).toLocaleString()}만원↑ 무료배송)`, total: goods, unit: u })
  }
  return out
}

/**
 * 결제진행 주문(r = order-server resolveOrder 결과)의 기대 총액. 고도몰5 매입처가 아니면 null.
 * 쿠팡 r.domeCost = 리스팅 dome_price × 수량. 리스팅 공급가는 묶음이 아닐 때(bundle=1)만 보조 후보로 쓴다 —
 *   묶음 리스팅은 dome_price 가 1개 단가(화장품스토리·77바이오 1/2/3개 변형)인지 묶음 가격(건강산 register-bundle)인지 섞여 있고,
 *   "÷ 묶음 수" 후보는 단가 ÷ N × (주문수 × N) = 1세트만 담긴 주문서 총액과 항상 같아져 바로 그 사고(3개 → 1개)를 통과시킨다(재생 시험으로 확인).
 * @returns {Promise<{ totals: {base:string,total:number,unit:number}[], ship: number } | null>}
 */
export async function godomallExpectTotals(sb, r, qty) {
  const conf = GODOMALL_PRICE_TABLES[r?.source]
  if (!conf) return null
  const cols = [conf.col, conf.shipCol, conf.freeCol].filter(Boolean).join(', ')
  const { data: p, error } = await sb.from(conf.table).select(cols).eq('goods_no', String(r.goodsNo)).maybeSingle()
  if (error) throw new Error(`${conf.table} 조회 실패: ${error.message}`)
  const units = [p?.[conf.col]]
  if ((r.bundle ?? 1) === 1 && r.domeCost > 0 && qty > 0 && Number.isInteger(r.domeCost / qty)) units.push(r.domeCost / qty)
  const ship = conf.shipCol && p?.[conf.shipCol] != null ? Number(p[conf.shipCol]) : DEFAULT_SHIP
  const freeThreshold = conf.freeCol && p?.[conf.freeCol] > 0 ? Number(p[conf.freeCol]) : DEFAULT_FREE_THRESHOLD
  return { totals: buildExpectTotals({ units, qty, ship, freeThreshold }), ship }
}

/**
 * 주문서 총액 검사. expectTotals 가 비면 실패(완주 거부)로 본다 — 호출부가 "계산 불가"를 따로 안내.
 * @returns {{ ok: true, note: string } | { ok: false, msg: string, short: string }}
 */
export function checkExpectTotals(total, expectTotals, { qty = 1, ship = DEFAULT_SHIP, address = '' } = {}) {
  if (total == null) return { ok: false, msg: '주문서 총액 파싱 실패 — 기대값 비교 불가', short: '총액 파싱 실패' }
  if (!Array.isArray(expectTotals) || !expectTotals.length) return { ok: false, msg: '기대 총액 계산 불가(공급가 미상)', short: '기대 총액 미상' }
  const hit = expectTotals.find((e) => Math.abs(e.total - total) <= TOL)
  if (hit) return { ok: true, note: hit.base }
  const head = expectTotals[0]
  if (ISLAND_RE.test(address || '') && total > head.total && total - head.total <= ISLAND_EXTRA_MAX) {
    return { ok: true, note: `${head.base} + 도서산간 추가배송비 추정 ${(total - head.total).toLocaleString()}원` }
  }
  // 대표 단가로 주문서 수량을 역산 — 정수로 떨어지면 "수량이 바뀐 것"으로 안내
  let implied = ''
  for (const s of [ship, 0]) {
    const k = (total - s) / head.unit
    if (k >= 1 && Math.abs(k - Math.round(k)) < 0.001 && Math.round(k) !== qty) { implied = ` · 주문서 수량이 ${Math.round(k)}개로 보임(요청 ${qty}개)`; break }
  }
  const why = total < head.total ? '기대값보다 적음(매입처 재고 부족·품절로 수량이 줄었거나 공급가 인하)' : '기대값보다 많음(수량 증가·장바구니 합산·공급가 인상)'
  const list = expectTotals.map((e) => `${e.base}=${e.total.toLocaleString()}`).join(' / ')
  return {
    ok: false,
    msg: `주문서 총액 ${total.toLocaleString()}원이 기대값(${list})과 다름 — ${why}${implied} — 완주 중단(열린 창에서 수량·재고·공급가 확인)`,
    short: `기대 총액 ${head.total.toLocaleString()}원과 다름${implied}`,
  }
}
