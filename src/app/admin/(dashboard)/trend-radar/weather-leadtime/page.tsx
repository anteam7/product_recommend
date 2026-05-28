import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ForecastRow {
  region: string
  target_date: string
  lead_days: number
  temp_min: number | null
  temp_max: number | null
  precipitation_prob: number | null
  precipitation_mm: number | null
  pm10: number | null
  pm25: number | null
  heat_wave: boolean | null
  cold_wave: boolean | null
  typhoon: boolean | null
  captured_at: string
  source: string
}

interface DemandRow {
  target_date: string
  category: string
  surge_score: number
  drivers: { var: string; value: number; coef: number; contribution: number }[] | null
  recommend_publish_date: string | null
  ggsan_match_count: number | null
  computed_at: string
}

const WEATHER_VAR_LABEL: Record<string, string> = {
  temp_max: '최고기온',
  temp_min: '최저기온',
  temp_anomaly: '평년편차',
  precipitation_mm: '강수량',
  precipitation_prob: '강수확률',
  pm10: 'PM10',
  pm25: 'PM2.5',
  heat_wave: '폭염',
  cold_wave: '한파',
  typhoon: '태풍',
}

async function fetchData() {
  const sb = createAdminClient()
  const today = new Date().toISOString().slice(0, 10)

  const [fcRes, dfRes] = await Promise.all([
    sb
      .from('jimscanner_weather_forecast' as never)
      .select('region, target_date, lead_days, temp_min, temp_max, precipitation_prob, precipitation_mm, pm10, pm25, heat_wave, cold_wave, typhoon, captured_at, source')
      .gte('target_date', today)
      .order('captured_at', { ascending: false })
      .limit(500),
    sb
      .from('jimscanner_weather_demand_forecast' as never)
      .select('target_date, category, surge_score, drivers, recommend_publish_date, ggsan_match_count, computed_at')
      .gte('target_date', today)
      .order('computed_at', { ascending: false })
      .limit(2000),
  ])

  const forecasts = ((fcRes.data ?? []) as ForecastRow[])
  const demand = ((dfRes.data ?? []) as DemandRow[])

  // target_date 별 최신 forecast 1개씩.
  const fcByDate = new Map<string, ForecastRow>()
  for (const f of forecasts) {
    if (!fcByDate.has(f.target_date)) fcByDate.set(f.target_date, f)
  }

  // (target_date, category) 별 최신 1개씩.
  const dfMap = new Map<string, DemandRow>()
  for (const d of demand) {
    const k = `${d.target_date}::${d.category}`
    if (!dfMap.has(k)) dfMap.set(k, d)
  }

  // target_date → demand row[]
  const dfByDate = new Map<string, DemandRow[]>()
  for (const d of dfMap.values()) {
    const arr = dfByDate.get(d.target_date) ?? []
    arr.push(d)
    dfByDate.set(d.target_date, arr)
  }
  for (const arr of dfByDate.values()) {
    arr.sort((a, b) => b.surge_score - a.surge_score)
  }

  const dates = [...fcByDate.keys()].sort().slice(0, 10)
  return { dates, fcByDate, dfByDate, totalDemandRows: dfMap.size }
}

function fmtTemp(v: number | null): string {
  return v == null ? '–' : `${v.toFixed(1)}°`
}
function fmtPct(v: number | null): string {
  return v == null ? '–' : `${Math.round(v)}%`
}
function fmtDate(d: string): string {
  const dt = new Date(d + 'T00:00:00Z')
  const dow = ['일', '월', '화', '수', '목', '금', '토'][dt.getUTCDay()]
  return `${d.slice(5)} (${dow})`
}
function leadFrom(targetDate: string): number {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  const t = new Date(targetDate + 'T00:00:00Z').getTime()
  return Math.round((t - today) / 86400_000)
}

export default async function WeatherLeadtimePage() {
  const { dates, fcByDate, dfByDate, totalDemandRows } = await fetchData()

  return (
    <div className="px-6 py-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">기상예보 × 카테고리 선점 보드</h1>
        <p className="text-sm text-gray-600 mt-1">
          KMA 중기예보 (D+3 ~ D+10) × 카테고리×기상 elasticity → surging 카테고리와 발행 권장 D-day.
        </p>
        <div className="text-xs text-gray-500 mt-1">
          예보 일자 {dates.length} · 예측 행 {totalDemandRows}
        </div>
      </header>

      {dates.length === 0 ? (
        <div className="border border-amber-300 bg-amber-50 text-amber-900 rounded p-4 text-sm">
          <p className="font-semibold mb-1">데이터 없음</p>
          <p>
            <code className="bg-white px-1 py-0.5 rounded">/api/cron/collect-weather-forecast</code> 와{' '}
            <code className="bg-white px-1 py-0.5 rounded">/api/cron/compute-weather-demand</code> 를 한 번 실행하세요.
          </p>
          <p className="mt-2">
            KMA 키 없으면 mock 시나리오 (폭염 D+5~6) 로 자동 fallback.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${dates.length}, minmax(180px, 1fr))` }}>
            {dates.map((d) => {
              const fc = fcByDate.get(d)
              const surges = (dfByDate.get(d) ?? []).slice(0, 5)
              const lead = leadFrom(d)
              const isHeat = fc?.heat_wave
              const isCold = fc?.cold_wave
              const isRain = (fc?.precipitation_prob ?? 0) >= 60
              const isPm = (fc?.pm25 ?? 0) >= 35 || (fc?.pm10 ?? 0) >= 80
              return (
                <div key={d} className="border border-gray-200 rounded-lg bg-white p-3 flex flex-col">
                  <div className="flex items-baseline justify-between border-b border-gray-100 pb-2 mb-2">
                    <div className="text-sm font-semibold">{fmtDate(d)}</div>
                    <div className="text-xs text-gray-500">D+{lead}</div>
                  </div>
                  <div className="text-xs text-gray-700 space-y-0.5 mb-2">
                    <div>
                      <span className="text-red-600 font-medium">{fmtTemp(fc?.temp_max ?? null)}</span>
                      {' / '}
                      <span className="text-blue-600">{fmtTemp(fc?.temp_min ?? null)}</span>
                    </div>
                    <div className="text-gray-600">강수 {fmtPct(fc?.precipitation_prob ?? null)}</div>
                    {fc?.pm25 != null && <div className="text-gray-600">PM2.5 {Math.round(fc.pm25)}</div>}
                    <div className="flex gap-1 flex-wrap mt-1">
                      {isHeat && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">폭염</span>}
                      {isCold && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">한파</span>}
                      {isRain && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">강수</span>}
                      {isPm && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">미세먼지</span>}
                      {fc?.typhoon && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">태풍</span>}
                    </div>
                  </div>

                  <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Top surging</div>
                  {surges.length === 0 ? (
                    <div className="text-xs text-gray-400">–</div>
                  ) : (
                    <ul className="space-y-1">
                      {surges.map((s) => {
                        const topDriver = (s.drivers ?? []).slice().sort((a, b) => b.contribution - a.contribution)[0]
                        return (
                          <li key={s.category} className="text-xs">
                            <div className="flex items-baseline justify-between">
                              <span className="font-medium">{s.category}</span>
                              <span className="text-orange-600 font-semibold">{s.surge_score.toFixed(1)}</span>
                            </div>
                            <div className="text-gray-500 text-[10px]">
                              {topDriver
                                ? `${WEATHER_VAR_LABEL[topDriver.var] ?? topDriver.var} (+${topDriver.contribution})`
                                : ''}
                              {s.recommend_publish_date && (
                                <span className="ml-1 text-green-700">
                                  발행 {s.recommend_publish_date.slice(5)}
                                </span>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <details className="mt-4 text-xs text-gray-500">
        <summary className="cursor-pointer hover:text-gray-700">운영 메모</summary>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>cron: <code>collect-weather-forecast</code> (수집) → <code>compute-weather-demand</code> (예측 계산).</li>
          <li>elasticity 는 부트스트랩 휴리스틱. 향후 <code>scripts/weather-fit-elasticity.mjs</code> 로 회귀 학습 예정.</li>
          <li>발행 권장일 = target_date − elasticity.lead_days. 검색이 시작되기 전에 글이 인덱싱돼야 함.</li>
        </ul>
      </details>
    </div>
  )
}
