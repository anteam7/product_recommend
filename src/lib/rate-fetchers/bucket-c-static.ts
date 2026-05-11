import type { FetcherContext, ParsedRate } from './types'
import { parseSimpleTable, pickTable, fetchHtml, type ColumnConfig } from './simple-table'

/**
 * 정적 HTML 이지만 구조가 약간 복잡한 사이트들 — 다중 테이블, 다중 country/shipping_type 등.
 *  ohmyzip / itemscout / bidpot / irasshaimase / buynifon
 *
 * SPA 사이트(geniezip / sevenzone / yesship / eldex / unition / jiggujiggu / gajida) 는 별도 Playwright 처리.
 */

// ────────────────────────────────────────────
// ohmyzip — 미국 (LBS, USD). 가격표 3개:
//   T2: 프라임 회원 (3 sub-grades)
//   T3: 일반 회원 (3 sub-grades)
//   T4: 통합 (4 grades) — T2/T3 의 요약이라 스킵해 중복 회피
// 각 sub-grade 는 service_label 로 회원 유형을 보존.
// ────────────────────────────────────────────
export async function fetchOhmyzip(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const rates: ParsedRate[] = []
  const variants: Array<{ tableIdx: number; service_label: string; grades: string[] }> = [
    {
      tableIdx: 2,
      service_label: '프라임 회원',
      grades: ['프라임 이코노미', '프라임 비지니스', '프라임 퍼스트'],
    },
    {
      tableIdx: 3,
      service_label: '일반 회원',
      grades: ['이코노미', '비지니스', '퍼스트'],
    },
  ]
  for (const v of variants) {
    const t = pickTable(html, v.tableIdx)
    if (!t) continue
    const cfg: ColumnConfig = {
      country: 'US',
      weightCol: 0,
      dataStartRow: 2, // r0=헤더, r1=등급명
      forceCurrency: 'usd',
      forceWeightUnit: 'lb',
      priceCols: v.grades.map((g, i) => ({
        colIndex: i + 1,
        member_grade: g,
        grade_level: i + 1,
        service_label: v.service_label,
      })),
    }
    rates.push(...parseSimpleTable(t, cfg))
  }
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// itemscout — 1 source URL = 1 country (CN or JP), 6 grades, KRW.
// URL 로 country 구분: guide_08.php(CN), guide_08_2.php(JP)
// 데이터 테이블은 T3 (가장 큰 테이블, 무게(kg) 시작 헤더).
// 무게 셀 형식 '~ 1.00' / '~ 1.50'
// ────────────────────────────────────────────
export async function fetchItemscout(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const country = /guide_08_2\.php/.test(ctx.source_url) ? 'JP' : 'CN'
  const t = pickTable(html, 3)
  if (!t) throw new Error('가격표 미발견')
  const grades = ['Bronze', 'Silver', 'Gold(사업자)', 'VIP(사업자)', 'VVIP(사업자)', 'DIAMOND']
  const cfg: ColumnConfig = {
    country,
    weightCol: 0,
    dataStartRow: 2, // r0=헤더, r1=등급별 부제목 (있으면)
    forceCurrency: 'krw',
    parseWeight: (text) => {
      // '~ 1.00', '~ 1.50' 형태 — 첫 숫자 추출
      const m = text.match(/[\d.,]+/)
      if (!m) return null
      const v = Number(m[0].replace(/,/g, ''))
      return Number.isFinite(v) ? { value: v, unit: 'kg' } : null
    },
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
// bidpot — 1 페이지에 3개 country 가격표 (미국 LBS+$, 일본 kg+¥, EU kg+€).
// 5 grades + 기본 요금. 컬럼: 무게/요금/신규/우수/VIP/VVIP/프리미엄.
// ────────────────────────────────────────────
export async function fetchBidpot(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const grades = ['신규', '우수', 'VIP', 'VVIP', '프리미엄']
  const variants: Array<{ tableIdx: number; country: string; currency: 'usd' | 'jpy' | 'eur'; unit: 'lb' | 'kg' }> = [
    { tableIdx: 1, country: 'US', currency: 'usd', unit: 'lb' },
    { tableIdx: 3, country: 'JP', currency: 'jpy', unit: 'kg' },
    { tableIdx: 5, country: 'EU', currency: 'eur', unit: 'kg' },
  ]
  const rates: ParsedRate[] = []
  for (const v of variants) {
    const t = pickTable(html, v.tableIdx)
    if (!t) continue
    const cfg: ColumnConfig = {
      country: v.country,
      weightCol: 0,
      dataStartRow: 1,
      forceCurrency: v.currency,
      forceWeightUnit: v.unit,
      priceCols: [
        { colIndex: 1, member_grade: '기본', grade_level: 0 },
        ...grades.map((g, i) => ({ colIndex: i + 2, member_grade: g, grade_level: i + 1 })),
      ],
    }
    rates.push(...parseSimpleTable(t, cfg))
  }
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// irasshaimase — 일본직구. T0+T1: gram 단위 무게, 5개 운송수단 컬럼.
// 무게 셀 표기: '500'(=500g), '1000', '35.5K'(=35.5kg=35500g), 등
// ────────────────────────────────────────────
export async function fetchIrasshaimase(ctx: FetcherContext) {
  const html = await fetchHtml(ctx.source_url)
  const rates: ParsedRate[] = []
  const shippingTypeMap: Array<{ idx: number; type: 'air' | 'marine' | 'express'; label: string }> = [
    { idx: 1, type: 'express', label: 'EMS' },
    { idx: 2, type: 'air', label: '항공일반' },
    { idx: 3, type: 'air', label: '항공특송' },
    { idx: 4, type: 'marine', label: '해운일반' },
    { idx: 5, type: 'marine', label: '해운특수' },
  ]
  for (const tableIdx of [0, 1]) {
    const t = pickTable(html, tableIdx)
    if (!t) continue
    const cfg: ColumnConfig = {
      country: 'JP',
      weightCol: 0,
      dataStartRow: 1,
      forceCurrency: 'jpy',
      parseWeight: (text) => {
        const m = text.match(/([\d.,]+)\s*([Kk])?/)
        if (!m) return null
        const v = Number(m[1].replace(/,/g, ''))
        if (!Number.isFinite(v)) return null
        const grams = m[2] ? v * 1000 : v
        return { value: grams / 1000, unit: 'kg' }
      },
      priceCols: shippingTypeMap.map((s) => ({
        colIndex: s.idx,
        member_grade: '일반',
        grade_level: 1,
        shipping_type: s.type,
        service_label: s.label,
      })),
    }
    const r = parseSimpleTable(t, cfg)
    // 빈 셀('-') 필터링은 parseSimpleTable 가 NUM regex 로 자동 처리됨
    rates.push(...r)
  }
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

// ────────────────────────────────────────────
// buynifon — 일본직구. 가격표 URL 별도 (/Front/Introduction/DlvrMny.asp).
// 단일 테이블, 비로그인은 일반 등급만 노출. 100 행. KRW.
// info_sources 의 rates URL 미등록 → ctx.source_url 무시하고 하드코딩.
// ────────────────────────────────────────────
const BUYNIFON_RATE_URL = 'http://www.buynifon.com/Front/Introduction/DlvrMny.asp?gMnu1=201&gMnu2=20105'

export async function fetchBuynifon(_ctx: FetcherContext) {
  const html = await fetchHtml(BUYNIFON_RATE_URL)
  const t = pickTable(html, 0)
  if (!t) throw new Error('가격표 미발견')
  const cfg: ColumnConfig = {
    country: 'JP',
    weightCol: 0,
    dataStartRow: 1,
    forceCurrency: 'krw',
    priceCols: [
      { colIndex: 1, member_grade: '일반', grade_level: 1 },
      // VIP / VVIP 컬럼은 비로그인 시 빈 칸이라 자동 스킵
    ],
  }
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}
