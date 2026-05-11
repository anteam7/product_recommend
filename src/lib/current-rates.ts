import { cache } from 'react'
import { supabase } from '@/lib/supabase'

export type CurrencyRates = {
  USD: number
  JPY: number
  CNY: number
  EUR: number
  updated_at: string | null
}

// API 장애·데이터 없음 대비 폴백값 (2026-04-19 시점 수출입은행 매매기준율 근사)
const FALLBACK: CurrencyRates = {
  USD: 1472.6,
  JPY: 9.25,
  CNY: 216,
  EUR: 1735,
  updated_at: null,
}

/**
 * 서버 컴포넌트·API 라우트 공통 환율 조회.
 * jimscanner_exchange_rates 테이블의 최신값을 가져옴 (RLS anon read 허용됨).
 *
 * React cache()로 래핑 — 한 렌더 사이클 내에서 generateMetadata와 page()가
 * 모두 호출해도 DB는 단 1회만 왕복. 요청 간 캐시는 상위 ISR(revalidate)에 의존.
 */
export const getCurrentRates = cache(async (): Promise<CurrencyRates> => {
  const { data } = await supabase
    .from('jimscanner_exchange_rates')
    .select('currency, rate_krw, updated_at')
    .in('currency', ['USD', 'JPY', 'CNY', 'EUR'])

  if (!data || data.length === 0) return FALLBACK

  const rates: CurrencyRates = { ...FALLBACK, updated_at: null }
  let lastUpdated = ''
  for (const row of data) {
    const cur = row.currency as keyof CurrencyRates
    if (cur === 'updated_at') continue
    if (typeof row.rate_krw === 'number' && row.rate_krw > 0) {
      rates[cur] = row.rate_krw
    }
    if (typeof row.updated_at === 'string' && row.updated_at > lastUpdated) {
      lastUpdated = row.updated_at
    }
  }
  rates.updated_at = lastUpdated || null
  return rates
})

type PriceInput = {
  price_krw?: number | null
  price_usd?: number | null
  price_jpy?: number | null
  price_cny?: number | null
}

/**
 * 요금 행에서 KRW 가격을 현재 환율로 재계산.
 * 우선순위: USD > JPY > CNY > 이미 저장된 KRW
 * - 외환 원천 가격이 있으면 현재 환율로 실시간 환산 (전면 실시간)
 * - 전부 없으면 DB의 price_krw 그대로 사용
 */
export function computeKrw(rate: PriceInput, rates: CurrencyRates): number | null {
  if (rate.price_usd != null && rate.price_usd > 0) {
    return Math.round(rate.price_usd * rates.USD)
  }
  if (rate.price_jpy != null && rate.price_jpy > 0) {
    return Math.round(rate.price_jpy * rates.JPY)
  }
  if (rate.price_cny != null && rate.price_cny > 0) {
    return Math.round(rate.price_cny * rates.CNY)
  }
  return rate.price_krw ?? null
}

export function formatRateDate(iso: string | null): string {
  if (!iso) return '참고 환율'
  const d = new Date(iso)
  return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })
}
