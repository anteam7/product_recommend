/**
 * 소싱 판매가 계산 — "1개 팔 때 / N개 묶음 팔 때 얼마 받아야 마진이 남는가".
 *
 * 원가 구조는 scripts/scout-sourcing-publish.mjs 의 마진식과 동일하게 맞춘다(값이 갈리면 페이지와 리포트가 서로 다른 말을 한다):
 *   마진 = 판매가 − 실단가×매입수량 − (판매가×수수료율 + 로켓그로스물류비)×1.1 − 박스
 *
 * 실단가(landed) = 도매꾹 공급가 + 입고배송비/개 → 개당 원가이므로 묶음이면 개수만큼 곱한다.
 * 물류비는 '판매 1건당' 부과(묶음 1건 = 1회)지만 부피가 커지면 티어가 올라간다 → suggestTier 로 추정하고 UI 에서 바꿀 수 있게 한다.
 */

export const VAT = 1.1
export const BOX_COST = 500        // 부자재(박스) — publish 스크립트 BOX 상수와 동일
export const RG_MIN_PRICE = 3000   // 로켓그로스 최소 판매가

export const RG_LOGI = { 극소형: 1950, 소형: 2200, 중형: 3350, 대형1: 3575 } as const
export type RgTier = keyof typeof RG_LOGI
export const RG_TIERS = ['극소형', '소형', '중형', '대형1'] as const

const ceil100 = (n: number) => Math.ceil(n / 100) * 100

/**
 * 발행 스냅샷에는 물류비 컬럼이 없다. 정상마진과 프로모션마진(물류비 0)의 차이가 물류비×VAT 이므로 역산한다.
 * (실데이터 52건 검증: 전 건 2200/3350 티어값에 정확히 일치, 재계산 오차 0원)
 */
export function deriveLogi(margin: number | null | undefined, marginPromo: number | null | undefined): number | null {
  if (margin == null || marginPromo == null) return null
  const v = Math.round((marginPromo - margin) / VAT)
  return v >= 0 ? v : null
}

export function tierOfLogi(logi: number | null): RgTier {
  if (logi == null) return '소형'
  let best: RgTier = '소형'
  let gap = Infinity
  for (const t of RG_TIERS) { const d = Math.abs(RG_LOGI[t] - logi); if (d < gap) { gap = d; best = t } }
  return best
}

/** 묶음이 커지면 부피 티어가 올라간다 — 추정치(3~5개 한 단계, 6개+ 두 단계). UI 에서 직접 지정 가능. */
export function suggestTier(base: RgTier, n: number): RgTier {
  const i = RG_TIERS.indexOf(base)
  const bump = n <= 2 ? 0 : n <= 5 ? 1 : 2
  return RG_TIERS[Math.min(RG_TIERS.length - 1, (i < 0 ? 1 : i) + bump)]
}

export type CostInput = {
  landed: number      // 개당 실단가(도매가 + 입고배송비/개)
  qty: number         // 이번 리스팅으로 파는 개수
  fee: number         // 판매수수료율 (0.108 등)
  logi: number        // 로켓그로스 물류비(판매 1건당). 프로모션 기간이면 0
  box?: number
}

/** 주어진 판매가의 마진/마진율 */
export function marginAt(sell: number, c: CostInput) {
  const box = c.box ?? BOX_COST
  const margin = Math.round(sell - c.landed * c.qty - (sell * c.fee + c.logi) * VAT - box)
  return { margin, rate: sell > 0 ? Math.round((margin / sell) * 100) : 0 }
}

/**
 * 목표 마진율(0~0.8)을 달성하는 판매가. 수수료가 판매가에 비례하므로 역산이 필요하다.
 *   sell×(1 − r − 수수료율×VAT) = 실단가×수량 + 물류비×VAT + 박스
 * 100원 단위 올림 + 로켓그로스 최소가(3,000원) 하한.
 */
export function priceForRate(targetRate: number, c: CostInput): number | null {
  const denom = 1 - targetRate - c.fee * VAT
  if (denom <= 0.02) return null   // 목표율이 너무 높아 어떤 가격으로도 달성 불가
  const box = c.box ?? BOX_COST
  const raw = (c.landed * c.qty + c.logi * VAT + box) / denom
  if (!Number.isFinite(raw) || raw <= 0) return null
  return Math.max(RG_MIN_PRICE, ceil100(raw))
}

/** 손익분기 판매가(마진 0) */
export const breakEvenPrice = (c: CostInput) => priceForRate(0, c)

/**
 * 쿠팡 상품명에서 '몇 개를 사는가'(매입 수량). 도매 공급가는 1개 단가라 N개 묶음이면 N배로 매입해야 한다.
 * scripts/scout-margin.mjs 의 setQty 와 동일 규칙 — 구매수량(개·세트·박스)과 팩 내용물(개입·매·p)을 구분한다.
 */
export function parseSetQty(name: string | null | undefined): number {
  const hits = (name || '').match(/(\d+)\s*(?:개(?!입)|세트|박스)(?![a-z가-힣])/g) || []
  let max = 1
  for (const h of hits) { const v = parseInt(h); if (v > max && v <= 200) max = v }
  return max
}

/** 팩 내용물 개수(곱하지 않음) — 도매 매칭이 같은 구성인지 사람이 확인하는 용도 */
export function parsePackCount(name: string | null | undefined): number {
  const hits = (name || '').match(/(\d+)\s*(?:개입|매|[pP])(?![a-z가-힣])/g) || []
  let max = 1
  for (const h of hits) { const v = parseInt(h); if (v > max && v <= 500) max = v }
  return max
}
