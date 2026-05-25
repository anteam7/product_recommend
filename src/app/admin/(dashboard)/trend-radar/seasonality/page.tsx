import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const TABS = ['shock', 'seasonal', 'momentum'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  shock: '🚨 외생충격 (residual spike)',
  seasonal: '📅 시즌 핀 큐',
  momentum: '📈 순수 모멘텀',
}

const TAB_HINT: Record<Tab, string> = {
  shock:
    '잔차(residual)가 +2σ 이상으로 튄 키워드. 요일·트렌드 성분을 제거한 뒤 남은 순수 외생충격.',
  seasonal:
    'seasonal strength 가 높은 키워드. 요일성이 강해 매주 동일 패턴이 반복됨 — 시즌 핀 라이브러리 후보.',
  momentum:
    '트렌드 성분의 최근 14일 기울기가 양수인 키워드. 시즌 효과를 빼고도 진짜로 상승 중.',
}

interface StlRow {
  keyword: string
  source: string | null
  category_top: string | null
  n_points: number
  seasonal_strength: number
  trend_strength: number
  trend_slope: number
  last_observed: number
  last_trend: number
  last_seasonal: number
  last_residual: number
  residual_std: number
  last_residual_z: number
  residual_spike: boolean
}

async function fetchStl(): Promise<StlRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_keyword_stl_summary' as never,
    {
      window_days: 90,
      min_points: 14,
      result_limit: 500,
    } as never,
  )
  if (error) {
    console.error('[seasonality] stl_summary error', error)
    return []
  }
  return ((data as unknown as StlRow[]) ?? []).map((r) => ({
    ...r,
    seasonal_strength: Number(r.seasonal_strength ?? 0),
    trend_strength: Number(r.trend_strength ?? 0),
    trend_slope: Number(r.trend_slope ?? 0),
    last_observed: Number(r.last_observed ?? 0),
    last_trend: Number(r.last_trend ?? 0),
    last_seasonal: Number(r.last_seasonal ?? 0),
    last_residual: Number(r.last_residual ?? 0),
    residual_std: Number(r.residual_std ?? 0),
    last_residual_z: Number(r.last_residual_z ?? 0),
  }))
}

function pickRows(rows: StlRow[], tab: Tab): StlRow[] {
  if (tab === 'shock') {
    return [...rows]
      .filter((r) => r.residual_spike && r.last_residual_z > 0)
      .sort((a, b) => b.last_residual_z - a.last_residual_z)
      .slice(0, 60)
  }
  if (tab === 'seasonal') {
    return [...rows]
      .filter((r) => r.seasonal_strength >= 0.3)
      .sort((a, b) => b.seasonal_strength - a.seasonal_strength)
      .slice(0, 60)
  }
  return [...rows]
    .filter((r) => r.trend_slope > 0)
    .sort((a, b) => b.trend_slope - a.trend_slope)
    .slice(0, 60)
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '–'
  return n.toFixed(digits)
}

export default async function SeasonalityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const sp = await searchParams
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : 'shock') as Tab
  const rows = await fetchStl()
  const view = pickRows(rows, tab)

  const totals = {
    all: rows.length,
    shock: rows.filter((r) => r.residual_spike && r.last_residual_z > 0).length,
    seasonal: rows.filter((r) => r.seasonal_strength >= 0.3).length,
    momentum: rows.filter((r) => r.trend_slope > 0).length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">STL 시즌성·트렌드 분해</h1>
          <p className="text-sm text-gray-500 mt-1">
            jimscanner_trends_keywords 90일 시계열 → trend / weekly-seasonal(period=7) / residual
            3개 성분 분리. 요일 효과를 빼고 본 진짜 신호.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="분해된 키워드" value={totals.all} hint="14일 이상 누적" />
        <Kpi label="🚨 외생충격" value={totals.shock} hint="잔차 |z| ≥ 2σ" />
        <Kpi label="📅 시즌 핀 후보" value={totals.seasonal} hint="seasonal strength ≥ 0.3" />
        <Kpi label="📈 순수 모멘텀" value={totals.momentum} hint="trend slope > 0" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/admin/trend-radar/seasonality?tab=${t}`}
            className={`px-3 py-2 text-sm ${
              tab === t
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {TAB_LABEL[t]}
          </Link>
        ))}
      </nav>

      <p className="text-xs text-gray-500 -mt-3">{TAB_HINT[tab]}</p>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 분해할 데이터 없음</p>
          <p className="text-sm mt-2">
            RPC <code className="px-1 bg-gray-100 rounded">jimscanner_keyword_stl_summary</code>{' '}
            적용 후 다시 방문하거나, 키워드 시계열이 14일 이상 누적되어야 합니다.
          </p>
        </div>
      ) : view.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          이 탭의 필터를 통과한 키워드 없음.
        </div>
      ) : (
        <Table rows={view} tab={tab} />
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Table({ rows, tab }: { rows: StlRow[]; tab: Tab }) {
  return (
    <div className="grid gap-1">
      <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
        <div className="col-span-1">#</div>
        <div className="col-span-3">키워드</div>
        <div className="col-span-2">source · cat</div>
        <div className="col-span-1 text-right">obs</div>
        <div className="col-span-1 text-right">trend</div>
        <div className="col-span-1 text-right">seasonal</div>
        <div className="col-span-1 text-right">resid z</div>
        <div className="col-span-1 text-right">slope/d</div>
        <div className="col-span-1 text-right">s.str</div>
      </div>
      {rows.map((r, i) => {
        const highlight =
          tab === 'shock'
            ? r.last_residual_z >= 3
              ? 'bg-red-50'
              : 'bg-amber-50/40'
            : tab === 'seasonal'
              ? r.seasonal_strength >= 0.5
                ? 'bg-indigo-50'
                : ''
              : r.trend_slope >= 1
                ? 'bg-emerald-50'
                : ''
        return (
          <div
            key={r.keyword}
            className={`grid grid-cols-12 px-3 py-2 rounded border border-gray-100 ${highlight}`}
          >
            <div className="col-span-1 text-gray-400 font-mono text-xs">{i + 1}</div>
            <div className="col-span-3">
              <div className="font-medium text-sm truncate">{r.keyword}</div>
              <div className="text-xs text-gray-400">n={r.n_points}</div>
            </div>
            <div className="col-span-2 text-xs text-gray-500 truncate">
              {(r.source ?? '—').replace('naver_', '')}
              {r.category_top ? ` · ${r.category_top}` : ''}
            </div>
            <div className="col-span-1 text-right font-mono text-xs">
              {fmt(r.last_observed, 1)}
            </div>
            <div className="col-span-1 text-right font-mono text-xs text-gray-600">
              {fmt(r.last_trend, 1)}
            </div>
            <div className="col-span-1 text-right font-mono text-xs text-gray-600">
              {fmt(r.last_seasonal, 1)}
            </div>
            <div
              className={`col-span-1 text-right font-mono text-xs ${
                r.last_residual_z >= 2
                  ? 'font-bold text-red-700'
                  : r.last_residual_z <= -2
                    ? 'font-bold text-blue-700'
                    : 'text-gray-600'
              }`}
            >
              {fmt(r.last_residual_z, 2)}
            </div>
            <div
              className={`col-span-1 text-right font-mono text-xs ${
                r.trend_slope > 0 ? 'text-emerald-700' : r.trend_slope < 0 ? 'text-red-700' : 'text-gray-500'
              }`}
            >
              {fmt(r.trend_slope, 2)}
            </div>
            <div className="col-span-1 text-right font-mono text-xs text-gray-600">
              {fmt(r.seasonal_strength, 2)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
