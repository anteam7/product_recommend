import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ── 타입 (마이그레이션 weather_demand_race.sql 적용 후 상태 가정, 타입 미생성 → any 캐스팅)
interface ForecastRow {
  region: string
  region_label: string | null
  forecast_date: string
  temp_min: number | null
  temp_max: number | null
  precip_prob: number | null
  precip_mm: number | null
  pm10: number | null
  is_heatwave: boolean
  is_coldwave: boolean
  is_rainy: boolean
  is_dusty: boolean
}

interface WeatherProduct {
  category_label: string
  weather_event: 'heatwave' | 'coldwave' | 'rainy' | 'dusty'
  match_keywords: string[]
  base_sensitivity: number
  correlation_coef: number | null
  lead_time_days: number
}

interface KeywordRow {
  keyword: string
  volume_relative: number | null
}

const EVENT_META: Record<
  WeatherProduct['weather_event'],
  { label: string; emoji: string; flag: keyof ForecastRow; color: string }
> = {
  heatwave: { label: '폭염', emoji: '🔥', flag: 'is_heatwave', color: 'bg-red-100 text-red-700 border-red-200' },
  coldwave: { label: '한파', emoji: '❄️', flag: 'is_coldwave', color: 'bg-sky-100 text-sky-700 border-sky-200' },
  rainy: { label: '장마/강수', emoji: '🌧', flag: 'is_rainy', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  dusty: { label: '황사/미세먼지', emoji: '😷', flag: 'is_dusty', color: 'bg-amber-100 text-amber-700 border-amber-200' },
}

function daysFromToday(dateIso: string): number {
  const today = new Date()
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const d = new Date(dateIso)
  const t1 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.round((t1 - t0) / 86400000)
}

async function fetchData() {
  const sb = createAdminClient() as any

  const todayIso = new Date().toISOString().slice(0, 10)

  const { data: forecast } = await sb
    .from('jimscanner_weather_forecast')
    .select('region, region_label, forecast_date, temp_min, temp_max, precip_prob, precip_mm, pm10, is_heatwave, is_coldwave, is_rainy, is_dusty')
    .gte('forecast_date', todayIso)
    .order('forecast_date', { ascending: true })
    .limit(200)

  const { data: products } = await sb
    .from('jimscanner_weather_products')
    .select('category_label, weather_event, match_keywords, base_sensitivity, correlation_coef, lead_time_days')
    .eq('is_active', true)
    .order('display_order', { ascending: true })

  // 최근 검색량 시계열(시그널 보강) — match_keywords 매칭용
  const { data: keywords } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative')
    .not('volume_relative', 'is', null)
    .order('collected_at', { ascending: false })
    .limit(4000)

  return {
    forecast: (forecast ?? []) as ForecastRow[],
    products: (products ?? []) as WeatherProduct[],
    keywords: (keywords ?? []) as KeywordRow[],
  }
}

/** 상품 키워드 ↔ 최근 검색량 평균 (0~100). 키워드 부분일치 평균. */
function recentVolumeFor(p: WeatherProduct, keywords: KeywordRow[]): number | null {
  const vals: number[] = []
  for (const k of keywords) {
    if (k.volume_relative === null) continue
    const kw = k.keyword
    if (p.match_keywords.some((m) => kw.includes(m) || m.includes(kw))) vals.push(k.volume_relative)
  }
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

export default async function WeatherRacePage() {
  const { forecast, products, keywords } = await fetchData()

  // 수도권(seoul) 우선 타임라인. 없으면 첫 지역.
  const region = forecast.some((f) => f.region === 'seoul') ? 'seoul' : forecast[0]?.region
  const timeline = forecast
    .filter((f) => f.region === region)
    .filter((f) => daysFromToday(f.forecast_date) >= 0 && daysFromToday(f.forecast_date) <= 10)

  // 다가오는 이벤트 → 매칭 상품 랭킹 카드
  type Card = {
    dday: number
    dateIso: string
    event: WeatherProduct['weather_event']
    product: string
    surge: number
    recentVolume: number | null
    leadTime: number
    canSource: boolean
  }
  const cards: Card[] = []
  for (const day of timeline) {
    const dday = daysFromToday(day.forecast_date)
    ;(Object.keys(EVENT_META) as WeatherProduct['weather_event'][]).forEach((ev) => {
      if (!day[EVENT_META[ev].flag]) return
      for (const p of products.filter((x) => x.weather_event === ev)) {
        const recentVolume = recentVolumeFor(p, keywords)
        const volFactor = recentVolume === null ? 1 : 0.5 + recentVolume / 100 // 0.5~1.5
        const corr = p.correlation_coef ?? 1
        const surge = p.base_sensitivity * Math.abs(corr) * volFactor * 100
        cards.push({
          dday,
          dateIso: day.forecast_date,
          event: ev,
          product: p.category_label,
          surge: Math.round(surge),
          recentVolume,
          leadTime: p.lead_time_days,
          canSource: dday >= p.lead_time_days,
        })
      }
    })
  }
  cards.sort((a, b) => (a.dday - b.dday) || (b.surge - a.surge))

  const hasData = forecast.length > 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🌦 기상 연동 수요 급등 선점 보드</h1>
          <p className="mt-1 text-sm text-gray-500">
            예보 이벤트(폭염·한파·장마·황사) × 날씨 민감 상품 → 예상 수요 급등 + D-day.
            ggsan 리드타임 차감해 <b>이벤트 전 도착 가능</b> 여부를 게이트로 표시.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {!hasData ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 예보 데이터 없음. <code>collect-weather-forecast</code> cron 누적 후 다시 방문.
          <div className="mt-2 text-xs text-gray-400">
            마이그레이션: <code>supabase/weather_demand_race.sql</code> · 환경변수: <code>KMA_SERVICE_KEY</code>
          </div>
        </div>
      ) : (
        <>
          {/* 예보 타임라인 */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-700">
              예보 타임라인 — {timeline[0]?.region_label ?? region} (D0~D10)
            </h2>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {timeline.map((d) => {
                const events = (Object.keys(EVENT_META) as WeatherProduct['weather_event'][]).filter(
                  (ev) => d[EVENT_META[ev].flag],
                )
                const dday = daysFromToday(d.forecast_date)
                return (
                  <div
                    key={d.forecast_date}
                    className={`min-w-[88px] shrink-0 rounded-lg border p-2 text-center ${events.length ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}`}
                  >
                    <div className="text-[10px] text-gray-400">D{dday >= 0 ? `+${dday}` : dday}</div>
                    <div className="text-xs font-medium text-gray-700">{d.forecast_date.slice(5)}</div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      {d.temp_min ?? '–'}° / {d.temp_max ?? '–'}°
                    </div>
                    <div className="text-[11px] text-gray-400">💧{d.precip_prob ?? 0}%</div>
                    <div className="mt-1 flex justify-center gap-0.5">
                      {events.map((ev) => (
                        <span key={ev} title={EVENT_META[ev].label}>
                          {EVENT_META[ev].emoji}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 선점 상품 카드 */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-gray-700">
              선점 후보 — 예상 수요 급등 × 소싱 게이트 ({cards.length})
            </h2>
            {cards.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                향후 10일 내 트리거되는 기상 이벤트 없음. 평시 운영.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {cards.map((c, i) => {
                  const meta = EVENT_META[c.event]
                  return (
                    <div key={i} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${meta.color}`}>
                          {meta.emoji} {meta.label}
                        </span>
                        <span className="text-xs font-semibold text-gray-500">
                          D{c.dday >= 0 ? `+${c.dday}` : c.dday} · {c.dateIso.slice(5)}
                        </span>
                      </div>
                      <div className="mt-2 text-lg font-bold">{c.product}</div>
                      <div className="mt-1 flex items-baseline gap-2">
                        <span className="text-2xl font-extrabold text-orange-600">{c.surge}</span>
                        <span className="text-[11px] text-gray-400">예상 수요지수</span>
                        {c.recentVolume !== null && (
                          <span className="text-[11px] text-gray-400">· 최근검색 {Math.round(c.recentVolume)}</span>
                        )}
                      </div>
                      <div className="mt-2 border-t border-gray-100 pt-2">
                        {c.canSource ? (
                          <span className="text-xs font-medium text-green-700">
                            ✅ 지금 소싱 가능 — 리드타임 {c.leadTime}일 ≤ D+{c.dday}
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-red-600">
                            ⚠️ 늦음 — 리드타임 {c.leadTime}일 &gt; D+{c.dday}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
