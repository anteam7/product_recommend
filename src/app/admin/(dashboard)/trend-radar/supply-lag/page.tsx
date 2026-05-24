import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CategoryStat {
  cate_cd: string
  cate_label: string | null
  pair_count: number
  median_lag: number | null
  p10_lag: number | null
  p90_lag: number | null
  mean_lag: number | null
  fast_supply: boolean
}

interface PinnedPosition {
  keyword: string
  source: string
  keyword_first_seen: string
  age_days: number
  cate_cd: string | null
  cate_label: string | null
  best_sim: number | null
  category_median_lag: number | null
  category_p90_lag: number | null
  pair_count: number | null
  fast_supply: boolean
  gate: 'leading' | 'on_time' | 'late' | 'unknown'
}

const DAYS_OPTIONS = [
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일 (기본)' },
  { v: 180, label: '180일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

async function fetchStats(opts: { days: number; minSim: number }) {
  const sb = createAdminClient()
  const [statsRes, pinnedRes] = await Promise.all([
    sb.rpc('jimscanner_trends_supply_lag_category_stats' as never, {
      days_window: opts.days,
      min_sim: opts.minSim,
    } as never),
    sb.rpc('jimscanner_trends_supply_lag_pinned_position' as never, {
      days_window: opts.days,
      min_sim: opts.minSim,
    } as never),
  ])
  return {
    stats: ((statsRes.data ?? []) as CategoryStat[]),
    pinned: ((pinnedRes.data ?? []) as PinnedPosition[]),
    statsError: statsRes.error?.message ?? null,
    pinnedError: pinnedRes.error?.message ?? null,
  }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/supply-lag' + (qs ? `?${qs}` : '')
}

function gateBadge(gate: PinnedPosition['gate']) {
  switch (gate) {
    case 'leading':
      return <span className="text-xs bg-emerald-600 text-white px-2 py-0.5 rounded">선행 가능</span>
    case 'on_time':
      return <span className="text-xs bg-amber-500 text-white px-2 py-0.5 rounded">윈도우 안</span>
    case 'late':
      return <span className="text-xs bg-gray-500 text-white px-2 py-0.5 rounded">이미 늦음</span>
    default:
      return <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">데이터 부족</span>
  }
}

function fmtLag(n: number | null): string {
  if (n == null) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${Number(n).toFixed(1)}일`
}

export default async function SupplyLagPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '90', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 90
  const minSim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001) ? minSim : 0.2

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
  }

  const { stats, pinned, statsError, pinnedError } = await fetchStats({
    days: validDays,
    minSim: validSim,
  })

  // 가장 큰 median lag (막대 스케일)
  const maxLag = Math.max(
    1,
    ...stats.map((s) => Math.max(Math.abs(Number(s.median_lag ?? 0)), Math.abs(Number(s.p90_lag ?? 0))))
  )

  const fastCount = stats.filter((s) => s.fast_supply).length
  const leadingCount = pinned.filter((p) => p.gate === 'leading').length
  const lateCount = pinned.filter((p) => p.gate === 'late').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">트렌드 → ggsan 공급 래그</h1>
          <p className="text-sm text-gray-500 mt-1">
            트렌드 키워드가 등장한 시점과 ggsan 도매 풀에 동일/유사 SKU 가 인입되기까지의 일수(lag).
            카테고리별 분포로 <strong>선행 진입 가능</strong> / <strong>이미 늦음</strong> 게이트를 측정한다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">유사도 ≥</span>
          {SIM_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sim: String(s.v) })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="카테고리 (≥1 pair)" value={stats.length} />
        <Kpi label="🚀 fast-supply (median<3일)" value={fastCount} highlight={fastCount > 0} />
        <Kpi label="✨ 선행 가능 핀" value={leadingCount} highlight={leadingCount > 0} />
        <Kpi label="⚠ 이미 늦은 핀" value={lateCount} />
      </section>

      {(statsError || pinnedError) && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700 space-y-1">
          {statsError && <div>category_stats RPC error: {statsError}</div>}
          {pinnedError && <div>pinned_position RPC error: {pinnedError}</div>}
          <div className="text-red-600">
            SQL 미반영일 수 있음 — <code>supabase/trends_v4_supply_lag.sql</code> 적용 필요.
          </div>
        </div>
      )}

      {/* (1) 카테고리별 평균 인입 래그 막대 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold">📊 카테고리별 평균 인입 래그 (median, 일)</h2>
        <p className="text-xs text-gray-500">
          음수 = ggsan 에 이미 SKU 가 있던 카테고리 (도매처가 트렌드보다 빠름) · 양수 = 트렌드 후 도매 인입까지 일수.
          <strong className="text-emerald-700"> fast-supply (&lt;3일)</strong> = 즉시 공급 가능 카테고리.
        </p>
        {stats.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-8">매칭된 페어 없음 — 기간 확장 또는 유사도 완화</div>
        ) : (
          <div className="space-y-1">
            {stats.map((s) => {
              const median = Number(s.median_lag ?? 0)
              const width = Math.min(100, (Math.abs(median) / maxLag) * 100)
              const isPositive = median >= 0
              return (
                <div key={s.cate_cd} className="flex items-center gap-3 text-xs">
                  <div className="w-32 truncate font-medium" title={`${s.cate_label} (${s.cate_cd})`}>
                    {s.fast_supply && <span className="text-emerald-600">🚀 </span>}
                    {s.cate_label ?? s.cate_cd}
                  </div>
                  <div className="flex-1 flex items-center">
                    <div className="w-1/2 flex justify-end">
                      {!isPositive && (
                        <div
                          className="h-4 bg-blue-300 rounded-l"
                          style={{ width: `${width}%` }}
                          title={`median ${median}일`}
                        />
                      )}
                    </div>
                    <div className="w-px h-4 bg-gray-400" />
                    <div className="w-1/2">
                      {isPositive && (
                        <div
                          className={`h-4 rounded-r ${s.fast_supply ? 'bg-emerald-400' : 'bg-amber-300'}`}
                          style={{ width: `${width}%` }}
                          title={`median ${median}일`}
                        />
                      )}
                    </div>
                  </div>
                  <div className="w-48 text-right font-mono text-gray-600">
                    median {fmtLag(s.median_lag)} · p10 {fmtLag(s.p10_lag)} · p90 {fmtLag(s.p90_lag)}
                  </div>
                  <div className="w-12 text-right text-gray-400">n={s.pair_count}</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* (2) 핀 후보 위치 게이트 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold">🎯 현재 핀 후보 — 카테고리 lag 분포 내 위치</h2>
        <p className="text-xs text-gray-500">
          핀 키워드 등장 후 경과일(<strong>age</strong>)을 그 카테고리의 median/p90 과 비교 — 선행/윈도우/늦음.
        </p>
        {pinned.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-8">
            현재 기간 내 핀된 키워드 없음 — <Link href="/admin/trend-radar/pins" className="underline">핀 페이지</Link>에서 추가
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="text-left p-2">게이트</th>
                  <th className="text-left p-2">키워드</th>
                  <th className="text-left p-2">소스</th>
                  <th className="text-left p-2">매칭 카테고리</th>
                  <th className="text-right p-2">age</th>
                  <th className="text-right p-2">카테 median</th>
                  <th className="text-right p-2">카테 p90</th>
                  <th className="text-right p-2">sim</th>
                </tr>
              </thead>
              <tbody>
                {pinned.map((p) => (
                  <tr key={`${p.keyword}-${p.source}`} className="border-b border-gray-100 hover:bg-amber-50">
                    <td className="p-2">{gateBadge(p.gate)}</td>
                    <td className="p-2 font-medium">
                      {p.keyword}
                      {p.fast_supply && <span className="ml-1 text-emerald-600" title="fast-supply 카테고리">🚀</span>}
                    </td>
                    <td className="p-2 text-gray-500 font-mono">{p.source}</td>
                    <td className="p-2">
                      {p.cate_label ? (
                        <span>
                          {p.cate_label}{' '}
                          <span className="text-gray-400">({p.cate_cd})</span>
                        </span>
                      ) : (
                        <span className="text-gray-400">매칭 ggsan 없음</span>
                      )}
                    </td>
                    <td className="p-2 text-right font-mono">{fmtLag(p.age_days)}</td>
                    <td className="p-2 text-right font-mono text-gray-600">{fmtLag(p.category_median_lag)}</td>
                    <td className="p-2 text-right font-mono text-gray-600">{fmtLag(p.category_p90_lag)}</td>
                    <td className="p-2 text-right font-mono text-gray-400">
                      {p.best_sim != null ? Number(p.best_sim).toFixed(3) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* (3) 의사결정 가이드 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>측정:</strong> lag = <code>ggsan.first_seen_at - keyword.MIN(collected_at)</code>.
          매칭은 pg_trgm <code>similarity(keyword, ggsan.title) ≥ {validSim}</code> · 키워드당 상위 3개 후보.
        </div>
        <div>
          <strong>해석:</strong>{' '}
          <span className="text-emerald-700">선행 가능</span> = 트렌드 등장 후 카테고리 median 보다 일찍 = 도매 인입 전 진입 윈도우 열림 ·
          <span className="text-amber-700"> 윈도우 안</span> = median~p90 사이 = 막차 ·
          <span className="text-gray-700"> 이미 늦음</span> = p90 초과.
        </div>
        <div>
          <strong>fast-supply (median&lt;3일):</strong> 도매처 인입 속도가 매우 빨라 선행 진입 윈도우가 좁은 카테고리. 가격경쟁 우위가 곧장 결정 변수.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
