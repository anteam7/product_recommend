import type { FetcherContext, ParsedRate } from './types'
import { parseSimpleTable, pickTable, fetchHtml, type ColumnConfig } from './simple-table'

/**
 * 버킷 B (정적 HTML) — 7 사이트 파서.
 * 각 사이트별로 ColumnConfig 만 다르고 단일 테이블 처리 흐름은 동일.
 */

// ────────────────────────────────────────────
// woomyshipping (우마이직구) — 일본직구. 단일 테이블, 4 등급, ¥ 우선 ₩ 병기.
// ────────────────────────────────────────────
export async function fetchWoomyshipping(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const t = pickTable(html, 0)
  if (!t) throw new Error('가격표 미발견')
  const cfg: ColumnConfig = {
    country: 'JP',
    weightCol: 0,
    dataStartRow: 1,
    forceCurrency: 'jpy', // ¥ 가격 우선 — 셀 텍스트에 ¥ 와 ₩ 둘 다 있어 명시
    parseWeight: (text) => {
      // '~ 0.50' / '~ 1.00' 형태
      const m = text.match(/[\d.,]+/)
      if (!m) return null
      const v = Number(m[0].replace(/,/g, ''))
      return Number.isFinite(v) ? { value: v, unit: 'kg' } : null
    },
    priceCols: [
      { colIndex: 1, member_grade: '일반',     grade_level: 1 },
      { colIndex: 2, member_grade: '골드',     grade_level: 2 },
      { colIndex: 3, member_grade: 'VIP',      grade_level: 3 },
      { colIndex: 4, member_grade: '사업자 회원', grade_level: 4 },
    ],
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// kenzpost — 일본직구. 중량 g, 3 운송수단(FedExIP/항공특송/해운특송) JPY.
// 두 개 테이블 (T0, T1) 이 같은 구조 — T0 만 사용.
// 'K' 접미사 = 1000g 변환 (예: '1K' = 1kg, '500' = 500g)
// ────────────────────────────────────────────
export async function fetchKenzpost(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const t = pickTable(html, 0)
  if (!t) throw new Error('가격표 미발견')
  const cfg: ColumnConfig = {
    country: 'JP',
    weightCol: 0,
    dataStartRow: 2, // r0=헤더, r1=배송기간 sub-header
    forceCurrency: 'jpy',
    parseWeight: (text) => {
      const m = text.match(/([\d.,]+)\s*([kK])?/)
      if (!m) return null
      const v = Number(m[1].replace(/,/g, ''))
      if (!Number.isFinite(v)) return null
      const isK = !!m[2]
      const grams = isK ? v * 1000 : v
      return { value: grams / 1000, unit: 'kg' }
    },
    priceCols: [
      { colIndex: 1, member_grade: '일반', grade_level: 1, shipping_type: 'express', service_label: 'FedExIP' },
      { colIndex: 2, member_grade: '일반', grade_level: 1, shipping_type: 'air',     service_label: '켄즈항공특송' },
      { colIndex: 3, member_grade: '일반', grade_level: 1, shipping_type: 'marine',  service_label: '켄즈해운특송' },
    ],
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// postteam — 1688 중심 (CN 가능성). 단일 테이블 4001행, KRW, 4 등급.
// ────────────────────────────────────────────
export async function fetchPostteam(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const t = pickTable(html, 0)
  if (!t) throw new Error('가격표 미발견')
  const cfg: ColumnConfig = {
    country: 'CN',
    weightCol: 0,
    dataStartRow: 2, // r0=헤더, r1=이용건수 sub-header
    forceCurrency: 'krw',
    priceCols: [
      { colIndex: 1, member_grade: '개인 일반 회원',   grade_level: 1 },
      { colIndex: 2, member_grade: '개인 파트너 회원', grade_level: 2 },
      { colIndex: 3, member_grade: '사업자 일반 회원', grade_level: 3 },
      { colIndex: 4, member_grade: '사업자 파트너 회원', grade_level: 4 },
    ],
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// joypost — 일본직구. T0 단일 테이블, 11 등급 (일반 + WHITE..PLATINUM), JPY.
// ────────────────────────────────────────────
export async function fetchJoypost(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const t = pickTable(html, 0)
  if (!t) throw new Error('가격표 미발견')
  const grades = ['일반', 'WHITE', 'PINK', 'YELLOW', 'BLUE', 'SILVER', 'GREEN', 'GOLD', 'BLACK', 'VIOLET', 'PLATINUM']
  const cfg: ColumnConfig = {
    country: 'JP',
    weightCol: 0,
    dataStartRow: 3, // r0=헤더, r1=할인율, r2=등업조건
    forceCurrency: 'jpy',
    priceCols: grades.map((g, i) => ({
      colIndex: i + 1,
      member_grade: g,
      grade_level: i + 1,
    })),
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// twofasts — 미국직구 추정 (LBS+$). 9 등급+특수 서비스 컬럼.
// 컬럼: 무게(lbs), 브론즈, 실버, 골드, 루비, 다이아몬드, 플래티넘, ZERO, 깡통배송, 해외쇼핑
// ────────────────────────────────────────────
export async function fetchTwofasts(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const t = pickTable(html, 6) // T6 가 가격표
  if (!t) throw new Error('가격표 미발견')
  const grades = ['브론즈', '실버', '골드', '루비', '다이아몬드', '플래티넘', 'ZERO']
  const specials = [
    { idx: 8, label: '깡통배송' },
    { idx: 9, label: '해외쇼핑' },
  ]
  const cfg: ColumnConfig = {
    country: 'US',
    weightCol: 0,
    dataStartRow: 1,
    forceCurrency: 'usd',
    forceWeightUnit: 'lb',
    priceCols: [
      ...grades.map((g, i) => ({
        colIndex: i + 1,
        member_grade: g,
        grade_level: i + 1,
      })),
      ...specials.map((s, i) => ({
        colIndex: s.idx,
        member_grade: '일반',
        grade_level: 1,
        service_label: s.label,
        // shipping_type 추정 안 함 — 'air' 기본
      })),
    ],
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// hoyausa — 미국직구. 단일 가격표 (T16), 9 등급, USD/LBS.
// 헤더 구조: r0 = ['무게(LBS)', '회원 등급별 배송요금($)'] (colspan)
//            r1 = 9 grade names
//            r2+ = data: weight + 9 prices
// ────────────────────────────────────────────
export async function fetchHoyausa(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const t = pickTable(html, 16)
  if (!t) throw new Error('가격표 미발견')
  const grades = [
    '호야씨앗(신규가입)',
    '호야새싹(1~5건)',
    '호야잎새(6~20건)',
    '호야가지(21~40건)',
    '호야열매(41~60건)',
    '호야나무(61~80건)',
    '호야숲(81~100건)',
    'VIP(101~150건)',
    'VVIP(150건 초과)',
  ]
  const cfg: ColumnConfig = {
    country: 'US',
    weightCol: 0,
    dataStartRow: 2,
    forceCurrency: 'usd',
    forceWeightUnit: 'lb',
    priceCols: grades.map((g, i) => ({
      colIndex: i + 1,
      member_grade: g,
      grade_level: i + 1,
    })),
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// postgo — 미국직구 (LBS+$). 20 테이블 페이징 (1-15, 16-30, ..., 286-300).
// 모든 테이블 합쳐서 하나의 요금표로 처리. 각 테이블 행 형식:
//   ["1", "＄1 --> ＄9.20"]
// 가격은 "--> ＄X.XX" 부분에서 추출.
// ────────────────────────────────────────────
export async function fetchPostgo(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const tables = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)]
    .map((m) => m[0])
    .filter((t) => /무게\(LB\)/.test(t) && /<tr/i.test(t))
  if (tables.length === 0) throw new Error('가격표 미발견')

  const rates: ParsedRate[] = []
  let prev = 0
  for (const t of tables) {
    const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    for (let r = 1; r < rows.length; r++) {
      const cells = [...rows[r][0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
        m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
      )
      if (cells.length < 2) continue
      const w = Number(cells[0].replace(/,/g, ''))
      if (!Number.isFinite(w)) continue
      // "$1 --> $9.20" → 9.20 추출 (--> 뒤의 숫자)
      const priceMatch = cells[1].match(/-->\s*[＄$]\s*([\d.,]+)/)
      if (!priceMatch) continue
      const price = Number(priceMatch[1].replace(/,/g, ''))
      if (!Number.isFinite(price)) continue
      rates.push({
        country: 'US',
        center_name: null,
        weight_min: prev,
        weight_max: w,
        weight_unit: 'lb',
        price_krw: null,
        price_usd: price,
        price_jpy: null,
        price_cny: null,
        price_eur: null,
        shipping_type: 'air',
        service_label: null,
        member_grade: '일반',
        grade_level: 1,
      })
      prev = w
    }
  }

  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}
