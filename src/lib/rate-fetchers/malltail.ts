import type { FetcherContext, ParsedRate, ShippingType } from './types'
import { normalizeCountry } from './country'

/**
 * 몰테일 (post.malltail.com) — /services/price_list/{COUNTRY}/KR/KR
 *
 * 페이지에는 4개 가격 div 가 존재:
 *   1. <div id="price_more">      — "더보기" 팝업, 4열 (weight/price/weight/price), 풀 레인지(0.5~60), 일반회원만
 *   2. <div id="price_more_nj">   — _nj 변형 팝업, 위와 동일 레이아웃 (US 의 경우 빈 템플릿; JP/CN 은 다른 가격)
 *   3. <div id="box_price_new">    — 페이지 상단 보이는 표, 4열 (weight/플래티넘/일반/현재등급), 제한 레인지(~16)
 *   4. <div id="box_price_new_nj"> — 위와 같은 레이아웃의 _nj 변형
 *
 * 수집 정책:
 *   - price_more*  → 일반회원 (level 1) · 풀 레인지
 *   - box_price_new* → 플래티넘회원 (level 2) 만 추출 (일반 컬럼은 price_more 와 중복이라 스킵)
 *
 * 식별:
 *   - US: 기본 div = CA 센터, _nj 변형 = NJ 센터 (center_name 으로 분리)
 *   - JP/CN: 기본 = null 센터, _nj = service_label='NJ' 라벨로 보존 (의미는 추후 해석)
 *
 * 운송: air/marine 탭이 페이지에서 비활성. 기본 'air' 로 기록.
 */

const FETCH_TIMEOUT_MS = 30_000

type PopupRow = { weight: number; price_usd: number | null }
type VisibleRow = { weight: number; platinum_usd: number | null; regular_usd: number | null }

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
}

function findOuterTableAfter(html: string, idMarker: string): string | null {
  const i = html.indexOf(idMarker)
  if (i === -1) return null
  const ts = html.indexOf('<table', i)
  if (ts === -1) return null
  // 단순 첫 </table> 까지 (중첩 무시) — popup 의 outer table 는 한 줄 마무리
  const te = html.indexOf('</table>', ts)
  if (te === -1) return null
  return html.slice(ts, te + 8)
}

/** popup (price_more*) — 4열 weight/price/weight/price */
function parsePopupTable(html: string, idMarker: string): { unit: 'kg' | 'lb'; rows: PopupRow[] } | null {
  // outer table 안에 inner table 존재 (popup wrapper). 최초 inner tbody 사용.
  const i = html.indexOf(idMarker)
  if (i === -1) return null
  // 첫 thead 의 첫 weight cell 로 unit 판단
  const firstUnitMatch = html.slice(i).match(/<td[^>]*>([\s\S]*?)<\/td>/i)
  // tbody 추출
  const bodyMatch = html.slice(i).match(/<tbody[\s\S]*?<\/tbody>/i)
  if (!bodyMatch) return null
  const rows: PopupRow[] = []
  let unit: 'kg' | 'lb' = 'kg'
  let unitDecided = false
  for (const trMatch of bodyMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const tds = [...trMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]))
    if (tds.length < 4) continue
    if (!unitDecided) {
      const unitText = tds[0].toLowerCase()
      if (/lbs?/i.test(unitText)) unit = 'lb'
      else if (/kg/i.test(unitText)) unit = 'kg'
      unitDecided = true
    }
    const parsePair = (wStr: string, pStr: string): PopupRow | null => {
      const wm = wStr.match(/([\d.,]+)/)
      if (!wm) return null
      const w = Number(wm[1].replace(/,/g, ''))
      if (!Number.isFinite(w)) return null
      const pm = pStr.match(/\$\s*([\d.,]+)/)
      const p = pm ? Number(pm[1].replace(/,/g, '')) : null
      return { weight: w, price_usd: Number.isFinite(p) ? (p as number) : null }
    }
    const left = parsePair(tds[0], tds[1])
    const right = parsePair(tds[2], tds[3])
    if (left && left.price_usd !== null) rows.push(left)
    if (right && right.price_usd !== null) rows.push(right)
  }
  rows.sort((a, b) => a.weight - b.weight)
  return { unit, rows }
}

/** visible (box_price_new*) — 4열 weight/플래티넘/일반/현재등급 */
function parseVisibleTable(html: string, idMarker: string): { unit: 'kg' | 'lb'; rows: VisibleRow[] } | null {
  const i = html.indexOf(idMarker)
  if (i === -1) return null
  // 첫 table 만 사용 (id div 안에 한 개)
  const ts = html.indexOf('<table', i)
  if (ts === -1) return null
  const te = html.indexOf('</table>', ts)
  if (te === -1) return null
  const tableHtml = html.slice(ts, te + 8)
  const headMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i)
  const firstTh = headMatch?.[0].match(/<th[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? ''
  const unit: 'kg' | 'lb' = /lbs?/i.test(stripTags(firstTh)) ? 'lb' : 'kg'
  const bodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i)
  if (!bodyMatch) return null
  const rows: VisibleRow[] = []
  for (const trMatch of bodyMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const tds = [...trMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]))
    if (tds.length < 3) continue
    const w = Number(tds[0].replace(/,/g, ''))
    if (!Number.isFinite(w)) continue
    const parseUsd = (s: string): number | null => {
      const pm = s.match(/\$\s*([\d.,]+)/)
      if (!pm) return null
      const n = Number(pm[1].replace(/,/g, ''))
      return Number.isFinite(n) ? n : null
    }
    rows.push({
      weight: w,
      platinum_usd: parseUsd(tds[1]),
      regular_usd: parseUsd(tds[2]),
    })
  }
  return { unit, rows }
}

function centerForUS(suffix: string | null): string {
  return suffix === 'nj' ? 'NJ' : 'CA'
}

function buildRates(country: string, opts: {
  source: 'popup' | 'visible'
  suffix: string | null
  unit: 'kg' | 'lb'
  popup?: PopupRow[]
  visible?: VisibleRow[]
}): ParsedRate[] {
  const { source, suffix, unit } = opts
  const out: ParsedRate[] = []
  const isUS = country === 'US'
  const center_name = isUS ? centerForUS(suffix) : null
  // service_label: US 는 center_name 으로 분리하니 NULL. JP/CN 의 _nj 는 라벨에 보존.
  const service_label = isUS ? null : suffix ? suffix.toUpperCase() : null

  if (source === 'popup' && opts.popup) {
    let prev = 0
    for (const r of opts.popup) {
      if (r.price_usd === null) continue
      out.push({
        country, center_name,
        weight_min: prev, weight_max: r.weight, weight_unit: unit,
        price_krw: null, price_usd: r.price_usd, price_jpy: null, price_cny: null, price_eur: null,
        shipping_type: 'air' as ShippingType,
        service_label,
        member_grade: '일반회원', grade_level: 1,
      })
      prev = r.weight
    }
  } else if (source === 'visible' && opts.visible) {
    let prev = 0
    for (const r of opts.visible) {
      if (r.platinum_usd !== null) {
        out.push({
          country, center_name,
          weight_min: prev, weight_max: r.weight, weight_unit: unit,
          price_krw: null, price_usd: r.platinum_usd, price_jpy: null, price_cny: null, price_eur: null,
          shipping_type: 'air' as ShippingType,
          service_label,
          member_grade: '플래티넘회원', grade_level: 2,
        })
      }
      prev = r.weight
    }
  }
  return out
}

export async function fetchMalltail(ctx: FetcherContext): Promise<{ rates: ParsedRate[]; raw_snapshot: string }> {
  const m = ctx.source_url.match(/\/price_list\/([A-Za-z]{2,3})\//)
  if (!m) throw new Error(`URL 에서 country 코드 추출 실패: ${ctx.source_url}`)
  const country = normalizeCountry(m[1])
  if (!country) throw new Error(`알 수 없는 country 코드: ${m[1]}`)

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

  const rates: ParsedRate[] = []

  // popup (full range, 일반회원)
  for (const suffix of [null, 'nj'] as const) {
    const idMarker = suffix ? `id="price_more_${suffix}"` : 'id="price_more"'
    const parsed = parsePopupTable(html, idMarker)
    if (!parsed || parsed.rows.length === 0) continue
    rates.push(...buildRates(country, { source: 'popup', suffix, unit: parsed.unit, popup: parsed.rows }))
  }

  // visible (limited range, 플래티넘회원만)
  for (const suffix of [null, 'nj'] as const) {
    const idMarker = suffix ? `id="box_price_new_${suffix}"` : 'id="box_price_new"'
    const parsed = parseVisibleTable(html, idMarker)
    if (!parsed || parsed.rows.length === 0) continue
    rates.push(...buildRates(country, { source: 'visible', suffix, unit: parsed.unit, visible: parsed.rows }))
  }

  if (rates.length === 0) throw new Error('가격표 div 미발견 또는 파싱 0행')
  return { rates, raw_snapshot: html }
}
