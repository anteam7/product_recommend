import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const TAG_META: Record<
  string,
  { label: string; emoji: string; color: string; reason: string }
> = {
  heat: { label: '폭염', emoji: '🥵', color: 'bg-red-100 text-red-800', reason: '최고기온 ≥ 33℃' },
  cold: { label: '한파', emoji: '🥶', color: 'bg-blue-100 text-blue-800', reason: '최저기온 ≤ 0℃' },
  rain: { label: '강수', emoji: '🌧', color: 'bg-sky-100 text-sky-800', reason: '강수확률 ≥ 60%' },
  dust: { label: '미세먼지', emoji: '😷', color: 'bg-amber-100 text-amber-900', reason: 'PM10 나쁨/매우나쁨' },
  uv: { label: '자외선', emoji: '☀️', color: 'bg-orange-100 text-orange-800', reason: 'UV ≥ 7' },
  humidity: { label: '고습도', emoji: '💧', color: 'bg-teal-100 text-teal-800', reason: '습도 ≥ 80%' },
}

const PRODUCT_TAG_KEYS = ['cool', 'heat', 'rain', 'dust', 'uv', 'humidity'] as const
type ProductTagKey = (typeof PRODUCT_TAG_KEYS)[number]

// weather alert_tag → matching product weather_tag
const ALERT_TO_PRODUCT_TAG: Record<string, ProductTagKey> = {
  heat: 'cool', // 폭염 → cool 제품 매칭
  cold: 'heat', // 한파 → heat(난방) 제품 매칭
  rain: 'rain',
  dust: 'dust',
  uv: 'uv',
  humidity: 'humidity',
}

interface DailyEntry {
  date: string
  tmin?: number
  tmax?: number
  rain_prob?: number
  pm10?: string
  uv?: number
  humidity?: number
  alert_tags?: string[]
}

interface ForecastRow {
  region_code: string
  region_name: string
  forecast_base_at: string
  daily: DailyEntry[]
  active_tags: string[]
  collected_at: string
}

interface GgsanWithTags {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean | null
  image_url: string | null
  detail_url: string | null
  weather_tags: Record<string, number> | null
}

async function fetchLatestForecast(): Promise<ForecastRow | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_weather_forecast_latest' as never)
    .select('*')
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('weather_forecast_latest select error:', error.message)
    return null
  }
  return (data as ForecastRow | null) ?? null
}

async function fetchTaggedProducts(): Promise<GgsanWithTags[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_ggsan_products' as never)
    .select('goods_no, title, cate_label, price_krw, is_imminent, image_url, detail_url, weather_tags')
    .not('weather_tags', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(500)
  if (error) {
    console.warn('ggsan_products select error:', error.message)
    return []
  }
  return (data as GgsanWithTags[]) ?? []
}

function productMatchScore(p: GgsanWithTags, productTag: ProductTagKey): number {
  if (!p.weather_tags) return 0
  const v = p.weather_tags[productTag]
  if (typeof v !== 'number') return 0
  return v
}

function recommendOrderQty(matchScore: number, daysToPeak: number, isImminent: boolean): number {
  // 룰 V0: confidence × urgency × imminent. 실제 발주 산식은 V1에서 보정.
  const urgency = Math.max(0.3, 1.4 - daysToPeak * 0.12)
  const base = matchScore * urgency * 30
  return Math.max(1, Math.round(base * (isImminent ? 1.3 : 1.0)))
}

export default async function WeatherPinPage() {
  const forecast = await fetchLatestForecast()
  const products = await fetchTaggedProducts()

  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)

  const days: DailyEntry[] = (forecast?.daily ?? []).slice(0, 14)

  // 활성 경보별 매칭 SKU 그루핑
  const pinsByAlert: Record<
    string,
    {
      day: DailyEntry
      dayIndex: number
      products: { p: GgsanWithTags; score: number }[]
    }[]
  > = {}

  days.forEach((day, idx) => {
    for (const alertTag of day.alert_tags ?? []) {
      const productTag = ALERT_TO_PRODUCT_TAG[alertTag]
      if (!productTag) continue
      const matched = products
        .map((p) => ({ p, score: productMatchScore(p, productTag) }))
        .filter((x) => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
      if (matched.length === 0) continue
      pinsByAlert[alertTag] = pinsByAlert[alertTag] || []
      pinsByAlert[alertTag].push({ day, dayIndex: idx, products: matched })
    }
  })

  const activeTagList = Object.keys(pinsByAlert)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🌦 기상-수요 결합 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            KMA 단·중기 예보 × ggsan weather_tags — 임박 기상 SKU 사전 픽 / 발주 가이드
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {!forecast && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>기상 예보 데이터 없음.</strong> 마이그레이션{' '}
          <code className="font-mono text-xs">supabase/weather_forecast.sql</code> 적용 후{' '}
          <code className="font-mono text-xs">node --env-file=.env.local scripts/collect-weather-forecast.mjs</code> 실행 필요.
        </div>
      )}

      {forecast && (
        <section className="rounded border border-gray-200 p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">14일 기상 타임라인 — {forecast.region_name}</h2>
            <span className="text-xs text-gray-500">
              발표 {new Date(forecast.forecast_base_at).toLocaleString('ko-KR')}
            </span>
          </div>
          <div className="overflow-x-auto">
            <div className="flex gap-1 min-w-full">
              {days.map((d) => {
                const dayDate = new Date(d.date + 'T00:00:00')
                const dow = ['일', '월', '화', '수', '목', '금', '토'][dayDate.getDay()]
                const isToday = d.date === todayIso
                const hasAlert = (d.alert_tags ?? []).length > 0
                return (
                  <div
                    key={d.date}
                    className={`flex-1 min-w-[88px] rounded border p-2 text-center ${
                      isToday ? 'border-black bg-gray-50' : hasAlert ? 'border-red-200 bg-red-50/50' : 'border-gray-200'
                    }`}
                  >
                    <div className="text-[10px] text-gray-500">{d.date.slice(5)} ({dow})</div>
                    <div className="text-xs font-mono mt-1">
                      {typeof d.tmin === 'number' ? d.tmin : '-'}° / {typeof d.tmax === 'number' ? d.tmax : '-'}°
                    </div>
                    <div className="text-[10px] text-sky-700 mt-0.5">
                      💧 {typeof d.rain_prob === 'number' ? `${d.rain_prob}%` : '-'}
                    </div>
                    <div className="flex flex-wrap gap-0.5 justify-center mt-1 min-h-[18px]">
                      {(d.alert_tags ?? []).map((t) => (
                        <span
                          key={t}
                          title={TAG_META[t]?.reason ?? t}
                          className={`text-[10px] px-1 rounded ${TAG_META[t]?.color ?? 'bg-gray-100'}`}
                        >
                          {TAG_META[t]?.emoji ?? '•'}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* 활성 경보별 매칭 카드 */}
      {activeTagList.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">14일 내 매칭되는 기상 경보가 없음</div>
          <div className="text-xs text-gray-400">
            상품 weather_tags 가 부족할 수 있음 —{' '}
            <code className="font-mono">node --env-file=.env.local scripts/classify-weather-tags.mjs</code> 로 분류 갱신.
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {activeTagList.map((alertTag) => {
            const meta = TAG_META[alertTag]
            const buckets = pinsByAlert[alertTag]
            return (
              <section key={alertTag} className="rounded border border-gray-200 overflow-hidden">
                <header className={`px-4 py-2 ${meta?.color ?? 'bg-gray-100'}`}>
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-sm font-semibold">
                      {meta?.emoji} {meta?.label ?? alertTag} 경보 매칭 SKU
                    </h3>
                    <span className="text-[11px] opacity-80">{meta?.reason}</span>
                  </div>
                </header>
                <div className="divide-y divide-gray-100">
                  {buckets.map((b) => (
                    <div key={b.day.date} className="p-3 space-y-2">
                      <div className="text-xs font-mono text-gray-600">
                        D+{b.dayIndex} · {b.day.date} · 매칭 {b.products.length}건
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {b.products.map(({ p, score }) => (
                          <a
                            key={p.goods_no}
                            href={p.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener"
                            className="flex items-start gap-2 rounded border border-gray-200 p-2 hover:bg-gray-50"
                          >
                            <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                              {p.image_url && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={p.image_url}
                                  alt=""
                                  loading="lazy"
                                  className="w-full h-full object-cover"
                                />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium truncate">{p.title}</div>
                              <div className="text-[10px] text-gray-500">
                                {p.cate_label ?? '-'} · {p.price_krw ? `${p.price_krw.toLocaleString()}원` : '가격 X'}
                                {p.is_imminent && <span className="ml-1 text-red-700">· 임박</span>}
                              </div>
                              <div className="text-[10px] text-gray-700 mt-0.5">
                                매칭 confidence{' '}
                                <span className="font-mono font-semibold">{score.toFixed(2)}</span> · 권장 발주{' '}
                                <span className="font-mono font-semibold">
                                  {recommendOrderQty(score, b.dayIndex, !!p.is_imminent)}
                                </span>
                                개
                              </div>
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 weather_boost 산식 (V0)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          weather_boost = product.weather_tags[matched_tag] × urgency(daysToPeak)
          <br />
          urgency(d) = max(0.3, 1.4 − d × 0.12)
          <br />
          order_qty = round(weather_boost × 30 × imminent_multiplier)
        </code>
        <div className="pt-2">
          <strong>V1:</strong> KMA 단기예보(시간단위) 결합 · 강수량 mm 임계치 세분화 · 지역코드 다중화 · 발주 산식 실측 fitting
        </div>
      </section>
    </div>
  )
}
