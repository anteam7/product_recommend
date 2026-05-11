import { Metadata } from 'next'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TRACKED_CURRENCIES, type Currency } from '@/lib/exchange-rates'
import { CurrencyConverter } from '@/components/exchange/CurrencyConverter'

const FAQS: { q: string; a: string }[] = [
  {
    q: '매매기준율이 뭔가요? 제가 실제로 지불하는 환율과 같나요?',
    a: '매매기준율은 외환시장 전날 거래를 가중평균한 기준 환율로, 국내 금융기관이 공통 참조하는 값입니다. 실제 결제 환율은 여기에 은행·카드사 수수료(현찰 1~2%, 송금 ±0.5%, 해외카드 약 0.2~1% + 브랜드 수수료 1%)가 가산되므로, 매매기준율보다 높거나 낮게 적용됩니다.',
  },
  {
    q: '해외 신용카드 결제 환율은 언제 기준인가요?',
    a: '국내 카드사는 일반적으로 매입 처리일(가맹점 승인일로부터 2~4일 후)의 기준환율에 약 0.2~0.2%의 수수료를 더해 청구합니다. 즉 결제 당일 환율이 아니라 며칠 뒤 환율로 청구될 수 있으며, 이 때문에 매입 환율이 오르면 청구액도 함께 늘어납니다.',
  },
  {
    q: '주말이나 공휴일 환율은 어떻게 되나요?',
    a: '외환시장이 열리지 않는 토·일·공휴일에는 직전 영업일의 매매기준율이 유지됩니다. 본 페이지는 갱신되지 않은 날에도 직전 영업일 고시치를 그대로 표시합니다.',
  },
  {
    q: '일본 엔 환율이 10원대로 표시되는 이유는?',
    a: '일본 엔은 100엔 단위로 고시되는 통화 관행에 따라 한국에서도 "100JPY = 9.5원" 형태로 공시됩니다. 짐스캐너는 계산 편의를 위해 1엔 기준(약 0.095원)으로 환산해 저장하고, 표시할 때는 100엔 기준으로 되돌려 보여줍니다.',
  },
  {
    q: '배대지 요금이 KRW로 표시될 때 적용되는 환율은 무엇인가요?',
    a: '짐스캐너의 배대지 비교 카드와 계산기에 나오는 원화 금액은 이 페이지와 동일한 매매기준율(매일 1회 자동 갱신)을 사용합니다. 실제 배대지 결제 시에는 해당 업체의 정산 환율(결제일·출고일 기준 등)과 카드사 수수료가 추가 적용될 수 있어 ±1~3% 오차가 발생할 수 있습니다.',
  },
]

export const metadata: Metadata = {
  title: '환율 동향 · USD·JPY·CNY·EUR 최근 30일',
  description:
    '네이버 금융 고시환율 기준 미 달러·일본 엔·중국 위안·유로 환율을 매일 갱신. 짐스캐너 배대지 비교 요금도 이 환율로 계산됩니다.',
  alternates: {
    canonical: 'https://jimscanner.co.kr/exchange-rates',
  },
  openGraph: {
    title: '환율 동향 · USD·JPY·CNY·EUR',
    description:
      '네이버 금융 고시환율을 매일 갱신. 해외직구·배대지 결제 전 최신 환율을 빠르게 확인하세요.',
    url: 'https://jimscanner.co.kr/exchange-rates',
  },
}

export const revalidate = 900 // 15분

const CURRENCY_META: Record<Currency, { flag: string; label: string; unitLabel: string }> = {
  USD: { flag: '🇺🇸', label: '미국 달러', unitLabel: '1 USD' },
  JPY: { flag: '🇯🇵', label: '일본 엔', unitLabel: '100 JPY' },
  CNY: { flag: '🇨🇳', label: '중국 위안', unitLabel: '1 CNY' },
  EUR: { flag: '🇪🇺', label: '유로', unitLabel: '1 EUR' },
}

type HistoryRow = { currency: Currency; rate_krw: number; rate_date: string }

function formatKRW(v: number, digits = 2) {
  return v.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function formatKSTDate(iso: string) {
  const [y, m, d] = iso.split('-')
  return `${y.slice(2)}.${m}.${d}`
}

type Sparkline = { d: string; points: string; min: number; max: number }

function buildSparkline(values: number[], width = 240, height = 56, padding = 4): Sparkline {
  if (values.length < 2) {
    return { d: '', points: '', min: 0, max: 0 }
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = (width - padding * 2) / (values.length - 1)

  const coords = values.map((v, i) => {
    const x = padding + i * stepX
    const y = height - padding - ((v - min) / range) * (height - padding * 2)
    return { x, y }
  })

  const d = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const points = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  return { d, points, min, max }
}

export default async function ExchangeRatesPage() {
  const { data: historyRaw } = await supabase
    .from('jimscanner_exchange_rate_history')
    .select('currency, rate_krw, rate_date')
    .order('rate_date', { ascending: true })
    .limit(200)

  const history = (historyRaw ?? []) as HistoryRow[]

  const byCurrency: Record<Currency, HistoryRow[]> = {
    USD: [],
    JPY: [],
    CNY: [],
    EUR: [],
  }
  for (const row of history) {
    if (TRACKED_CURRENCIES.includes(row.currency)) {
      byCurrency[row.currency].push(row)
    }
  }

  const allDates = Array.from(new Set(history.map((r) => r.rate_date))).sort((a, b) => b.localeCompare(a))
  const lastDate = allDates[0]
  const tableDates = allDates.slice(0, 15)

  const latestRates: Partial<Record<Currency, number>> = {}
  for (const cur of TRACKED_CURRENCIES) {
    const rows = byCurrency[cur]
    if (rows.length > 0) latestRates[cur] = rows[rows.length - 1].rate_krw
  }

  const prevRateMap: Record<Currency, Record<string, number>> = {
    USD: {},
    JPY: {},
    CNY: {},
    EUR: {},
  }
  for (const cur of TRACKED_CURRENCIES) {
    const arr = byCurrency[cur]
    for (let i = 1; i < arr.length; i++) {
      prevRateMap[cur][arr[i].rate_date] = arr[i - 1].rate_krw
    }
  }

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.a,
      },
    })),
  }

  return (
    <div className="py-12 px-4">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <div className="container mx-auto max-w-5xl">
        <div className="mb-10">
          <Badge className="mb-3">환율 동향</Badge>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
            오늘의 환율 · 최근 {allDates.length}영업일
          </h1>
          <p className="text-base text-gray-600 leading-relaxed max-w-3xl">
            네이버 금융이 고시하는 <strong className="text-gray-900">매매기준율</strong>(하나은행 기준)을 매일 자동 수집합니다.
            짐스캐너의 배대지 비교 요금은 이 환율로 KRW 환산되어 표시됩니다.
          </p>
          {lastDate && (
            <p className="text-xs text-gray-500 mt-2">
              마지막 반영일: <strong>{lastDate}</strong> · 출처 네이버 금융
            </p>
          )}
        </div>

        {history.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-sm text-gray-500">
              아직 환율 데이터가 없습니다. 잠시 후 다시 방문해 주세요.
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 환율 계산기 */}
            <section className="mb-8">
              <CurrencyConverter rates={latestRates} />
            </section>

            {/* 통화별 카드 */}
            <section className="grid gap-4 sm:grid-cols-2 mb-12">
              {TRACKED_CURRENCIES.map((cur) => {
                const rows = byCurrency[cur]
                if (rows.length === 0) return null

                const latest = rows[rows.length - 1]
                const prev = rows[rows.length - 2]
                const first = rows[0]
                const displayScale = cur === 'JPY' ? 100 : 1
                const displayDigits = cur === 'JPY' ? 2 : 2

                const values = rows.map((r) => r.rate_krw * displayScale)
                const spark = buildSparkline(values)

                const diff = latest.rate_krw - first.rate_krw
                const diffPct = (diff / first.rate_krw) * 100
                const up = diff > 0

                const diffDod = prev ? latest.rate_krw - prev.rate_krw : 0
                const diffDodPct = prev ? (diffDod / prev.rate_krw) * 100 : 0
                const upDod = diffDod > 0

                const meta = CURRENCY_META[cur]

                return (
                  <Card key={cur} className="overflow-hidden">
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center justify-between text-base">
                        <span className="flex items-center gap-2">
                          <span className="text-2xl leading-none">{meta.flag}</span>
                          <span className="text-gray-700 font-medium">{meta.label}</span>
                        </span>
                        <span className="text-xs text-gray-500 font-normal">{meta.unitLabel}</span>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-end justify-between">
                        <div>
                          <div className="text-3xl font-bold text-gray-900 leading-none">
                            {formatKRW(latest.rate_krw * displayScale, displayDigits)}
                            <span className="text-sm text-gray-500 font-normal ml-1">KRW</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {formatKSTDate(latest.rate_date)} 기준
                          </div>
                        </div>
                        <div className="text-right text-sm space-y-1.5">
                          {prev && (
                            <div
                              className={`font-semibold ${
                                diffDod === 0
                                  ? 'text-gray-500'
                                  : upDod
                                    ? 'text-red-600'
                                    : 'text-blue-600'
                              }`}
                            >
                              <span className="text-[11px] font-normal text-gray-500 mr-1">어제</span>
                              {diffDod === 0
                                ? '변동 없음'
                                : `${upDod ? '▲' : '▼'} ${Math.abs(diffDodPct).toFixed(2)}%`}
                            </div>
                          )}
                          <div
                            className={`font-medium ${
                              diff === 0 ? 'text-gray-500' : up ? 'text-red-600' : 'text-blue-600'
                            }`}
                          >
                            <span className="text-[11px] font-normal text-gray-500 mr-1">
                              {allDates.length}일
                            </span>
                            {diff === 0 ? '변동 없음' : `${up ? '▲' : '▼'} ${Math.abs(diffPct).toFixed(2)}%`}
                          </div>
                        </div>
                      </div>

                      <svg
                        viewBox="0 0 240 56"
                        className="w-full h-14"
                        preserveAspectRatio="none"
                        aria-label={`${meta.label} ${allDates.length}영업일 추이`}
                      >
                        <polyline
                          points={spark.points}
                          fill="none"
                          stroke={up ? '#dc2626' : '#2563eb'}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>

                      <div className="flex justify-between text-xs text-gray-500">
                        <span>
                          저 {formatKRW(spark.min, displayDigits)}
                        </span>
                        <span>
                          고 {formatKRW(spark.max, displayDigits)}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </section>

            {/* 일별 표 */}
            <section className="mb-12">
              <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b">
                최근 {tableDates.length}영업일 매매기준율 (원/KRW)
              </h2>
              <div className="bg-white border rounded-lg overflow-x-auto">
                <table className="w-full text-sm min-w-[520px]">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                        날짜
                      </th>
                      {TRACKED_CURRENCIES.map((cur) => (
                        <th
                          key={cur}
                          className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase"
                        >
                          {CURRENCY_META[cur].flag} {cur}
                          {cur === 'JPY' && <span className="text-gray-400 font-normal"> (100)</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableDates.map((date) => (
                      <tr key={date} className="border-b last:border-b-0">
                        <td className="px-4 py-2 text-gray-700 whitespace-nowrap">
                          {formatKSTDate(date)}
                        </td>
                        {TRACKED_CURRENCIES.map((cur) => {
                          const row = byCurrency[cur].find((r) => r.rate_date === date)
                          const scale = cur === 'JPY' ? 100 : 1
                          const prevRate = row ? prevRateMap[cur][date] : undefined
                          const delta =
                            row && prevRate !== undefined ? row.rate_krw - prevRate : null
                          return (
                            <td key={cur} className="px-4 py-2 text-right font-mono text-gray-900">
                              {row ? (
                                <span className="inline-flex items-center justify-end gap-1.5">
                                  {delta !== null && delta !== 0 && (
                                    <span
                                      className={`text-[10px] leading-none ${
                                        delta > 0 ? 'text-red-600' : 'text-blue-600'
                                      }`}
                                      aria-label={delta > 0 ? '전일 대비 상승' : '전일 대비 하락'}
                                      title={`전일 대비 ${delta > 0 ? '+' : ''}${(delta * scale).toFixed(2)}원`}
                                    >
                                      {delta > 0 ? '▲' : '▼'}
                                    </span>
                                  )}
                                  <span>{formatKRW(row.rate_krw * scale, 2)}</span>
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* FAQ */}
            <section className="mb-10">
              <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b">
                자주 묻는 질문
              </h2>
              <div className="divide-y border rounded-lg bg-white">
                {FAQS.map((item, idx) => (
                  <details key={idx} className="group">
                    <summary className="cursor-pointer list-none px-5 py-4 flex items-start justify-between gap-3 hover:bg-gray-50">
                      <span className="text-sm font-medium text-gray-900 flex-1">
                        Q. {item.q}
                      </span>
                      <span className="text-gray-400 mt-0.5 transition-transform group-open:rotate-180 shrink-0">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="6 9 12 15 18 9" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </summary>
                    <div className="px-5 pb-4 pt-0 text-sm text-gray-600 leading-relaxed">
                      {item.a}
                    </div>
                  </details>
                ))}
              </div>
            </section>

            {/* 안내 */}
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 text-sm text-blue-900 leading-relaxed space-y-2">
              <p>
                <strong>출처 안내</strong> — 본 페이지의 모든 환율은 <strong>네이버 금융</strong>이 제공하는{' '}
                매매기준율(하나은행 고시 기준으로 국내 금융기관이 공통 참조하는 환율)을 자동 수집한 것입니다.
              </p>
              <p>
                매일 하루 1회 갱신되며(주말·공휴일에는 직전 영업일 고시치가 유지됨), 일본 엔은 100엔 단위로 고시되는 원본을{' '}
                <strong>1엔 단위로 환산</strong>하여 계산에 사용합니다.
              </p>
              <p className="text-xs text-blue-800">
                ※ 표시된 매매기준율은 참고용이며, 실제 외환 거래 시점·은행·거래 방식(현찰/송금)에 따라 적용
                환율이 달라질 수 있습니다.
              </p>
            </div>

            {/* CTA */}
            <div className="mt-10 grid sm:grid-cols-3 gap-4">
              <Link
                href="/compare/us"
                className="border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all text-sm"
              >
                <div className="text-xl mb-1">🇺🇸</div>
                <div className="font-medium text-gray-900">미국 배대지 비교</div>
                <div className="text-xs text-gray-500 mt-1">USD → KRW 환산 결과</div>
              </Link>
              <Link
                href="/compare/jp"
                className="border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all text-sm"
              >
                <div className="text-xl mb-1">🇯🇵</div>
                <div className="font-medium text-gray-900">일본 배대지 비교</div>
                <div className="text-xs text-gray-500 mt-1">JPY → KRW 환산 결과</div>
              </Link>
              <Link
                href="/compare/cn"
                className="border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all text-sm"
              >
                <div className="text-xl mb-1">🇨🇳</div>
                <div className="font-medium text-gray-900">중국 배대지 비교</div>
                <div className="text-xs text-gray-500 mt-1">위안 환산 기준</div>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
