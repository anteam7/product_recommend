// 가격 텍스트 → 통화별 숫자.
// 한국어 사이트의 표기 다양성 처리: '20,700원', '$15.99', '￥1,200', '€25', '12.5kg' 등.

export type ParsedPrice = {
  krw: number | null
  usd: number | null
  jpy: number | null
  cny: number | null
}

const NUM = /([\d,]+(?:\.\d+)?)/

function toNum(s: string | undefined): number | null {
  if (!s) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export function parsePriceText(raw: string): ParsedPrice {
  const out: ParsedPrice = { krw: null, usd: null, jpy: null, cny: null }
  if (!raw) return out
  const t = raw.trim()

  // KRW: '20,700원' | '20700 KRW' | 숫자만 있는 셀(컨텍스트로 판단 — 호출측이 KRW 라 명시한 경우는 parseAsKRW 사용)
  if (/원|krw|₩/i.test(t)) out.krw = toNum(t.match(NUM)?.[1])
  // USD
  else if (/\$|usd/i.test(t)) out.usd = toNum(t.match(NUM)?.[1])
  // JPY
  else if (/¥|￥|jpy/i.test(t)) out.jpy = toNum(t.match(NUM)?.[1])
  // CNY
  else if (/cny|위안|人民币|￥cn/i.test(t)) out.cny = toNum(t.match(NUM)?.[1])

  return out
}

export function parseAsKRW(raw: string): number | null {
  return toNum(raw.match(NUM)?.[1])
}

export function parseAsUSD(raw: string): number | null {
  return toNum(raw.match(NUM)?.[1])
}

// '12.5 kg' / '5 lb' / '1.0kg' → { value, unit }
export function parseWeight(raw: string): { value: number; unit: 'kg' | 'lb' } | null {
  if (!raw) return null
  const t = raw.trim().toLowerCase()
  const m = t.match(/([\d.,]+)\s*(kg|lbs?|파운드|킬로|kilogram)?/i)
  if (!m) return null
  const value = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  const unitToken = m[2] ?? ''
  const unit: 'kg' | 'lb' = /lb|파운드/i.test(unitToken) ? 'lb' : 'kg'
  return { value, unit }
}
