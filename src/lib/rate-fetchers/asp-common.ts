import type { FetcherContext, ParsedRate, ShippingType } from './types'

/**
 * ASP 공통 백엔드를 쓰는 8개 사이트 통합 파서.
 *  thessan / araku / easytao / chinaroad / tabae / tabaejapan (data-label 변종)
 *  japantimemall / triolink (column-grade 변종)
 *
 * 두 HTML 변종 자동 감지:
 *   A. data-label 변종: <td class="title">1kg</td><td data-label="VIP">￦7,000</td>
 *      - 한 행에 여러 등급의 data-label cell 이 함께 있을 수도, 등급별로 별도 table 일 수도 있음
 *   B. column-grade 변종: 첫 행이 <th>무게,등급1,등급2,...</th>, 다음 행 <th>1kg</th><td>가격1</td><td>가격2</td>...
 *
 * 통화: 가격 셀 안의 기호 — ￦/원 → KRW, ¥/￥ → 사이트별 매핑(JP=JPY, CN=CNY 가능. 본 사이트들은 KRW or JPY 만).
 *
 * 국가 / 통화 매핑은 forwarder slug 단위로 하드코딩.
 *
 * 운송: 페이지에 air/marine 명시 없으므로 'air' 로 일괄. (japantimemall 처럼 별도 표가 있는 경우 추후 분리)
 */

const FETCH_TIMEOUT_MS = 30_000

const COUNTRY_BY_SLUG: Record<string, string> = {
  thessan: 'CN',
  araku: 'JP',
  easytao: 'CN',
  chinaroad: 'CN',
  tabae: 'CN',
  tabaejapan: 'JP',
  japantimemall: 'JP',
  triolink: 'CN',
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

type ParsedPriceCell = { krw: number | null; jpy: number | null; cny: number | null }

function parsePriceCell(text: string): ParsedPriceCell {
  const out: ParsedPriceCell = { krw: null, jpy: null, cny: null }
  const numMatch = text.match(/([\d,]+(?:\.\d+)?)/)
  if (!numMatch) return out
  const n = Number(numMatch[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return out
  if (/￦|원|krw/i.test(text)) out.krw = n
  else if (/￥|¥/.test(text)) {
    // 본 8 사이트 중 ¥ 쓰는 곳은 JP 사이트 (araku, tabaejapan, japantimemall) 만 — 모두 JPY.
    out.jpy = n
  } else if (/cny|위안/i.test(text)) out.cny = n
  return out
}

function parseWeightCell(text: string): { value: number; unit: 'kg' | 'lb' } | null {
  const m = text.toLowerCase().match(/([\d.,]+)\s*(kg|lbs?|파운드)?/i)
  if (!m) return null
  const v = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(v)) return null
  const unit: 'kg' | 'lb' = /lb|파운드/i.test(m[2] ?? '') ? 'lb' : 'kg'
  return { value: v, unit }
}

type Variant = 'data-label' | 'column-grade' | 'unknown'

function detectVariant(tableHtml: string): Variant {
  if (/data-label=/.test(tableHtml)) return 'data-label'
  // column-grade: 첫 tr 에 <th> 가 2개 이상, tbody 행에 <th> + <td>
  const firstTr = tableHtml.match(/<tr[\s\S]*?<\/tr>/i)?.[0] ?? ''
  const thInFirst = (firstTr.match(/<th\b/g) || []).length
  if (thInFirst >= 2) return 'column-grade'
  return 'unknown'
}

function parseDataLabelTable(country: string, tableHtml: string): ParsedRate[] {
  const rates: ParsedRate[] = []
  const rows = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
  // 등급별 누적 weight_min 추적 — 등급마다 정렬 보장 어려워 단순화: prev=0 from first row of that grade
  // 행 단위로 처리: 행 안에서 weight 한 번 + 여러 data-label 셀
  const prevWeightByGrade = new Map<string, number>()
  for (const row of rows) {
    const cells = [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    if (cells.length < 2) continue
    // weight: 첫 셀이 class="title" 이거나 첫 셀의 텍스트가 weight 형태
    const firstText = stripTags(cells[0][1])
    const w = parseWeightCell(firstText)
    if (!w) continue

    // 같은 행의 모든 data-label 셀 처리
    for (let i = 1; i < cells.length; i++) {
      const cellWhole = cells[i][0]
      const labelMatch = cellWhole.match(/data-label="([^"]+)"/i)
      if (!labelMatch) continue
      const grade = labelMatch[1].trim()
      const cellText = stripTags(cells[i][1])
      const price = parsePriceCell(cellText)
      const has = price.krw !== null || price.jpy !== null || price.cny !== null
      if (!has) continue
      const prev = prevWeightByGrade.get(grade) ?? 0
      rates.push({
        country,
        center_name: null,
        weight_min: prev,
        weight_max: w.value,
        weight_unit: w.unit,
        price_krw: price.krw,
        price_usd: null,
        price_jpy: price.jpy,
        price_cny: price.cny,
        price_eur: null,
        shipping_type: 'air' as ShippingType,
        service_label: null,
        member_grade: grade,
        grade_level: 1, // 후처리에서 정렬
      })
      prevWeightByGrade.set(grade, w.value)
    }
  }
  return rates
}

function parseColumnGradeTable(country: string, tableHtml: string): ParsedRate[] {
  const rates: ParsedRate[] = []
  const rows = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
  if (rows.length < 2) return rates
  // 첫 행: <th>무게 / 등급1 / 등급2 / ...</th>
  const headerCells = [...rows[0][0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]))
  if (headerCells.length < 2) return rates
  const grades = headerCells.slice(1) // 첫 셀(무게) 제외
  let prev = 0
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r][0]
    const firstCellMatch = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i)
    if (!firstCellMatch) continue
    const w = parseWeightCell(stripTags(firstCellMatch[1]))
    if (!w) continue
    const tdCells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]))
    for (let i = 0; i < tdCells.length && i < grades.length; i++) {
      const grade = grades[i]
      const price = parsePriceCell(tdCells[i])
      const has = price.krw !== null || price.jpy !== null || price.cny !== null
      if (!has) continue
      rates.push({
        country,
        center_name: null,
        weight_min: prev,
        weight_max: w.value,
        weight_unit: w.unit,
        price_krw: price.krw,
        price_usd: null,
        price_jpy: price.jpy,
        price_cny: price.cny,
        price_eur: null,
        shipping_type: 'air' as ShippingType,
        service_label: null,
        member_grade: grade,
        grade_level: i + 1,
      })
    }
    prev = w.value
  }
  return rates
}

/** 파싱 후 등급별 grade_level 재할당: data-label 변종은 셀 등장 순서로 1부터. */
function assignGradeLevels(rates: ParsedRate[]): void {
  const grades: string[] = []
  for (const r of rates) {
    if (!grades.includes(r.member_grade)) grades.push(r.member_grade)
  }
  const levelByGrade = new Map(grades.map((g, i) => [g, i + 1]))
  for (const r of rates) {
    r.grade_level = levelByGrade.get(r.member_grade)!
  }
}

export async function fetchAspCommon(ctx: FetcherContext): Promise<{ rates: ParsedRate[]; raw_snapshot: string }> {
  const country = COUNTRY_BY_SLUG[ctx.forwarder_slug]
  if (!country) throw new Error(`country 매핑 없음: ${ctx.forwarder_slug}`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let html: string
  try {
    const res = await fetch(ctx.source_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jimscanner-bot/1.0)' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    html = await res.text()
  } finally {
    clearTimeout(timer)
  }

  const allTables = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0])
  const rates: ParsedRate[] = []
  for (const t of allTables) {
    const variant = detectVariant(t)
    // weight cell 이 들어 있는 표만 처리 (kg / lb)
    if (!/(\d[\d.]*\s*(?:kg|lbs?))/i.test(t)) continue
    if (variant === 'data-label') {
      rates.push(...parseDataLabelTable(country, t))
    } else if (variant === 'column-grade') {
      rates.push(...parseColumnGradeTable(country, t))
    }
  }

  if (rates.length === 0) throw new Error('가격표 파싱 0행 — 변종 미감지 또는 구조 변경')

  assignGradeLevels(rates)
  return { rates, raw_snapshot: html }
}
