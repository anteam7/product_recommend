import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { detectBreaches, type BreachEvent, type ForecastRow } from './rules'

export const dynamic = 'force-dynamic'

interface Board {
  breaches: BreachEvent[]
  forecastRows: number
  baseDate: string | null
  error: string | null
}

async function fetchBoard(): Promise<Board> {
  const sb = createAdminClient()
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`

  // 새 테이블 — generated types 에 없으므로 as any (마이그레이션 후 상태 가정)
  const { data, error } = await (sb as any).from('jimscanner_weather_forecast')
    .select('base_date, forecast_date, region, metric, value, anomaly')
    .gte('forecast_date', todayIso)
    .order('forecast_date', { ascending: true })
    .limit(2000)

  if (error) return { breaches: [], forecastRows: 0, baseDate: null, error: error.message }

  const rows = (data ?? []) as ForecastRow[]
  // 가장 최신 발표회차만 사용
  const baseDate = rows.reduce<string | null>(
    (mx, r) => (mx === null || r.base_date > mx ? r.base_date : mx),
    null,
  )
  const latest = baseDate ? rows.filter((r) => r.base_date === baseDate) : rows

  const breaches = detectBreaches(latest, today)
  return { breaches, forecastRows: latest.length, baseDate, error: null }
}

const METRIC_ICON: Record<string, string> = {
  tmax: '🔥',
  tmin: '❄️',
  pm10: '😷',
  pm25: '😷',
  rain_prob: '🌧️',
}

function ddayLabel(d: number): string {
  if (d === 0) return 'D-DAY'
  return `D-${d}`
}

function ddayCls(d: number): string {
  if (d <= 1) return 'bg-red-600 text-white'
  if (d <= 3) return 'bg-orange-500 text-white'
  if (d <= 5) return 'bg-yellow-500 text-white'
  return 'bg-emerald-600 text-white'
}

export default async function WeatherRadarPage() {
  const { breaches, forecastRows, baseDate, error } = await fetchBoard()

  // 임박순(D-카운트다운) 정렬 — detectBreaches 가 이미 dday asc
  const leadCount = breaches.length
  const within3 = breaches.filter((b) => b.dday <= 3).length
  const minDday = breaches.length ? Math.min(...breaches.map((b) => b.dday)) : null

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🌦️ 기상 선행 수요 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            기상청 예보 임계 돌파(폭염·한파·미세먼지)를 <strong>D-카운트다운</strong>으로 — 뉴스·검색이 터지기 7~10일 전 소싱 런웨이 확보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
        <strong>왜 예보인가</strong> · news-demand 보드는 폭염·한파를 다루지만 <strong>뉴스 보도 발생 후</strong> 반응형이라
        타이밍 갭이 있다(코드 주석도 인정: &ldquo;골든타임은 검색 급증 직전&rdquo;). 예보는 7~10일 선행하는{' '}
        <strong>유일한 구조적·수치 신호원</strong> — 임계 돌파일과 그날 터질 카테고리를 미리 알고 ggsan 소싱·등록 런웨이를 선점한다.
        {baseDate && <span className="block mt-1 text-sky-700">발표회차 {baseDate} 기준 · 적재 행 {forecastRows}</span>}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="임계 돌파 이벤트" value={leadCount} highlight={leadCount > 0} />
        <Kpi label="D-3 이내 (임박)" value={within3} highlight={within3 > 0} />
        <Kpi label="가장 빠른 돌파" value={minDday === null ? '—' : ddayLabel(minDday)} />
        <Kpi label="분석 예보 행" value={forecastRows} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
          <div className="mt-1 text-xs text-red-600">
            jimscanner_weather_forecast 테이블 미적용일 수 있음 — supabase/weather_forecast.sql 적용 필요.
          </div>
        </div>
      )}

      {!error && breaches.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">임계 돌파 예보 없음</div>
          <div className="text-xs text-gray-400">
            향후 예보에서 폭염(33℃↑)·한파(-12℃↓)·미세먼지 나쁨 임계를 넘는 날이 없음.
            <br />
            collect-weather-forecast cron 이 도는지(KMA_API_KEY) 확인.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {breaches.map((b, i) => (
            <div
              key={`${b.topic.key}-${b.forecastDate}-${b.region}-${i}`}
              className={`rounded border p-4 ${b.dday <= 3 ? 'border-orange-200 bg-orange-50/40' : 'border-gray-200'}`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm px-2.5 py-1 rounded font-bold font-mono ${ddayCls(b.dday)}`}>
                    {ddayLabel(b.dday)}
                  </span>
                  <span className="text-base font-bold">
                    {METRIC_ICON[b.metric]} {b.topic.label}
                  </span>
                  <span className="text-[11px] px-2 py-0.5 rounded bg-sky-100 text-sky-800">{b.breachLabel}</span>
                  <span className="text-[11px] px-2 py-0.5 rounded border border-green-300 bg-green-100 text-green-800">
                    🟢 LEAD · 예보 선행
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono font-bold text-sky-700">
                    {b.forecastDate} · {b.region}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    예보값 {b.value}
                    {b.metric === 'tmax' || b.metric === 'tmin' ? '℃' : b.metric.startsWith('pm') ? '㎍/㎥' : ''}
                  </div>
                </div>
              </div>

              {b.topic.note && <p className="text-xs text-gray-500 mt-2">{b.topic.note}</p>}

              {/* 그날 터질 카테고리 */}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-gray-400">D-{b.dday} 폭발 카테고리</span>
                {b.topic.impactedCategories.map((c) => (
                  <span key={c} className="bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded">
                    {c}
                  </span>
                ))}
              </div>

              {/* ggsan 소싱 후보 점프 */}
              <div className="mt-3 flex flex-wrap gap-2">
                {b.topic.ggsanCateCodes.length > 0 ? (
                  b.topic.ggsanCateCodes.map((code) => (
                    <Link
                      key={code}
                      href={`/admin/trend-radar/recommend?cate=${code}`}
                      className="text-xs bg-black text-white px-3 py-1 rounded hover:bg-gray-800"
                    >
                      🔗 ggsan 소싱 SKU ({code})
                    </Link>
                  ))
                ) : (
                  <Link
                    href={`/admin/trend-radar/recommend?q=${encodeURIComponent(b.topic.demandKeywords[0] ?? '')}`}
                    className="text-xs bg-gray-800 text-white px-3 py-1 rounded hover:bg-gray-700"
                  >
                    🔗 ggsan 키워드 탐색 ({b.topic.demandKeywords[0] ?? ''})
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 임계 돌파 / D-카운트다운 판정식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          폭염 일최고≥33℃ · 한파 일최저≤-12℃ · 미세먼지 PM10≥81 / PM2.5≥36 → news-demand 토픽 발화
          <br />
          dday = 예보일 − 오늘 · demand_phase = lead(예보는 항상 검색·뉴스보다 선행)
        </code>
        <div className="pt-1 text-gray-400">
          데이터: collect-weather-forecast cron(기상청 단기예보) → jimscanner_weather_forecast.
          매핑은 news-demand/rules.ts 의 NEWS_TOPICS 재사용(단일 진실원).
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-orange-300 bg-orange-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-orange-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
