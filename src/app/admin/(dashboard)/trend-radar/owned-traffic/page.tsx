import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OwnedTrafficScatter from './OwnedTrafficScatter'

export const dynamic = 'force-dynamic'

interface OverlapRow {
  query: string
  clicks_window: number
  impressions_window: number
  position_avg: number | null
  position_delta_7d: number | null
  product_id: string | null
  canonical_name: string | null
  category_top: string | null
  matched_alias: string | null
  alias_confidence: number | null
  trend_final_score: number | null
  trend_score_delta_7d: number | null
  priority_rank: number
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 28, label: '28일 (기본)' },
  { v: 56, label: '56일' },
] as const

const MIN_IMPR_OPTIONS = [
  { v: 5, label: '≥5' },
  { v: 20, label: '≥20 (기본)' },
  { v: 50, label: '≥50' },
  { v: 100, label: '≥100' },
] as const

async function fetchOverlap(opts: { days: number; minImpr: number }) {
  const sb = createAdminClient()
  // RPC: supabase/gsc_trend_overlap.sql — generated types 미반영 → as never
  const { data, error } = await sb.rpc('jimscanner_gsc_trend_overlap' as never, {
    days_window: opts.days,
    min_impr: opts.minImpr,
  } as never)
  if (error) return { rows: [] as OverlapRow[], error: error.message }
  return { rows: (data ?? []) as unknown as OverlapRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/owned-traffic' + (qs ? `?${qs}` : '')
}

export default async function OwnedTrafficPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; impr?: string; mode?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '28', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 28
  const impr = parseInt(sp.impr ?? '20', 10)
  const validImpr = MIN_IMPR_OPTIONS.some((m) => m.v === impr) ? impr : 20
  const mode = sp.mode === 'all' ? 'all' : 'matched' // matched = product 매칭된 것만

  const current: Record<string, string> = {
    days: String(validDays),
    impr: String(validImpr),
    mode,
  }

  const { rows: allRows, error } = await fetchOverlap({ days: validDays, minImpr: validImpr })
  const rows = mode === 'matched' ? allRows.filter((r) => r.product_id) : allRows

  // 1순위 큐: position <= 10 + trend 상승 (score_delta_7d > 0 OR final_score >= 50)
  const priorityQueue = rows
    .filter((r) => r.product_id && r.position_avg != null && r.position_avg <= 10)
    .filter(
      (r) =>
        (r.trend_score_delta_7d != null && r.trend_score_delta_7d > 0) ||
        (r.trend_final_score != null && r.trend_final_score >= 50),
    )
    .sort((a, b) => Number(b.priority_rank) - Number(a.priority_rank))
    .slice(0, 20)

  // KPI
  const totalQueries = allRows.length
  const matchedCount = allRows.filter((r) => r.product_id).length
  const top10Count = allRows.filter((r) => r.position_avg != null && r.position_avg <= 10).length
  const risingMatched = allRows.filter(
    (r) =>
      r.product_id &&
      ((r.trend_score_delta_7d != null && r.trend_score_delta_7d > 0) ||
        (r.position_delta_7d != null && r.position_delta_7d < 0)),
  ).length

  // 산점도용 데이터 (매칭된 것만)
  const scatterRows = allRows
    .filter((r) => r.product_id && r.position_avg != null && r.trend_final_score != null)
    .map((r) => ({
      query: r.query,
      productId: r.product_id!,
      canonicalName: r.canonical_name ?? '?',
      category: r.category_top ?? 'all',
      impressions: Number(r.impressions_window),
      position: Number(r.position_avg),
      trendScore: Number(r.trend_final_score),
      trendDelta: r.trend_score_delta_7d != null ? Number(r.trend_score_delta_7d) : 0,
      priority: Number(r.priority_rank),
    }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 Owned-Traffic × 트렌드 매칭</h1>
          <p className="text-sm text-gray-500 mt-1">
            이미 자연 유입이 발생 중인 검색어 × 트렌드 상승 시그널 → 진입 ROI 최단 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
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
            <span className="text-xs text-gray-500">최소 노출</span>
            {MIN_IMPR_OPTIONS.map((m) => (
              <Link
                key={m.v}
                href={buildHref(current, { impr: String(m.v) })}
                className={`px-2 py-1 text-xs rounded ${validImpr === m.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {m.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">표시</span>
            <Link
              href={buildHref(current, { mode: 'matched' })}
              className={`px-2 py-1 text-xs rounded ${mode === 'matched' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              매칭된 것만
            </Link>
            <Link
              href={buildHref(current, { mode: 'all' })}
              className={`px-2 py-1 text-xs rounded ${mode === 'all' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체
            </Link>
          </div>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="GSC 검색어 (윈도우)" value={totalQueries} />
        <Kpi label="트렌드 매칭" value={matchedCount} highlight={matchedCount > 0} />
        <Kpi label="position ≤ 10" value={top10Count} />
        <Kpi label="매칭 + 상승" value={risingMatched} highlight={risingMatched > 0} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_gsc_trend_overlap</code> 가 DB 에 적용 안 됐을 가능성. supabase/gsc_trend_overlap.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 1순위 큐 */}
      {priorityQueue.length > 0 && (
        <section className="rounded border border-emerald-200 bg-emerald-50/40 p-4">
          <h2 className="text-sm font-semibold text-emerald-900 mb-3">
            🥇 1순위 큐 — position ≤ 10 + 트렌드 상승 ({priorityQueue.length})
          </h2>
          <div className="space-y-1">
            {priorityQueue.map((r, i) => (
              <Link
                key={r.query}
                href={r.product_id ? `/admin/trend-radar/products/${r.product_id}` : '#'}
                className="grid grid-cols-12 gap-2 items-center px-3 py-2 rounded hover:bg-white text-sm"
              >
                <div className="col-span-1 font-mono text-gray-400 text-xs">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium">{r.query}</div>
                  <div className="text-[10px] text-gray-500">
                    {r.canonical_name} {r.matched_alias ? `· alias: ${r.matched_alias}` : ''}
                  </div>
                </div>
                <div className="col-span-2 text-xs">
                  <span className="text-gray-500">노출 </span>
                  <span className="font-mono">{r.impressions_window.toLocaleString()}</span>
                  {' · '}
                  <span className="text-gray-500">클릭 </span>
                  <span className="font-mono">{r.clicks_window.toLocaleString()}</span>
                </div>
                <div className="col-span-2 text-xs">
                  <span className="text-gray-500">pos </span>
                  <span className="font-mono font-semibold">{r.position_avg?.toFixed(1) ?? '—'}</span>
                  {r.position_delta_7d != null && (
                    <span className={`ml-1 ${r.position_delta_7d < 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {r.position_delta_7d > 0 ? '+' : ''}
                      {r.position_delta_7d.toFixed(1)}
                    </span>
                  )}
                </div>
                <div className="col-span-2 text-xs">
                  <span className="text-gray-500">trend </span>
                  <span className="font-mono font-semibold">{r.trend_final_score?.toFixed(0) ?? '—'}</span>
                  {r.trend_score_delta_7d != null && (
                    <span className={`ml-1 ${r.trend_score_delta_7d > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {r.trend_score_delta_7d > 0 ? '+' : ''}
                      {r.trend_score_delta_7d.toFixed(1)}
                    </span>
                  )}
                </div>
                <div className="col-span-1 text-right text-base font-bold text-amber-700 font-mono">
                  {Number(r.priority_rank).toFixed(0)}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 산점도 */}
      {scatterRows.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            4분면 산점도 — X: 노출량(log) · Y: 트렌드 모멘텀 · 크기: priority
          </h2>
          <OwnedTrafficScatter rows={scatterRows} />
        </section>
      ) : (
        !error && (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            매칭된 시그널 없음. 1) GSC cron 누적 확인 · 2) trends_aliases 누적 확인 · 3) min_impr 낮추기
          </div>
        )
      )}

      {/* 전체 테이블 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          전체 ({rows.length}) — priority_rank 정렬
        </h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-2 py-2 text-left">query</th>
                <th className="px-2 py-2 text-right">impr</th>
                <th className="px-2 py-2 text-right">click</th>
                <th className="px-2 py-2 text-right">pos</th>
                <th className="px-2 py-2 text-right">Δpos 7d</th>
                <th className="px-2 py-2 text-left">매칭 상품</th>
                <th className="px-2 py-2 text-right">trend</th>
                <th className="px-2 py-2 text-right">Δtrend 7d</th>
                <th className="px-2 py-2 text-right">priority</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.slice(0, 200).map((r) => (
                <tr key={r.query} className="hover:bg-gray-50">
                  <td className="px-2 py-1 truncate max-w-xs" title={r.query}>{r.query}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.impressions_window.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.clicks_window.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {r.position_avg?.toFixed(1) ?? '—'}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${
                    r.position_delta_7d == null ? '' :
                    r.position_delta_7d < 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}>
                    {r.position_delta_7d?.toFixed(1) ?? '—'}
                  </td>
                  <td className="px-2 py-1">
                    {r.product_id ? (
                      <Link
                        href={`/admin/trend-radar/products/${r.product_id}`}
                        className="text-blue-700 hover:underline"
                      >
                        {r.canonical_name}
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {r.trend_final_score?.toFixed(0) ?? '—'}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${
                    r.trend_score_delta_7d == null ? '' :
                    r.trend_score_delta_7d > 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}>
                    {r.trend_score_delta_7d?.toFixed(1) ?? '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono font-bold">
                    {Number(r.priority_rank).toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 200 && (
          <div className="text-[10px] text-gray-400 mt-1">상위 200개만 표시 · 전체 {rows.length}건</div>
        )}
      </section>

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 priority_rank 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          position_bonus (pos≤10 → 60, ≤20 → 30, ≤50 → 10)
          + trend_final × 0.4
          + max(0, Δtrend_7d, cap 20)
          + |Δpos_7d| × 2 (개선 시, cap 10)
          + log(impressions) × 2 (cap 10)
        </code>
        <div className="pt-2">
          매칭은 GSC query 와 trends_aliases.alias 의 양방향 ILIKE — 추후 trigram/embedding 으로 정밀화 가능.
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
