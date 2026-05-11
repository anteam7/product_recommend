import type { ParsedRate, ShippingType } from './types'

/**
 * 단일 가격표 (header 1~3행 + weight column + N price columns) 사이트용 헬퍼.
 * 사이트별로 ColumnConfig 만 다르게 넘기면 동일 로직으로 파싱.
 */

export type ColumnConfig = {
  /** weight column index (보통 0) */
  weightCol: number
  /** weight unit. 헤더에서 lb/kg 자동 감지 안되면 명시 */
  forceWeightUnit?: 'kg' | 'lb' | 'g'
  /** weight cell 텍스트 → 숫자 (kg). 기본: 첫 숫자 추출, weight_unit=kg/lb 그대로 */
  parseWeight?: (text: string) => { value: number; unit: 'kg' | 'lb' } | null
  /** price 컬럼 정의. 각 컬럼 별로 grade name / shipping_type / center / service_label 지정 */
  priceCols: PriceColConfig[]
  /** 데이터 시작 행 인덱스 (헤더 행 수) */
  dataStartRow: number
  /** 통화 강제 (auto-detect 안 될 때) */
  forceCurrency?: 'krw' | 'usd' | 'jpy' | 'cny' | 'eur'
  /** 국가 ISO-2 */
  country: string
}

export type PriceColConfig = {
  colIndex: number
  member_grade: string
  grade_level: number
  shipping_type?: ShippingType
  center_name?: string | null
  service_label?: string | null
}

const NUM = /([\d,]+(?:\.\d+)?)/

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

function detectCurrency(text: string, force?: 'krw' | 'usd' | 'jpy' | 'cny' | 'eur') {
  if (force) return force
  if (/￦|원|krw/i.test(text)) return 'krw'
  if (/€|eur/i.test(text)) return 'eur'
  if (/\$|usd/i.test(text)) return 'usd'
  if (/￥|¥|jpy/i.test(text)) return 'jpy'
  if (/cny|위안/i.test(text)) return 'cny'
  return null
}

function parsePriceTo(rate: Partial<ParsedRate>, text: string, currency: 'krw' | 'usd' | 'jpy' | 'cny' | 'eur' | null): boolean {
  const m = text.match(NUM)
  if (!m) return false
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return false
  if (!currency) currency = detectCurrency(text) ?? null
  if (!currency) return false
  if (currency === 'krw') rate.price_krw = n
  else if (currency === 'usd') rate.price_usd = n
  else if (currency === 'jpy') rate.price_jpy = n
  else if (currency === 'cny') rate.price_cny = n
  else if (currency === 'eur') rate.price_eur = n
  return true
}

function defaultParseWeight(text: string): { value: number; unit: 'kg' | 'lb' } | null {
  const t = text.toLowerCase()
  const m = t.match(/([\d.,]+)\s*(kg|lbs?|파운드)?/)
  if (!m) return null
  const v = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(v)) return null
  const unit: 'kg' | 'lb' = /lb|파운드/i.test(m[2] ?? '') ? 'lb' : 'kg'
  return { value: v, unit }
}

/**
 * 여러 행으로부터 ParsedRate[] 추출. 행 단위로 weight 한 번 + 컬럼별 가격.
 * 한 행에서 weight_min 은 직전 행의 weight (등급별 독립 누적).
 */
export function parseSimpleTable(tableHtml: string, cfg: ColumnConfig): ParsedRate[] {
  const rates: ParsedRate[] = []
  const rows = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
  // 등급별 prev weight 추적
  const prevWByGrade = new Map<string, number>()

  for (let r = cfg.dataStartRow; r < rows.length; r++) {
    const cells = [...rows[r][0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1]))
    if (cells.length <= cfg.weightCol) continue

    const wText = cells[cfg.weightCol]
    const w = (cfg.parseWeight ?? defaultParseWeight)(wText)
    if (!w) continue
    if (cfg.forceWeightUnit === 'g') {
      // gram → kg
      w.value = w.value / 1000
      w.unit = 'kg'
    } else if (cfg.forceWeightUnit) {
      w.unit = cfg.forceWeightUnit
    }

    for (const pc of cfg.priceCols) {
      const cellText = cells[pc.colIndex]
      if (!cellText) continue
      const rate: Partial<ParsedRate> = {
        country: cfg.country,
        center_name: pc.center_name ?? null,
        weight_unit: w.unit,
        shipping_type: pc.shipping_type ?? 'air',
        service_label: pc.service_label ?? null,
        member_grade: pc.member_grade,
        grade_level: pc.grade_level,
        price_krw: null,
        price_usd: null,
        price_jpy: null,
        price_cny: null,
        price_eur: null,
      }
      const ok = parsePriceTo(rate, cellText, cfg.forceCurrency ?? null)
      if (!ok) continue
      const key = `${pc.member_grade}|${pc.center_name ?? ''}|${pc.shipping_type ?? 'air'}|${pc.service_label ?? ''}`
      const prev = prevWByGrade.get(key) ?? 0
      rate.weight_min = prev
      rate.weight_max = w.value
      prevWByGrade.set(key, w.value)
      rates.push(rate as ParsedRate)
    }
  }
  return rates
}

export function pickTable(html: string, index: number): string | null {
  const tables = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)]
  return tables[index]?.[0] ?? null
}

export async function fetchHtml(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jimscanner-bot/1.0)' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}
