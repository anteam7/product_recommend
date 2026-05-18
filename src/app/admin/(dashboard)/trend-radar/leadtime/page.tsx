import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LeadtimeRow {
  source: string
  category_top: string
  lead_days: number | null
  predictive_strength: number | null
  sample_n: number
}

interface EarlyMoverRow {
  keyword: string
  source: string
  category_top: string
  predictive_strength: number | null
  lead_days: number | null
  first_seen: string
}

const DEFAULT_WINDOW_DAYS = 30
const EARLY_HOURS_WINDOW = 24
const EARLY_MIN_STRENGTH = 0.4
const EARLY_MIN_SAMPLE_N = 3

async function fetchLeadtime(windowDays: number): Promise<LeadtimeRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb.rpc as any)('jimscanner_source_leadtime', {
    window_days: windowDays,
  })
  if (error) {
    console.error('[leadtime] rpc error', error)
    return []
  }
  return (data ?? []) as LeadtimeRow[]
}

async function fetchEarlyMovers(): Promise<EarlyMoverRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb.rpc as any)('jimscanner_early_movers', {
    hours_window: EARLY_HOURS_WINDOW,
    min_strength: EARLY_MIN_STRENGTH,
    min_sample_n: EARLY_MIN_SAMPLE_N,
    window_days: DEFAULT_WINDOW_DAYS,
  })
  if (error) {
    console.error('[early_movers] rpc error', error)
    return []
  }
  return (data ?? []) as EarlyMoverRow[]
}

// 색: lead_days (음수=후행, 0=동행, 양수=선행) → 빨강~회색~파랑
function leadBg(lead: number | null, strength: number | null): string {
  if (lead == null) return 'bg-gray-50 text-gray-400'
  const s = Math.max(0.2, Math.min(1, strength ?? 0.2))
  // 선행(양수)일수록 파랑, 후행(음수)일수록 빨강
  if (lead > 0) {
    const intensity = Math.min(1, lead / 5)
    const alpha = Math.round(s * intensity * 100)
    return `text-blue-900 bg-blue-500/[${alpha}%]`
  }
  if (lead < 0) {
    const intensity = Math.min(1, Math.abs(lead) / 5)
    const alpha = Math.round(s * intensity * 100)
    return `text-red-900 bg-red-500/[${alpha}%]`
  }
  return 'bg-gray-100 text-gray-700'
}

// Tailwind 의 동적 클래스 안전성 위해 직접 inline style 로 폴백
function cellStyle(lead: number | null, strength: number | null): React.CSSProperties {
  if (lead == null) return { background: '#f9fafb', color: '#9ca3af' }
  const s = Math.max(0.15, Math.min(1, strength ?? 0.15))
  if (lead > 0) {
    const intensity = Math.min(1, lead / 5)
    return { background: `rgba(37, 99, 235, ${(s * intensity).toFixed(2)})`, color: '#0c2a6b' }
  }
  if (lead < 0) {
    const intensity = Math.min(1, Math.abs(lead) / 5)
    return { background: `rgba(220, 38, 38, ${(s * intensity).toFixed(2)})`, color: '#7f1d1d' }
  }
  return { background: '#f3f4f6', color: '#374151' }
}

export default async function LeadtimePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const windowDays = (() => {
    const n = Number(sp.days)
    if (!Number.isFinite(n)) return DEFAULT_WINDOW_DAYS
    return Math.max(7, Math.min(180, Math.round(n)))
  })()

  const [matrix, movers] = await Promise.all([fetchLeadtime(windowDays), fetchEarlyMovers()])

  // 행=source / 열=category_top
  const sources = [...new Set(matrix.map((r) => r.source))].sort()
  const categories = [...new Set(matrix.map((r) => r.category_top))].sort()
  const cell = new Map<string, LeadtimeRow>()
  for (const r of matrix) cell.set(`${r.source}|${r.category_top}`, r)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Source × Category Lead-Time 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            소스별 카테고리 스파이크가 컨센서스 정점을 며칠 선행하는지 학습 ·{' '}
            <span className="text-blue-700">파랑=선행(좋음)</span> ·{' '}
            <span className="text-red-700">빨강=후행</span> · 밝기=예측력
          </p>
        </div>
        <nav className="flex gap-1 text-xs">
          {[7, 14, 30, 60, 90].map((d) => (
            <Link
              key={d}
              href={`/admin/trend-radar/leadtime?days=${d}`}
              className={`px-2 py-1 rounded border ${
                d === windowDays
                  ? 'border-black bg-black text-white'
                  : 'border-gray-200 text-gray-600 hover:border-gray-400'
              }`}
            >
              {d}d
            </Link>
          ))}
        </nav>
      </header>

      {/* Today's Early Movers */}
      <section className="rounded border border-blue-200 bg-blue-50/40 p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">
            🌅 Today&apos;s Early Movers{' '}
            <span className="text-xs font-normal text-gray-500 ml-2">
              (지난 {EARLY_HOURS_WINDOW}h · 예측력 ≥{EARLY_MIN_STRENGTH} · 표본 ≥{EARLY_MIN_SAMPLE_N} 소스에서만)
            </span>
          </h2>
          <span className="text-xs text-gray-500">{movers.length}건</span>
        </div>
        {movers.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 신뢰할 만한 early-mover 신호가 없습니다. 데이터가 더 쌓이면 자동 노출됩니다.
          </div>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
              <div className="col-span-5">키워드</div>
              <div className="col-span-3">소스</div>
              <div className="col-span-2">카테고리</div>
              <div className="col-span-1 text-right">예측력</div>
              <div className="col-span-1 text-right">선행</div>
            </div>
            {movers.slice(0, 40).map((m, i) => (
              <div
                key={`${m.keyword}|${m.source}|${i}`}
                className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-white"
              >
                <div className="col-span-5 truncate font-medium">{m.keyword}</div>
                <div className="col-span-3 text-xs text-gray-600">{m.source}</div>
                <div className="col-span-2 text-xs text-gray-500">{m.category_top}</div>
                <div className="col-span-1 text-right font-mono text-xs">
                  {m.predictive_strength != null ? m.predictive_strength.toFixed(2) : '–'}
                </div>
                <div className="col-span-1 text-right font-mono text-xs text-blue-700">
                  {m.lead_days != null ? `+${m.lead_days}d` : '–'}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 히트맵 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          격자 히트맵{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            ({sources.length} 소스 × {categories.length} 카테고리 · 표본 {matrix.reduce((s, r) => s + r.sample_n, 0)} 스파이크)
          </span>
        </h2>
        {matrix.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">매트릭스 데이터가 비어 있습니다</p>
            <p className="text-sm mt-2">
              window={windowDays}d 안에 스파이크 매칭이 부족합니다. window 를 넓혀 보세요.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white p-1 text-left text-gray-500 border-b border-gray-200">
                    source \ category
                  </th>
                  {categories.map((c) => (
                    <th
                      key={c}
                      className="p-1 text-left text-gray-700 border-b border-gray-200 min-w-[88px]"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s}>
                    <td className="sticky left-0 bg-white p-1 pr-3 font-medium text-gray-700 border-r border-gray-100 whitespace-nowrap">
                      {s}
                    </td>
                    {categories.map((c) => {
                      const r = cell.get(`${s}|${c}`)
                      return (
                        <td
                          key={c}
                          className="p-1 text-center border border-white"
                          style={cellStyle(r?.lead_days ?? null, r?.predictive_strength ?? null)}
                          title={
                            r
                              ? `lead=${r.lead_days ?? '–'}d · strength=${r.predictive_strength ?? '–'} · n=${r.sample_n}`
                              : 'no data'
                          }
                        >
                          {r?.lead_days != null ? (
                            <>
                              <div className="font-mono font-bold">
                                {r.lead_days > 0 ? '+' : ''}
                                {r.lead_days}
                              </div>
                              <div className="text-[10px] opacity-70">
                                {r.predictive_strength?.toFixed(2)} · n{r.sample_n}
                              </div>
                            </>
                          ) : (
                            <span className="text-gray-300">·</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-500 mt-3">
          셀 = 평균 선행일수(±0~7d) · 밝기 = 예측력(spike 후 7일 내 컨센서스 peak 비율) · 표본 n≥2 만 표시.
          음수(빨강)는 컨센서스 직전에 spike → 후행성, 양수(파랑)는 spike 가 peak 를 끌어옴 → 선행성.
        </p>
      </section>
    </div>
  )
}
