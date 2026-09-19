import { createAdminClient } from '@/lib/auth/admin-supabase'

export type Currency = 'USD' | 'JPY' | 'CNY' | 'EUR'
export const TRACKED_CURRENCIES: Currency[] = ['USD', 'JPY', 'CNY', 'EUR']

// 네이버 증권 환율 상세 API(하나은행 고시 매매기준율)의 reutersCode 매핑.
// JPY는 100엔 단위로 고시되므로 1엔 단위로 환산 저장.
const NAVER_FX_CODE: Record<Currency, string> = {
  USD: 'FX_USDKRW',
  JPY: 'FX_JPYKRW',
  CNY: 'FX_CNYKRW',
  EUR: 'FX_EURKRW',
}

const NAVER_UNIT_DIVISOR: Record<Currency, number> = {
  USD: 1,
  JPY: 100,
  CNY: 1,
  EUR: 1,
}

export type ExchangeRate = {
  currency: Currency
  rate_krw: number
  source: string
  updated_at: string
}

export type ExchangeRateLog = {
  id: string
  currency: Currency
  rate_krw: number
  previous_rate_krw: number | null
  source: string
  status: 'success' | 'error'
  error_message: string | null
  triggered_by: string
  created_at: string
}

export type ExchangeRateHistoryRow = {
  currency: Currency
  rate_krw: number
  rate_date: string
}

const SOURCE_LABEL = 'naver_finance'

function formatIsoDate(d: Date): string {
  // Vercel 서버리스 함수의 로컬 타임존은 UTC. 국내 고시환율은 KST 기준 날짜로 저장해야
  // 자정 직후 cron이 전날 row를 덮어쓰는 문제가 없음.
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(kst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 잘못된 코드도 HTTP 200 + isSuccess:false 로 오므로 상태 코드가 아니라 본문으로 성공을 판정한다.
const NAVER_FX_DETAIL_URL = 'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode='

// 고시 단위가 바뀌면(JPY 100엔↔1엔) 100배 틀린 값이 전 사이트 비용 계산에 들어가므로 1단위 원화 기준으로 거른다.
const PLAUSIBLE_KRW: Record<Currency, [number, number]> = {
  USD: [500, 5000],
  JPY: [2, 50],
  CNY: [50, 1000],
  EUR: [500, 5000],
}

/** 네이버 증권 환율 상세 응답 → 1단위 원화 매매기준율. 형식·값이 이상하면 throw. */
export function parseNaverFxDetail(body: unknown, currency: Currency): number {
  const detail = body as { isSuccess?: unknown; result?: { reutersCode?: unknown; closePrice?: unknown } } | null
  const result = detail?.isSuccess === true ? detail.result : undefined
  if (!result || result.reutersCode !== NAVER_FX_CODE[currency]) {
    throw new Error(`네이버 증권 응답 형식 변경 가능성 (${currency})`)
  }
  const rate = parseFloat(String(result.closePrice ?? '').replace(/,/g, '')) / NAVER_UNIT_DIVISOR[currency]
  const [min, max] = PLAUSIBLE_KRW[currency]
  if (!Number.isFinite(rate) || rate < min || rate > max) {
    throw new Error(`${currency} 환율 값 이상: ${String(result.closePrice)} (1단위 허용 ${min}~${max}원)`)
  }
  return rate
}

async function fetchNaverRates(): Promise<{ rates: Map<Currency, number>; errors: Map<Currency, string> }> {
  const rates = new Map<Currency, number>()
  const errors = new Map<Currency, string>()
  await Promise.all(
    TRACKED_CURRENCIES.map(async (currency) => {
      try {
        const res = await fetch(`${NAVER_FX_DETAIL_URL}${NAVER_FX_CODE[currency]}`, {
          cache: 'no-store',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jimscanner/1.0)' },
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`네이버 증권 HTTP ${res.status}`)
        rates.set(currency, parseNaverFxDetail(await res.json(), currency))
      } catch (err) {
        errors.set(currency, err instanceof Error ? err.message : String(err))
      }
    }),
  )
  return { rates, errors }
}

/**
 * 현재 고시환율 반환. 네이버 증권(하나은행 고시)이 1차 소스. 통화별로 따로 받아 한 통화 실패가 나머지를 막지 않는다.
 * rateDate는 호출 시점의 KST 날짜.
 */
export async function fetchLatestRates(): Promise<{ rates: Map<Currency, number>; errors: Map<Currency, string>; rateDate: string }> {
  const { rates, errors } = await fetchNaverRates()
  return { rates, errors, rateDate: formatIsoDate(new Date()) }
}

type UpdateResult = {
  currency: Currency
  status: 'success' | 'error'
  rate_krw: number | null
  previous_rate_krw: number | null
  error_message: string | null
}

/**
 * 추적 통화 전체를 네이버 증권(하나은행 고시) 매매기준율로 갱신.
 * - jimscanner_exchange_rates (현재값) upsert
 * - jimscanner_exchange_rate_logs (운영 로그) insert
 * - jimscanner_exchange_rate_history (영업일별 트렌드) upsert
 */
export async function updateAllRates(triggeredBy: string): Promise<UpdateResult[]> {
  const supabase = createAdminClient()
  const results: UpdateResult[] = []

  // 통화별 실패는 errors 로 돌아오므로 여기서는 throw 하지 않는다.
  const { rates: rateMap, errors: rateErrors, rateDate } = await fetchLatestRates()

  for (const currency of TRACKED_CURRENCIES) {
    let previousRate: number | null = null

    try {
      const { data: existing } = await supabase
        .from('jimscanner_exchange_rates')
        .select('rate_krw')
        .eq('currency', currency)
        .maybeSingle()

      previousRate = existing?.rate_krw ?? null

      const newRate = rateMap.get(currency)
      if (newRate == null) {
        throw new Error(rateErrors.get(currency) ?? `API 응답에 ${currency} 환율이 없습니다.`)
      }

      const rounded = Math.round(newRate * 10000) / 10000

      const { error: upsertError } = await supabase
        .from('jimscanner_exchange_rates')
        .upsert(
          {
            currency,
            rate_krw: rounded,
            source: SOURCE_LABEL,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'currency' },
        )
      if (upsertError) throw new Error(`upsert 실패: ${upsertError.message}`)

      await supabase
        .from('jimscanner_exchange_rate_history')
        .upsert(
          {
            currency,
            rate_krw: rounded,
            rate_date: rateDate,
            source: SOURCE_LABEL,
          },
          { onConflict: 'currency,rate_date' },
        )

      await supabase.from('jimscanner_exchange_rate_logs').insert({
        currency,
        rate_krw: rounded,
        previous_rate_krw: previousRate,
        source: SOURCE_LABEL,
        status: 'success',
        triggered_by: triggeredBy,
      })

      results.push({
        currency,
        status: 'success',
        rate_krw: rounded,
        previous_rate_krw: previousRate,
        error_message: null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      await supabase.from('jimscanner_exchange_rate_logs').insert({
        currency,
        rate_krw: previousRate ?? 0,
        previous_rate_krw: previousRate,
        source: SOURCE_LABEL,
        status: 'error',
        error_message: message,
        triggered_by: triggeredBy,
      })

      results.push({
        currency,
        status: 'error',
        rate_krw: null,
        previous_rate_krw: previousRate,
        error_message: message,
      })
    }
  }

  return results
}

