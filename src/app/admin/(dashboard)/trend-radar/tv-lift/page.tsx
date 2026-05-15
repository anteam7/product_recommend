import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LiftRow {
  keyword: string
  tv_count: number
  first_seen: string
  last_seen: string
  pre_avg: number | null
  post_avg: number | null
  lift: number | null
  stddev_post: number | null
  sample_pre: number
  sample_post: number
  search_sources: string[]
}

const WINDOW_OPTIONS = [
  { v: 3, label: '±3일' },
  { v: 7, label: '±7일 (기본)' },
  { v: 14, label: '±14일' },
] as const

const MIN_TV_OPTIONS = [
  { v: 1, label: '1+ (전체)' },
  { v: 3, label: '3+' },
  { v: 5, label: '5+ (강한 푸시)' },
] as const

async function fetchLift(opts: { windowDays: number; minTvCount: number }) {
  const sb = createAdminClient()
  // RPC 미반영 — supabase/trends_v4_tv_lift.sql 적용 후 `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_tv_lift' as never, {
    window_days: opts.windowDays,
    min_tv_count: opts.minTvCount,
    result_limit: 500,
  } as never)
  if (error) {
    return { rows: [] as LiftRow[], error: error.message }
  }
  return { rows: (data ?? []) as LiftRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/tv-lift' + (qs ? `?${qs}` : '')
}

function liftColor(lift: number | null): string {
  if (lift == null) return 'text-gray-400'
  if (lift >= 2.0) return 'text-red-600 font-bold'
  if (lift >= 1.5) return 'text-amber-700 font-semibold'
  if (lift >= 1.1) return 'text-green-700'
  if (lift >= 0.9) return 'text-gray-500'
  return 'text-gray-400'
}

function liftBadge(lift: number | null): string {
  if (lift == null) return 'bg-gray-100 text-gray-500'
  if (lift >= 2.0) return 'bg-red-100 text-red-700'
  if (lift >= 1.5) return 'bg-amber-100 text-amber-800'
  if (lift >= 1.1) return 'bg-green-100 text-green-700'
  return 'bg-gray-100 text-gray-500'
}

export default async function TvLiftPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string; mtv?: string }>
}) {
  const sp = await searchParams
  const w = parseInt(sp.w ?? '7', 10)
  const validW = WINDOW_OPTIONS.some((d) => d.v === w) ? w : 7
  const mtv = parseInt(sp.mtv ?? '1', 10)
  const validMtv = MIN_TV_OPTIONS.some((d) => d.v === mtv) ? mtv : 1

  const current: Record<string, string> = {
    w: String(validW),
    mtv: String(validMtv),
  }

  const { rows, error } = await fetchLift({ windowDays: validW, minTvCount: validMtv })

  const measurable = rows.filter((r) => r.lift != null)
  const exploded = measurable.filter((r) => (r.lift ?? 0) >= 2.0)
  const elevated = measurable.filter((r) => (r.lift ?? 0) >= 1.5 && (r.lift ?? 0) < 2.0)
  const flat = measurable.filter((r) => (r.lift ?? 0) < 1.1)
  const avgLift =
    measurable.length > 0
      ? measurable.reduce((s, r) => s + (r.lift ?? 0), 0) / measurable.length
      : 0

  // scatter 데이터: X=편성수(tv_count), Y=lift
  const scatterPts = measurable
    .filter((r) => r.lift != null && r.tv_count != null)
    .map((r) => ({
      x: r.tv_count,
      y: r.lift as number,
      keyword: r.keyword,
      imminent: false,
    }))

  // 스케일: tv_count 1..max, lift 0..max(3, ceil(maxLift))
  const maxX = Math.max(10, ...scatterPts.map((p) => p.x))
  const maxY = Math.max(3, ...scatterPts.map((p) => Math.ceil(p.y)))

  const W = 720
  const H = 280
  const PAD = 36

  function sx(x: number) {
    return PAD + ((W - PAD * 2) * Math.log(x + 1)) / Math.log(maxX + 1)
  }
  function sy(y: number) {
    return H - PAD - ((H - PAD * 2) * y) / maxY
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📈 TV 편성 → 검색 lift 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            TV 키워드 첫 편성일 기준 ±{validW}일 검색량(naver_search_trend + naver_shopping_insight) 변화율
            — <strong>실제 시청자 반응</strong> 측정
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 해설 */}
      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 leading-relaxed">
        <strong>lift = post_avg / pre_avg</strong> · 사후 7일 평균 검색량 / 사전 7일 평균 검색량.
        lift ≥ 2.0 = 폭발 (위탁 1순위 후보) · 1.5~2.0 = 명확한 반응 ·
        1.1~1.5 = 약한 반응 · &lt;1.1 = 평탄/노이즈 (회피).
        표본이 부족(샘플 0)한 키워드는 lift NULL — 누적 누적되면 자동 측정 가능.
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">윈도우</span>
          {WINDOW_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { w: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validW === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">최소 편성</span>
          {MIN_TV_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { mtv: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validMtv === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="키워드 (lift 측정)" value={measurable.length} />
        <Kpi label="🔥 lift ≥ 2.0" value={exploded.length} highlight={exploded.length > 0} />
        <Kpi label="📈 lift 1.5~2.0" value={elevated.length} />
        <Kpi label="평탄 lift &lt; 1.1" value={flat.length} />
        <Kpi label="평균 lift" value={avgLift.toFixed(2)} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_tv_lift</code> 미적용 가능. <code>supabase/trends_v4_tv_lift.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {/* Scatter */}
      {!error && scatterPts.length > 0 && (
        <section className="rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold mb-2">분포: 편성수(log) × lift</h2>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
            {/* axes */}
            <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#d1d5db" strokeWidth="1" />
            <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#d1d5db" strokeWidth="1" />
            {/* lift=1 guideline */}
            <line
              x1={PAD}
              y1={sy(1)}
              x2={W - PAD}
              y2={sy(1)}
              stroke="#9ca3af"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <text x={W - PAD - 4} y={sy(1) - 4} fontSize="10" fill="#6b7280" textAnchor="end">
              lift=1 (변화 없음)
            </text>
            {/* lift=2 guideline */}
            <line
              x1={PAD}
              y1={sy(2)}
              x2={W - PAD}
              y2={sy(2)}
              stroke="#fca5a5"
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            <text x={W - PAD - 4} y={sy(2) - 4} fontSize="10" fill="#ef4444" textAnchor="end">
              lift=2 (폭발)
            </text>
            {/* y ticks */}
            {[0, 1, 2, maxY].map((t) => (
              <g key={t}>
                <text x={PAD - 6} y={sy(t) + 3} fontSize="10" fill="#6b7280" textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {/* x ticks (1, 5, 20, maxX) */}
            {[1, 5, 20, maxX].filter((x, i, arr) => arr.indexOf(x) === i && x <= maxX).map((t) => (
              <g key={t}>
                <text x={sx(t)} y={H - PAD + 14} fontSize="10" fill="#6b7280" textAnchor="middle">
                  {t}
                </text>
              </g>
            ))}
            {/* points */}
            {scatterPts.map((p, i) => (
              <circle
                key={i}
                cx={sx(p.x)}
                cy={sy(Math.min(p.y, maxY))}
                r="4"
                fill={p.y >= 2 ? '#dc2626' : p.y >= 1.5 ? '#d97706' : p.y >= 1.1 ? '#059669' : '#9ca3af'}
                fillOpacity="0.7"
              >
                <title>{`${p.keyword} · 편성 ${p.x}회 · lift ${p.y.toFixed(2)}`}</title>
              </circle>
            ))}
            {/* axis labels */}
            <text x={W / 2} y={H - 4} fontSize="11" fill="#374151" textAnchor="middle">
              편성수 (log 스케일)
            </text>
            <text
              x={12}
              y={H / 2}
              fontSize="11"
              fill="#374151"
              textAnchor="middle"
              transform={`rotate(-90 12 ${H / 2})`}
            >
              lift ratio
            </text>
          </svg>
        </section>
      )}

      {/* 랭킹 테이블 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">키워드 없음</div>
          <div className="text-xs text-gray-400">
            TV 편성(naver_tvtime) 데이터가 충분히 쌓이면 자동으로 채워집니다.
          </div>
        </div>
      ) : (
        <section className="rounded border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">키워드</th>
                <th className="px-3 py-2 text-right">편성수</th>
                <th className="px-3 py-2 text-right">pre_avg</th>
                <th className="px-3 py-2 text-right">post_avg</th>
                <th className="px-3 py-2 text-right">lift</th>
                <th className="px-3 py-2 text-right">σ(post)</th>
                <th className="px-3 py-2 text-right">표본</th>
                <th className="px-3 py-2 text-left">소스</th>
                <th className="px-3 py-2 text-left">첫 편성</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => (
                <tr key={r.keyword} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs">{i + 1}</td>
                  <td className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-2">
                      📺 {r.keyword}
                      {r.lift != null && r.lift >= 1.5 && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${liftBadge(r.lift)}`}>
                          ×{r.lift.toFixed(1)}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.tv_count}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-600">
                    {r.pre_avg != null ? Number(r.pre_avg).toFixed(1) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-600">
                    {r.post_avg != null ? Number(r.post_avg).toFixed(1) : '—'}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono ${liftColor(r.lift)}`}>
                    {r.lift != null ? `×${Number(r.lift).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                    {r.stddev_post != null ? Number(r.stddev_post).toFixed(1) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                    {r.sample_pre}/{r.sample_post}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {(r.search_sources ?? []).map((s) =>
                      s === 'naver_search_trend' ? '🔍' : s === 'naver_shopping_insight' ? '🛍' : s,
                    ).join(' ')}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 font-mono">
                    {r.first_seen?.slice(5, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 lift 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          first_seen = MIN(collected_at) where source=&apos;naver_tvtime&apos;
          <br />
          pre_avg  = AVG(volume_relative) for [first_seen - W, first_seen)  in search/shopping_insight
          <br />
          post_avg = AVG(volume_relative) for [first_seen, first_seen + W]  in search/shopping_insight
          <br />
          lift = post_avg / pre_avg
        </code>
        <div className="pt-2">
          ggsan 추천 점수에는 매칭된 TV 키워드 중 MAX(lift) 가 <code>× (1 + ln(max(lift, 1)))</code> 로 반영됩니다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
