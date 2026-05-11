import type { ParsedRate } from './types'
import { renderAndGetHtml } from './playwright-helper'

/**
 * gajida — Vue SPA. 가격표는 단일 테이블, 3쌍 (파운드/가격/파운드/가격/파운드/가격) 행 형식.
 * 통화: USD ($). 무게: LB. 단일 등급(가입 사용자 기준).
 */
export async function fetchGajida(): Promise<{ rates: ParsedRate[]; raw_snapshot: string }> {
  const html = await renderAndGetHtml('https://www.gajida.net/info/service/2', {
    postLoadWaitMs: 4000,
    timeoutMs: 60_000,
  })
  // 첫 테이블 사용
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/i)
  if (!tableMatch) throw new Error('가격표 미발견')
  const t = tableMatch[0]
  const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
  const rates: ParsedRate[] = []
  // 첫 행은 헤더(파운드/가격/파운드/가격...) — 스킵
  // 데이터 행: weight, price, weight, price, weight, price (3 쌍)
  const allWeights: { w: number; price: number }[] = []
  for (let i = 1; i < rows.length; i++) {
    const cells = [...rows[i][0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
    )
    // 셀 짝수 인덱스 = weight, 홀수 = price
    for (let j = 0; j + 1 < cells.length; j += 2) {
      const wMatch = cells[j].match(/([\d.]+)/)
      const pMatch = cells[j + 1].match(/\$\s*([\d.,]+)|([\d.,]+)/)
      if (!wMatch || !pMatch) continue
      const w = Number(wMatch[1])
      const priceStr = pMatch[1] ?? pMatch[2]
      const price = Number(priceStr?.replace(/,/g, ''))
      if (!Number.isFinite(w) || !Number.isFinite(price)) continue
      allWeights.push({ w, price })
    }
  }
  // 중량 기준 정렬 후 weight_min 누적
  allWeights.sort((a, b) => a.w - b.w)
  let prev = 0
  for (const { w, price } of allWeights) {
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
  if (rates.length === 0) throw new Error('파싱 0행')
  return { rates, raw_snapshot: html }
}
