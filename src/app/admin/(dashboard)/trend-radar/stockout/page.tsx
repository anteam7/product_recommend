import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PinButton from './PinButton'

export const dynamic = 'force-dynamic'

interface TrendRow {
  keyword: string
  day: string
  total_cards: number
  oos: number
  presale: number
  restock: number
  pressure: number
  days_observed: number
  avg_pressure_recent: number
  avg_pressure_prior: number
  trending_up: boolean
  peak_pressure: number
  latest_captured_at: string
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일 (기본)' },
  { v: 30, label: '30일' },
] as const

async function fetchTrend(daysWindow: number) {
  const sb = createAdminClient()
  // generated 타입 미반영 — `npm run gen:types` 후 캐스팅 제거.
  const { data, error } = await sb.rpc(
    'jimscanner_stockout_pressure_trend' as never,
    { days_window: daysWindow } as never,
  )
  if (error) return { rows: [] as TrendRow[], error: error.message }
  return { rows: (data ?? []) as unknown as TrendRow[], error: null as string | null }
}

function pressureColor(p: number): string {
  if (p <= 0) return 'bg-gray-50 text-gray-300'
  if (p < 0.1) return 'bg-emerald-50 text-emerald-700'
  if (p < 0.25) return 'bg-amber-50 text-amber-700'
  if (p < 0.4) return 'bg-orange-100 text-orange-800'
  if (p < 0.6) return 'bg-red-100 text-red-800'
  return 'bg-red-200 text-red-900 font-semibold'
}

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`
}

function lastNDays(n: number): string[] {
  const out: string[] = []
  const now = new Date()
  // KST 기준 일자 — 단순화: now 의 UTC 일자에 +9h
  const kst = new Date(now.getTime() + 9 * 3600_000)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(kst.getTime() - i * 86400_000)
    const y = d.getUTCFullYear()
    const m = pad2(d.getUTCMonth() + 1)
    const day = pad2(d.getUTCDate())
    out.push(`${y}-${m}-${day}`)
  }
  return out
}

export default async function StockoutPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; trendingOnly?: string }>
}) {
  const sp = await searchParams
  const daysWindow = DAYS_OPTIONS.find((o) => String(o.v) === sp.days)?.v ?? 14
  const trendingOnly = sp.trendingOnly === '1'

  const { rows, error } = await fetchTrend(daysWindow)

  // keyword 별로 그룹핑
  type KwAgg = {
    keyword: string
    avg_recent: number
    avg_prior: number
    peak: number
    trending_up: boolean
    days_observed: number
    latest_captured_at: string
    daily: Map<string, TrendRow>
  }
  const byKw = new Map<string, KwAgg>()
  for (const r of rows) {
    let agg = byKw.get(r.keyword)
    if (!agg) {
      agg = {
        keyword: r.keyword,
        avg_recent: r.avg_pressure_recent,
        avg_prior: r.avg_pressure_prior,
        peak: r.peak_pressure,
        trending_up: r.trending_up,
        days_observed: r.days_observed,
        latest_captured_at: r.latest_captured_at,
        daily: new Map(),
      }
      byKw.set(r.keyword, agg)
    }
    agg.daily.set(r.day, r)
  }

  const grouped = [...byKw.values()].sort(
    (a, b) => b.avg_recent - a.avg_recent || a.keyword.localeCompare(b.keyword),
  )

  // Top-N: OOS ≥ 40% & 7일 상승추세
  const topN = grouped
    .filter((g) => g.avg_recent >= 0.4 && g.trending_up)
    .slice(0, 20)

  const heatmapKws = trendingOnly
    ? grouped.filter((g) => g.trending_up).slice(0, 30)
    : grouped.slice(0, 30)
  const heatDays = lastNDays(daysWindow)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Stockout Pressure Index</h1>
          <p className="text-sm text-gray-500 mt-1">
            네이버 쇼핑 SERP 카드의 '품절/예약/재입고알림' 비율 — 공급 부족 = 진입 기회.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-500">윈도:</span>
        {DAYS_OPTIONS.map((o) => {
          const active = o.v === daysWindow
          const href = `/admin/trend-radar/stockout?days=${o.v}${
            trendingOnly ? '&trendingOnly=1' : ''
          }`
          return (
            <Link
              key={o.v}
              href={href}
              className={`px-2 py-1 rounded border ${
                active
                  ? 'border-black bg-black text-white'
                  : 'border-gray-300 hover:border-black'
              }`}
            >
              {o.label}
            </Link>
          )
        })}
        <span className="mx-2 text-gray-300">|</span>
        <Link
          href={`/admin/trend-radar/stockout?days=${daysWindow}${
            trendingOnly ? '' : '&trendingOnly=1'
          }`}
          className={`px-2 py-1 rounded border ${
            trendingOnly
              ? 'border-red-300 bg-red-50 text-red-700'
              : 'border-gray-300 hover:border-black'
          }`}
        >
          {trendingOnly ? '✓ 상승만' : '상승만'}
        </Link>
      </nav>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          RPC 오류: {error} — 마이그레이션{' '}
          <code className="bg-white px-1 rounded">
            supabase/trends_v4_serp_stockout.sql
          </code>{' '}
          적용 필요.
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="추적 키워드" value={byKw.size} hint={`최근 ${daysWindow}일`} />
        <Kpi
          label="OOS≥40% & 상승"
          value={topN.length}
          hint="진입 후보 보드"
        />
        <Kpi
          label="평균 압력"
          value={
            byKw.size > 0
              ? Math.round(
                  ([...byKw.values()].reduce((s, g) => s + g.avg_recent, 0) /
                    byKw.size) *
                    100,
                )
              : 0
          }
          hint="% (recent avg)"
        />
        <Kpi
          label="피크 압력"
          value={
            byKw.size > 0
              ? Math.round(
                  Math.max(...[...byKw.values()].map((g) => g.peak)) * 100,
                )
              : 0
          }
          hint="% 최고값"
        />
      </section>

      {/* (b) Top-N */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">
          🚨 OOS≥40% · 7일 상승추세 Top {topN.length}{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            (한 클릭으로 핀 후보 큐로)
          </span>
        </h2>
        {topN.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            아직 조건 통과 없음. 수집 누적 후 다시 확인.
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 bg-gray-50">
              <div className="col-span-4">키워드</div>
              <div className="col-span-2 text-right">7d 평균</div>
              <div className="col-span-2 text-right">직전 7d</div>
              <div className="col-span-1 text-right">피크</div>
              <div className="col-span-1 text-right">관측일</div>
              <div className="col-span-2 text-right">액션</div>
            </div>
            {topN.map((g) => (
              <div
                key={g.keyword}
                className="grid grid-cols-12 px-3 py-2 text-sm items-center"
              >
                <div className="col-span-4 font-medium truncate">{g.keyword}</div>
                <div
                  className={`col-span-2 text-right font-mono ${pressureColor(g.avg_recent)} rounded px-1`}
                >
                  {(g.avg_recent * 100).toFixed(0)}%
                </div>
                <div className="col-span-2 text-right font-mono text-gray-500">
                  {(g.avg_prior * 100).toFixed(0)}%
                </div>
                <div className="col-span-1 text-right font-mono text-gray-700">
                  {(g.peak * 100).toFixed(0)}%
                </div>
                <div className="col-span-1 text-right text-xs text-gray-400">
                  {g.days_observed}
                </div>
                <div className="col-span-2 text-right">
                  <PinButton keyword={g.keyword} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* (a) 히트맵 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">
          🌡️ 키워드 × 일자 OOS 히트맵{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            (상위 {heatmapKws.length}개 · pressure% 컬러)
          </span>
        </h2>
        {heatmapKws.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            아직 스냅샷 없음. <code>/api/cron/snapshot-naver-stockout</code> 가{' '}
            <code>jimscanner_trends_seeds(source='serp_stockout')</code> 시드를
            읽어 적재.
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="text-xs">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-2 py-1 text-left sticky left-0 bg-gray-50">
                    키워드
                  </th>
                  {heatDays.map((d) => (
                    <th
                      key={d}
                      className="px-1 py-1 text-center font-normal text-gray-500"
                    >
                      {d.slice(5)}
                    </th>
                  ))}
                  <th className="px-2 py-1 text-right">7d avg</th>
                </tr>
              </thead>
              <tbody>
                {heatmapKws.map((g) => (
                  <tr key={g.keyword} className="border-t border-gray-100">
                    <td className="px-2 py-1 sticky left-0 bg-white max-w-[160px] truncate">
                      {g.trending_up && (
                        <span className="text-red-600 mr-1" title="상승 추세">
                          ▲
                        </span>
                      )}
                      {g.keyword}
                    </td>
                    {heatDays.map((d) => {
                      const cell = g.daily.get(d)
                      const p = cell?.pressure ?? 0
                      const cls = cell ? pressureColor(p) : 'bg-gray-50 text-gray-300'
                      return (
                        <td
                          key={d}
                          className={`px-1 py-1 text-center font-mono ${cls}`}
                          title={
                            cell
                              ? `${d} · ${cell.total_cards}카드 · oos ${cell.oos}/presale ${cell.presale}/restock ${cell.restock}`
                              : `${d} · 데이터 없음`
                          }
                        >
                          {cell ? Math.round(p * 100) : '·'}
                        </td>
                      )
                    })}
                    <td className="px-2 py-1 text-right font-mono">
                      {(g.avg_recent * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="text-xs text-gray-500 border-t border-gray-200 pt-3">
        수집: <code>scripts/run-crons.mjs snapshot-naver-stockout</code> (또는 직접
        Vercel <code>/api/cron/snapshot-naver-stockout</code>). 시드는{' '}
        <code>jimscanner_trends_seeds(source='serp_stockout')</code> — 시드가 없으면
        최근 키워드 풀에서 자동 picks. 카드 라벨 매칭: 품절/예약/재입고알림 정규식.
      </div>
    </div>
  )
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
