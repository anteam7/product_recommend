import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  TRACKED_CURRENCIES,
  type Currency,
  type ExchangeRate,
  type ExchangeRateLog,
  type ExchangeRateHistoryRow,
} from '@/lib/exchange-rates'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import ManualUpdateButton from './ManualUpdateButton'

export const dynamic = 'force-dynamic'

function formatKST(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatShortDate(iso: string) {
  const [y, m, d] = iso.split('-')
  return `${y}-${m}-${d}`
}

function formatRate(rate: number, currency: Currency) {
  const scale = currency === 'JPY' ? 100 : 1
  return (rate * scale).toLocaleString('ko-KR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

export default async function ExchangeRatesPage() {
  const supabase = createAdminClient()

  const { data: rates } = await supabase
    .from('jimscanner_exchange_rates')
    .select('*')
    .in('currency', TRACKED_CURRENCIES)
    .order('currency')

  const { data: logs } = await supabase
    .from('jimscanner_exchange_rate_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  const { data: historyRaw } = await supabase
    .from('jimscanner_exchange_rate_history')
    .select('currency, rate_krw, rate_date')
    .order('rate_date', { ascending: false })
    .limit(200)

  const rateList = (rates ?? []) as ExchangeRate[]
  const logList = (logs ?? []) as ExchangeRateLog[]
  const historyList = (historyRaw ?? []) as ExchangeRateHistoryRow[]

  const lastCronLog = logList.find((l) => l.triggered_by === 'cron') ?? null
  const cronAgeHours = lastCronLog
    ? (Date.now() - new Date(lastCronLog.created_at).getTime()) / 3_600_000
    : null
  const cronHealth: 'ok' | 'stale' | 'error' | 'unknown' = !lastCronLog
    ? 'unknown'
    : lastCronLog.status !== 'success'
      ? 'error'
      : cronAgeHours != null && cronAgeHours > 25
        ? 'stale'
        : 'ok'

  const historyByCurrencyDate = new Map<string, number>()
  for (const h of historyList) {
    historyByCurrencyDate.set(`${h.currency}|${h.rate_date}`, h.rate_krw)
  }
  const historyDates = Array.from(new Set(historyList.map((h) => h.rate_date))).sort((a, b) =>
    b.localeCompare(a),
  )

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">환율 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            매일 자동 갱신 · 출처 네이버 금융 매매기준율 (하나은행 기준)
          </p>
          <div className="mt-2">
            {cronHealth === 'ok' && lastCronLog && (
              <Badge className="bg-green-600 font-normal">
                크론 정상 · 마지막 실행 {formatKST(lastCronLog.created_at)} ({cronAgeHours!.toFixed(1)}시간 전)
              </Badge>
            )}
            {cronHealth === 'stale' && lastCronLog && (
              <Badge className="bg-amber-500 font-normal" title="25시간 이상 실행 없음">
                크론 지연 · 마지막 {formatKST(lastCronLog.created_at)} ({cronAgeHours!.toFixed(1)}시간 전)
              </Badge>
            )}
            {cronHealth === 'error' && lastCronLog && (
              <Badge className="bg-red-600 font-normal" title={lastCronLog.error_message ?? ''}>
                크론 마지막 실행 실패 · {formatKST(lastCronLog.created_at)}
              </Badge>
            )}
            {cronHealth === 'unknown' && (
              <Badge className="bg-gray-500 font-normal">크론 실행 기록 없음</Badge>
            )}
          </div>
        </div>
        <ManualUpdateButton />
      </div>

      {/* 현재 환율 */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">적용 중인 환율</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {rateList.length === 0 ? (
            <Card className="sm:col-span-2 border-amber-200 bg-amber-50">
              <CardContent className="pt-6 text-sm text-amber-900">
                아직 환율 데이터가 없습니다. Supabase Dashboard의 SQL Editor에서{' '}
                <code className="bg-white px-1.5 py-0.5 rounded border">supabase/exchange_rates.sql</code>{' '}
                을 실행해 주세요.
              </CardContent>
            </Card>
          ) : (
            rateList.map((rate) => (
              <Card key={rate.currency}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    1 {rate.currency} ={' '}
                    <span className="text-blue-600 font-bold">
                      {rate.rate_krw.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}
                    </span>{' '}
                    <span className="text-gray-500 text-sm">KRW</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-gray-500 space-y-0.5">
                  <p>출처: {rate.source}</p>
                  <p>마지막 갱신: {formatKST(rate.updated_at)}</p>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </section>

      {/* 영업일별 매매기준율 히스토리 */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            영업일별 매매기준율 (최근 {historyDates.length}영업일)
          </h2>
          <span className="text-xs text-gray-500">
            총 {historyList.length}건 · JPY는 100엔 단위 표시
          </span>
        </div>
        {historyDates.length === 0 ? (
          <div className="text-sm text-gray-500 bg-white border rounded-lg p-6 text-center">
            아직 히스토리가 없습니다. &quot;지금 업데이트&quot; 버튼으로 최초 데이터를 수집하세요.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-gray-50 border-b sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    날짜
                  </th>
                  {TRACKED_CURRENCIES.map((cur) => (
                    <th
                      key={cur}
                      className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase"
                    >
                      {cur}
                      {cur === 'JPY' && (
                        <span className="text-gray-400 font-normal"> (100)</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {historyDates.map((date, rowIdx) => {
                  const prevDate = historyDates[rowIdx + 1]
                  return (
                    <tr key={date} className="border-b last:border-b-0">
                      <td className="px-4 py-2 text-gray-700 whitespace-nowrap font-medium">
                        {formatShortDate(date)}
                      </td>
                      {TRACKED_CURRENCIES.map((cur) => {
                        const rate = historyByCurrencyDate.get(`${cur}|${date}`)
                        const prevRate = prevDate
                          ? historyByCurrencyDate.get(`${cur}|${prevDate}`)
                          : undefined
                        const diff =
                          rate != null && prevRate != null ? rate - prevRate : null
                        const up = diff != null && diff > 0
                        const down = diff != null && diff < 0
                        return (
                          <td
                            key={cur}
                            className="px-4 py-2 text-right font-mono whitespace-nowrap"
                          >
                            {rate != null ? (
                              <>
                                <span className="text-gray-900">
                                  {formatRate(rate, cur)}
                                </span>
                                {diff != null && diff !== 0 && (
                                  <span
                                    className={`ml-1 text-[10px] ${
                                      up ? 'text-red-600' : down ? 'text-blue-600' : 'text-gray-400'
                                    }`}
                                  >
                                    {up ? '▲' : '▼'}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">
          ▲ 전일 대비 상승 · ▼ 전일 대비 하락. 공휴일·주말 등 API 비공시일은 누락됩니다.
        </p>
      </section>

      {/* 전체 로그 */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">업데이트 이력 (최근 50건)</h2>
          <span className="text-xs text-gray-500">총 {logList.length}건</span>
        </div>
        {logList.length === 0 ? (
          <div className="text-sm text-gray-500 bg-white border rounded-lg p-6 text-center">
            기록된 로그가 없습니다.
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">시각 (KST)</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">통화</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">이전</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">새 요율</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">변동</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">트리거</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">상태</th>
                </tr>
              </thead>
              <tbody>
                {logList.map((log) => {
                  const diff =
                    log.previous_rate_krw != null && log.status === 'success'
                      ? log.rate_krw - log.previous_rate_krw
                      : null
                  const diffPct =
                    diff != null && log.previous_rate_krw
                      ? (diff / log.previous_rate_krw) * 100
                      : null

                  return (
                    <tr key={log.id} className="border-b last:border-b-0">
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {formatKST(log.created_at)}
                      </td>
                      <td className="px-4 py-2 font-medium">{log.currency}</td>
                      <td className="px-4 py-2 text-right font-mono text-gray-500">
                        {log.previous_rate_krw != null
                          ? log.previous_rate_krw.toLocaleString('ko-KR', { maximumFractionDigits: 4 })
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {log.status === 'success'
                          ? log.rate_krw.toLocaleString('ko-KR', { maximumFractionDigits: 4 })
                          : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-xs whitespace-nowrap">
                        {diff == null ? (
                          <span className="text-gray-400">—</span>
                        ) : diff === 0 ? (
                          <span className="text-gray-500">0</span>
                        ) : diff > 0 ? (
                          <span className="text-red-600">
                            +{diff.toFixed(2)} ({diffPct?.toFixed(2)}%)
                          </span>
                        ) : (
                          <span className="text-blue-600">
                            {diff.toFixed(2)} ({diffPct?.toFixed(2)}%)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600 whitespace-nowrap">
                        {log.triggered_by}
                      </td>
                      <td className="px-4 py-2">
                        {log.status === 'success' ? (
                          <Badge className="bg-green-600">success</Badge>
                        ) : (
                          <Badge className="bg-red-600" title={log.error_message ?? ''}>
                            error
                          </Badge>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">자동 갱신 일정</p>
        <p>
          Supabase pg_cron이 매일 한국 시간 00:10에 <code className="bg-white px-1.5 py-0.5 rounded border">/api/cron/update-rates</code> 를 호출합니다.
          네이버 금융(하나은행 고시 기준)은 매일 여러 차례 갱신되며, 주말·공휴일에는 직전 영업일 고시치가 유지됩니다.
          JPY는 100엔 단위로 고시되는 원본을 1엔 단위로 환산하여 저장합니다.
        </p>
      </div>
    </div>
  )
}
