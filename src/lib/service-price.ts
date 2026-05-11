/**
 * 부가서비스 가격 원문 → { price_numeric, price_currency } 파싱.
 * scripts/import-from-json.mjs 와 동일한 규칙.
 */

const AMBIGUOUS_RE = /(실비|case|별도|협의|또는|이상|초과|미만|조건|\+ 현지|\+현지|\+ 국제|\+국제)/i

export function parseServicePrice(raw: string | null | undefined): {
  price_text: string | null
  price_numeric: number | null
  price_currency: 'KRW' | 'USD' | 'JPY' | null
} {
  const text = (raw ?? '').trim()
  const base = { price_text: text || null, price_numeric: null, price_currency: null } as const

  if (!text) return { ...base }
  if (AMBIGUOUS_RE.test(text)) return { ...base }

  if (/^\s*(무료|free|0원|0\s*원)\s*$/i.test(text)) {
    return { price_text: text, price_numeric: 0, price_currency: 'KRW' }
  }

  let m = text.match(/\$\s*([\d,]+(?:\.\d+)?)/)
  if (m) return { price_text: text, price_numeric: parseFloat(m[1].replace(/,/g, '')), price_currency: 'USD' }

  m = text.match(/¥\s*([\d,]+(?:\.\d+)?)/) || text.match(/([\d,]+(?:\.\d+)?)\s*엔/)
  if (m) return { price_text: text, price_numeric: parseFloat(m[1].replace(/,/g, '')), price_currency: 'JPY' }

  m = text.match(/([\d,]+(?:\.\d+)?)\s*원/)
  if (m) return { price_text: text, price_numeric: parseFloat(m[1].replace(/,/g, '')), price_currency: 'KRW' }

  return { ...base }
}
