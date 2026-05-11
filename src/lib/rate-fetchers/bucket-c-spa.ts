import type { FetcherContext, ParsedRate } from './types'
import { renderAndGetHtml } from './playwright-helper'
import { fetchHtml, parseSimpleTable, pickTable, type ColumnConfig } from './simple-table'

/**
 * 버킷 C SPA / API — Playwright 또는 직접 API 호출이 필요한 사이트들.
 *
 * 현재 구현:
 *   geniezip — 내부 ajax 직접 호출 (Playwright 불필요)
 *   unition  — Playwright + 페이지네이션
 *   sevenzone, yesship, jiggujiggu, gajida — Playwright 렌더 후 정적 파서 재사용
 *
 * 미구현 (추후): eldex, eldex_jp, jikgu, ehanex(login)
 */

// ────────────────────────────────────────────────────────────
// geniezip (지니집) — /geniezipLamp/shipListInfoAjax.do?countryCd=NN
//   응답 = { shippingList: [{WEIGHT_FROM, WEIGHT_TO, DELI_AMT, COUNTY_CD, CURRENCY_UNIT}, ...] }
//   CURRENCY_UNIT='01' = USD (페이지 UI 와 데이터로 검증)
// 매핑 (페이지 탭과 data-date 100001~100011 / countryCd 01~11 추정):
//   01 = US (LA), 02 = US (OR), 03 = US (NJ), 04 = DE, 05 = UK,
//   06 = JP, 07 = FR, 08 = HK, 09 = OTHER (매핑 불명, 데이터 보존), 11 = CN (API 빈값 — 미수집)
// ────────────────────────────────────────────────────────────

type GeniezipCountryMap = { country: string; center: string | null }
const GENIEZIP_COUNTRY: Record<string, GeniezipCountryMap> = {
  '01': { country: 'US', center: 'LA' },
  '02': { country: 'US', center: 'OR' },
  '03': { country: 'US', center: 'NJ' },
  '04': { country: 'DE', center: null },
  '05': { country: 'UK', center: null },
  '06': { country: 'JP', center: null },
  '07': { country: 'FR', center: null },
  '08': { country: 'HK', center: null },
  '09': { country: 'OTHER', center: null }, // 페이지 매핑 불명
}

type GeniezipItem = {
  WEIGHT_FROM: number
  WEIGHT_TO: number
  DELI_AMT: number
  COUNTY_CD: string
  CURRENCY_UNIT: string
}

export async function fetchGeniezip(_ctx: FetcherContext) {
  const rates: ParsedRate[] = []
  const allResponses: { cd: string; items: GeniezipItem[] }[] = []
  for (const cd of Object.keys(GENIEZIP_COUNTRY)) {
    const r = await fetch(
      `https://www.geniezip.com/geniezipLamp/shipListInfoAjax.do?ipass=yes&countryCd=${cd}`,
      { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jimscanner-bot/1.0)' } },
    )
    if (!r.ok) throw new Error(`geniezip API HTTP ${r.status} for cd=${cd}`)
    const json = (await r.json()) as { shippingList?: GeniezipItem[] }
    const items = json.shippingList ?? []
    allResponses.push({ cd, items })
    const map = GENIEZIP_COUNTRY[cd]
    for (const it of items) {
      const wMin = Number(it.WEIGHT_FROM)
      const wMax = Number(it.WEIGHT_TO)
      const price = Number(it.DELI_AMT)
      if (!Number.isFinite(wMin) || !Number.isFinite(wMax) || !Number.isFinite(price)) continue
      rates.push({
        country: map.country,
        center_name: map.center,
        weight_min: wMin,
        weight_max: wMax,
        weight_unit: 'kg',
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
    }
  }
  if (rates.length === 0) throw new Error('geniezip API 응답 비어있음')
  return { rates, raw_snapshot: JSON.stringify(allResponses) }
}

// ────────────────────────────────────────────────────────────
// unition (유니옥션) — Playwright + 페이지네이션.
// URL 형태: https://v5.uniauc.com/fees/{country}/{shipping_type}
//   country: US/CN/JP/DE
//   shipping_type: air/marine
// 페이지네이션: 1, 2, ... 페이지 버튼 클릭하며 누적
// 등급: LV0..LV10 + 프라임 (총 12 등급)
// ────────────────────────────────────────────────────────────
export async function fetchUnition(ctx: FetcherContext) {
  // URL 파싱
  const m = ctx.source_url.match(/\/fees\/([A-Z]{2})\/(air|marine)/)
  if (!m) throw new Error(`URL 파싱 실패: ${ctx.source_url}`)
  const country = m[1] // US/CN/JP/DE
  const shipping_type = m[2] === 'air' ? 'air' : 'marine'
  // 무게 단위: US 는 LB, 그 외는 kg (실제 데이터 확인 후 보정)
  const weight_unit: 'lb' | 'kg' = country === 'US' ? 'lb' : 'kg'

  const { renderUnitionAllPages } = await import('./unition-helper')
  const { rates, raw } = await renderUnitionAllPages(ctx.source_url, country, weight_unit, shipping_type)
  return { rates, raw_snapshot: raw }
}

// ────────────────────────────────────────────────────────────
// 일반화: Playwright 렌더 후 첫 가격표 파싱
//   sevenzone, yesship 등 등급 구조 단순한 사이트용
// ────────────────────────────────────────────────────────────
async function fetchRenderedSimple(
  ctx: FetcherContext,
  cfg: ColumnConfig,
  opts: { tableIndex?: number; postLoadWaitMs?: number; waitForSelector?: string } = {},
) {
  const html = await renderAndGetHtml(ctx.source_url, {
    postLoadWaitMs: opts.postLoadWaitMs ?? 4000,
    waitForSelector: opts.waitForSelector,
    timeoutMs: 60_000,
  })
  const t = pickTable(html, opts.tableIndex ?? 0)
  if (!t) throw new Error('가격표 미발견')
  const rates = parseSimpleTable(t, cfg)
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}

export { fetchRenderedSimple }

// ────────────────────────────────────────────────────────────
// jiggujiggu — Playwright + 페이지네이션 (BootstrapVue 형 가격표)
// ────────────────────────────────────────────────────────────
export async function fetchJiggujiggu(_ctx: FetcherContext) {
  const { fetchJiggujiggu: impl } = await import('./jiggujiggu-helper')
  return impl()
}

// ────────────────────────────────────────────────────────────
// gajida — Vue SPA, 단일 테이블 3쌍 weight/price 행
// ────────────────────────────────────────────────────────────
export async function fetchGajida(_ctx: FetcherContext) {
  const { fetchGajida: impl } = await import('./gajida-helper')
  return impl()
}
