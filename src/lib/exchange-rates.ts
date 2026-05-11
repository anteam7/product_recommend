import { createAdminClient } from '@/lib/auth/admin-supabase'

export type Currency = 'USD' | 'JPY' | 'CNY' | 'EUR'
export const TRACKED_CURRENCIES: Currency[] = ['USD', 'JPY', 'CNY', 'EUR']

// 네이버 금융 환율 테이블의 marketindexCd 매핑.
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

/**
 * 네이버 금융 고시환율 페이지에서 현재 매매기준율 조회.
 * 페이지는 euc-kr 인코딩이지만 marketindexCd·숫자 모두 ASCII라 바이트 보존(latin1) 디코딩이면 파싱 가능.
 */
async function fetchNaverRates(): Promise<Map<Currency, number>> {
  const res = await fetch('https://finance.naver.com/marketindex/exchangeList.naver', {
    cache: 'no-store',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jimscanner/1.0)' },
  })
  if (!res.ok) {
    throw new Error(`네이버 금융 HTTP ${res.status}`)
  }

  const buf = await res.arrayBuffer()
  const html = Buffer.from(buf).toString('latin1')

  const rateMap = new Map<Currency, number>()
  for (const currency of TRACKED_CURRENCIES) {
    const code = NAVER_FX_CODE[currency]
    const divisor = NAVER_UNIT_DIVISOR[currency]
    const re = new RegExp(`marketindexCd=${code}[\\s\\S]*?<td class="sale">([\\d,.]+)</td>`)
    const match = re.exec(html)
    if (!match) continue
    const raw = parseFloat(match[1].replace(/,/g, ''))
    if (!Number.isFinite(raw) || raw <= 0) continue
    rateMap.set(currency, raw / divisor)
  }

  if (rateMap.size === 0) {
    throw new Error('네이버 금융 응답에서 환율 파싱 실패 (페이지 구조 변경 가능성)')
  }

  return rateMap
}

/**
 * 현재 고시환율 반환. 네이버 금융이 1차 소스.
 * rateDate는 호출 시점의 날짜 (네이버 페이지엔 명시적 고시일 파싱이 어려움).
 */
export async function fetchLatestRates(): Promise<{ rates: Map<Currency, number>; rateDate: string }> {
  const rates = await fetchNaverRates()
  return { rates, rateDate: formatIsoDate(new Date()) }
}

type UpdateResult = {
  currency: Currency
  status: 'success' | 'error'
  rate_krw: number | null
  previous_rate_krw: number | null
  error_message: string | null
}

/**
 * 추적 통화 전체를 한국수출입은행 매매기준율로 갱신.
 * - jimscanner_exchange_rates (현재값) upsert
 * - jimscanner_exchange_rate_logs (운영 로그) insert
 * - jimscanner_exchange_rate_history (영업일별 트렌드) upsert
 */
export async function updateAllRates(triggeredBy: string): Promise<UpdateResult[]> {
  const supabase = createAdminClient()
  const results: UpdateResult[] = []

  let rateMap: Map<Currency, number> | null = null
  let rateDate: string | null = null
  let fetchError: string | null = null

  try {
    const latest = await fetchLatestRates()
    rateMap = latest.rates
    rateDate = latest.rateDate
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  for (const currency of TRACKED_CURRENCIES) {
    let previousRate: number | null = null

    try {
      const { data: existing } = await supabase
        .from('jimscanner_exchange_rates')
        .select('rate_krw')
        .eq('currency', currency)
        .maybeSingle()

      previousRate = existing?.rate_krw ?? null

      if (fetchError) throw new Error(fetchError)
      if (!rateMap || !rateDate) throw new Error('환율 데이터 로드 실패')

      const newRate = rateMap.get(currency)
      if (newRate == null) {
        throw new Error(`API 응답에 ${currency} 환율이 없습니다.`)
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

