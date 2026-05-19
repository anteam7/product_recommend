import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface WeatherRow {
  date: string
  region: string
  tmin: number | null
  tmax: number | null
  tavg: number | null
  humidity: number | null
  precip: number | null
  feels_like: number | null
  forecast: boolean
}

interface CouplingRow {
  product_id: string
  lead_days: number
  weather_var: string
  beta: number
  r2: number
  n_obs: number
  fitted_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string | null
}

const VAR_LABEL: Record<string, string> = {
  tmin: '최저기온',
  tmax: '최고기온',
  tavg: '평균기온',
  humidity: '습도',
  precip: '강수량',
  feels_like: '체감온도',
}

async function fetchData() {
  const sb = createAdminClient()

  // 1) 향후 7일 예보
  const today = new Date().toISOString().slice(0, 10)
  const wRes = await (sb as any)
    .from('jimscanner_weather_daily')
    .select('date, region, tmin, tmax, tavg, humidity, precip, feels_like, forecast')
    .gte('date', today)
    .order('date', { ascending: true })
    .limit(14)
  const forecast: WeatherRow[] = (wRes.data ?? []) as WeatherRow[]

  // 2) 최신 coupling (DISTINCT ON 대용: 최근 200개 후 in-memory 정리)
  const cRes = await (sb as any)
    .from('jimscanner_trends_weather_coupling')
    .select('product_id, lead_days, weather_var, beta, r2, n_obs, fitted_at')
    .order('fitted_at', { ascending: false })
    .limit(500)
  const coupling: CouplingRow[] = (cRes.data ?? []) as CouplingRow[]

  const seen = new Set<string>()
  const latest: CouplingRow[] = []
  for (const c of coupling) {
    const k = `${c.product_id}|${c.lead_days}|${c.weather_var}`
    if (seen.has(k)) continue
    seen.add(k)
    latest.push(c)
  }

  const productIds = [...new Set(latest.map((c) => c.product_id))]
  let products: ProductRow[] = []
  if (productIds.length > 0) {
    const pRes = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds)
    products = (pRes.data ?? []) as ProductRow[]
  }
  const productMap = new Map(products.map((p) => [p.id, p]))

  // 3) 선출고 D-day 큐 — 향후 7일 예보 × 각 product 의 최강 coupling
  //   각 product 의 (r2 최대) coupling 1개만 채택 → 그 var 의 future delta 로 demand 변화율 추정
  const bestByPid = new Map<string, CouplingRow>()
  for (const c of latest) {
    const cur = bestByPid.get(c.product_id)
    if (!cur || c.r2 > cur.r2) bestByPid.set(c.product_id, c)
  }

  type QueueItem = {
    date: string
    daysAhead: number
    product: ProductRow
    coupling: CouplingRow
    weatherValue: number
    expectedDelta: number
  }
  const queue: QueueItem[] = []
  const todayMs = new Date(today + 'T00:00:00Z').getTime()
  for (const [pid, c] of bestByPid.entries()) {
    const product = productMap.get(pid)
    if (!product) continue
    for (const w of forecast) {
      const wValue = (w as any)[c.weather_var] as number | null
      if (wValue == null) continue
      const wMs = new Date(w.date + 'T00:00:00Z').getTime()
      const daysAhead = Math.round((wMs - todayMs) / 86400_000) + c.lead_days
      if (daysAhead < 0 || daysAhead > 7) continue
      // 단순 추정: beta × (current - baseline). baseline = 향후 7일 평균.
      // 여기선 절대값이 아니라 상대 변화율을 보여줄 것이므로 baseline 평균 사용.
      const sameVarValues = forecast
        .map((f) => (f as any)[c.weather_var] as number | null)
        .filter((v): v is number => v != null)
      if (sameVarValues.length === 0) continue
      const baseline = sameVarValues.reduce((a, b) => a + b, 0) / sameVarValues.length
      const delta = c.beta * (wValue - baseline)
      // demand 시계열은 0~100 ratio 라 delta 도 그 스케일. 표시는 %로.
      queue.push({
        date: w.date,
        daysAhead,
        product,
        coupling: c,
        weatherValue: wValue,
        expectedDelta: delta,
      })
    }
  }
  queue.sort((a, b) => Math.abs(b.expectedDelta) - Math.abs(a.expectedDelta))

  // 4) 전체 향후 7일 합산 효과 카드
  const aggregate = new Map<string, { product: ProductRow; sumDelta: number; max: QueueItem }>()
  for (const q of queue) {
    const cur = aggregate.get(q.product.id)
    if (!cur) {
      aggregate.set(q.product.id, { product: q.product, sumDelta: q.expectedDelta, max: q })
    } else {
      cur.sumDelta += q.expectedDelta
      if (Math.abs(q.expectedDelta) > Math.abs(cur.max.expectedDelta)) cur.max = q
    }
  }
  const aggList = [...aggregate.values()].sort(
    (a, b) => Math.abs(b.sumDelta) - Math.abs(a.sumDelta),
  )

  return { forecast, latest, productMap, queue, aggList }
}

export default async function WeatherBoardPage() {
  const { forecast, latest, productMap, queue, aggList } = await fetchData()

  const hasWeather = forecast.length > 0
  const hasCoupling = latest.length > 0

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">🌦 기상예보 연동 수요 회귀</h1>
        <p className="text-sm text-gray-500 mt-1">
          KMA 단기예보 × 핀 시계열 lag 회귀 → 선출고 윈도우 보드
        </p>
      </header>

      {/* (a) 향후 7일 예보 적용 카드 */}
      <section>
        <h2 className="text-sm font-semibold mb-3">향후 7일 예보 적용 시 수요 변동 Top</h2>
        {!hasWeather && (
          <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
            KMA 예보 데이터가 아직 없습니다. <code className="font-mono">KMA_API_KEY</code> 등록
            후 <code className="font-mono">node --env-file=.env.local scripts/fetch-weather-kma.mjs</code>{' '}
            실행을 기다리는 중입니다.
          </div>
        )}
        {hasWeather && !hasCoupling && (
          <div className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
            기상 데이터는 있으나 회귀 적합 결과(R²≥0.3)가 아직 없습니다.{' '}
            <code className="font-mono">scripts/fit-weather-coupling.mjs</code> 가 실행되면 채워집니다.
          </div>
        )}
        {hasCoupling && (
          <div className="grid gap-2 md:grid-cols-2">
            {aggList.slice(0, 8).map((a) => {
              const pct = Math.round(a.sumDelta * 10) / 10
              const positive = pct >= 0
              return (
                <Link
                  key={a.product.id}
                  href={`/admin/trend-radar/products/${a.product.id}`}
                  className="rounded border border-gray-200 px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="text-sm font-semibold">{a.product.canonical_name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {a.product.category_top ?? '—'}
                  </div>
                  <div className="mt-2">
                    <span
                      className={`text-2xl font-bold font-mono ${
                        positive ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {positive ? '+' : ''}
                      {pct}
                    </span>
                    <span className="text-xs text-gray-500 ml-1">
                      ratio (향후 7일 누적 예상)
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    핵심 변수: {VAR_LABEL[a.max.coupling.weather_var] ?? a.max.coupling.weather_var}{' '}
                    · lag {a.max.coupling.lead_days}일 · R²{' '}
                    {a.max.coupling.r2.toFixed(2)}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </section>

      {/* (b) 선출고 D-day 큐 */}
      {hasCoupling && (
        <section>
          <h2 className="text-sm font-semibold mb-3">선출고 D-day 큐 (절대 영향 큰 순)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">D+일</th>
                  <th className="px-3 py-2 text-left">예보일</th>
                  <th className="px-3 py-2 text-left">상품</th>
                  <th className="px-3 py-2 text-left">트리거</th>
                  <th className="px-3 py-2 text-right">예상 Δ</th>
                  <th className="px-3 py-2 text-right">R²</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queue.slice(0, 30).map((q, i) => {
                  const positive = q.expectedDelta >= 0
                  const pct = Math.round(q.expectedDelta * 10) / 10
                  return (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-gray-600">D+{q.daysAhead}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {q.date.slice(5)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/trend-radar/products/${q.product.id}`}
                          className="hover:underline"
                        >
                          {q.product.canonical_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">
                        {VAR_LABEL[q.coupling.weather_var] ?? q.coupling.weather_var}{' '}
                        {q.weatherValue}
                        {q.coupling.weather_var === 'humidity' ? '%' :
                         q.coupling.weather_var === 'precip' ? 'mm' : '℃'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono font-bold ${
                          positive ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {positive ? '+' : ''}
                        {pct}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                        {q.coupling.r2.toFixed(2)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 향후 7일 예보 자체 */}
      {hasWeather && (
        <section>
          <h2 className="text-sm font-semibold mb-3">KMA 단기예보 (전국, 서울 격자)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">날짜</th>
                  <th className="px-3 py-2 text-right">최저</th>
                  <th className="px-3 py-2 text-right">최고</th>
                  <th className="px-3 py-2 text-right">평균</th>
                  <th className="px-3 py-2 text-right">습도</th>
                  <th className="px-3 py-2 text-right">강수</th>
                  <th className="px-3 py-2 text-right">체감</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {forecast.slice(0, 8).map((w) => (
                  <tr key={w.date}>
                    <td className="px-3 py-2 font-mono text-gray-600">{w.date}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {w.tmin != null ? w.tmin.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {w.tmax != null ? w.tmax.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {w.tavg != null ? w.tavg.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {w.humidity != null ? w.humidity.toFixed(0) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {w.precip != null ? w.precip.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {w.feels_like != null ? w.feels_like.toFixed(1) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">
            {forecast.some((f) => f.forecast) ? '예보 (forecast=true)' : '실측'} ·{' '}
            <code>jimscanner_weather_daily</code>
          </p>
        </section>
      )}

      <p className="text-xs text-gray-400">
        총 핀 적합 행 {latest.length}개 · 예측 큐 {queue.length}개. 채택 임계 R²≥0.30 · lag {`{0,1,2,3,5,7}`}일.
      </p>
    </div>
  )
}
