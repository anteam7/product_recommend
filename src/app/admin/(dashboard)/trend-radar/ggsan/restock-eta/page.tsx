import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RestockEtaRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  current_sold_out_start: string
  days_sold_out: number
  sample_size: number
  sku_median_days: number | null
  sku_iqr_low: number | null
  sku_iqr_high: number | null
  cate_median_days: number | null
  shrunk_median_days: number
  predicted_restock_at: string
  predicted_low: string
  predicted_high: string
  days_until_restock: number
  is_watched: boolean
}

async function fetchEtaList(priorWeight: number) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_restock_eta.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_ggsan_restock_eta_list' as never, {
    prior_weight: priorWeight,
    result_limit: 500,
  } as never)
  if (error) return { rows: [] as RestockEtaRow[], error: error.message }
  return { rows: (data ?? []) as RestockEtaRow[], error: null as string | null }
}

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

function formatDday(days: number): { label: string; cls: string } {
  const d = Math.round(days)
  if (Number.isNaN(d)) return { label: '—', cls: 'text-gray-400' }
  if (d < 0) return { label: `D+${Math.abs(d)} (지연)`, cls: 'text-purple-700 font-bold' }
  if (d === 0) return { label: 'D-day', cls: 'text-red-600 font-bold' }
  if (d <= 3) return { label: `D-${d}`, cls: 'text-red-600 font-bold' }
  if (d <= 7) return { label: `D-${d}`, cls: 'text-amber-700 font-semibold' }
  return { label: `D-${d}`, cls: 'text-gray-700' }
}

const PRIOR_OPTIONS = [
  { v: 1, label: '1 (SKU 우선)' },
  { v: 3, label: '3 (기본)' },
  { v: 7, label: '7 (카테고리 우선)' },
] as const

const FILTER_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'imminent', label: '🔥 D-3 이내' },
  { v: 'overdue', label: '⏰ 지연' },
  { v: 'watched', label: '📌 핀된 것' },
  { v: 'high_confidence', label: 'sample ≥ 3' },
] as const

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ggsan/restock-eta' + (qs ? `?${qs}` : '')
}

export default async function RestockEtaPage({
  searchParams,
}: {
  searchParams: Promise<{ prior?: string; filter?: string }>
}) {
  const sp = await searchParams
  const priorRaw = parseFloat(sp.prior ?? '3')
  const prior = PRIOR_OPTIONS.some((p) => p.v === priorRaw) ? priorRaw : 3
  const filter = (FILTER_OPTIONS.some((f) => f.v === sp.filter) ? sp.filter : '') as
    | ''
    | 'imminent'
    | 'overdue'
    | 'watched'
    | 'high_confidence'

  const current: Record<string, string> = { prior: String(prior), filter }

  const { rows, error } = await fetchEtaList(prior)

  const filtered = rows.filter((r) => {
    if (filter === 'imminent') return r.days_until_restock <= 3 && r.days_until_restock > -1
    if (filter === 'overdue') return r.days_until_restock < 0
    if (filter === 'watched') return r.is_watched
    if (filter === 'high_confidence') return r.sample_size >= 3
    return true
  })

  // KPI
  const total = rows.length
  const imminent = rows.filter((r) => r.days_until_restock <= 3 && r.days_until_restock >= 0).length
  const overdue = rows.filter((r) => r.days_until_restock < 0).length
  const watched = rows.filter((r) => r.is_watched).length
  const highConfidence = rows.filter((r) => r.sample_size >= 3).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📅 품절→재입고 D-day 예측</h1>
          <p className="text-sm text-gray-500 mt-1">
            jimscanner_ggsan_price_history 의 sold_out spell 분포로 SKU별 재입고 ETA · 신뢰구간(IQR)을
            카테고리 평균 lag 베이지안 shrinkage 와 함께 예측. D-3 이내는 cron 으로 자동 핀 큐 푸시.
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href="/admin/trend-radar/ggsan" className="text-gray-700 hover:text-black underline">
            ← 카탈로그
          </Link>
        </div>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-gray-500">prior_weight</span>
          {PRIOR_OPTIONS.map((p) => (
            <Link
              key={p.v}
              href={buildHref(current, { prior: String(p.v) })}
              className={`px-2 py-1 text-xs rounded ${
                prior === p.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
          {FILTER_OPTIONS.map((f) => (
            <Link
              key={f.v}
              href={buildHref(current, { filter: f.v || null })}
              className={`px-3 py-1 text-xs rounded ${
                filter === f.v ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="현재 품절 SKU" value={total} />
        <Kpi label="🔥 D-3 이내" value={imminent} highlight={imminent > 0} />
        <Kpi label="⏰ 예측 지연" value={overdue} />
        <Kpi label="📌 핀(watch) 큐" value={watched} />
        <Kpi label="sample ≥ 3" value={highConfidence} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_ggsan_restock_eta_list</code> RPC 가 DB에 적용 안 됐을 가능성. supabase/ggsan_restock_eta.sql
            적용 필요.
          </p>
        </div>
      )}

      {/* 테이블 */}
      {!error && filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 sold_out SKU 없음</div>
          <div className="text-xs text-gray-400">
            가능성: 1) price_history 누적 부족 — sold_out spell 1건도 안 완성됨 · 2) 모든 SKU 가 active · 3) 필터가 너무 좁음.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">마지막 active</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">누적 품절</th>
                <th className="px-3 py-2 text-center whitespace-nowrap">예측 D-day</th>
                <th className="px-3 py-2 text-center whitespace-nowrap">신뢰구간 (IQR)</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">사이클(n)</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">SKU median</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">카테고리 median</th>
                <th className="px-3 py-2 text-right whitespace-nowrap">shrunk</th>
                <th className="px-3 py-2 text-center whitespace-nowrap">핀</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const dday = formatDday(r.days_until_restock)
                const rowCls =
                  r.days_until_restock < 0
                    ? 'bg-purple-50/40'
                    : r.days_until_restock <= 3
                      ? 'bg-red-50/40'
                      : ''
                return (
                  <tr key={r.goods_no} className={`border-t border-gray-100 hover:bg-gray-50 ${rowCls}`}>
                    <td className="px-3 py-2">
                      <a
                        href={r.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className="flex items-start gap-2 max-w-md"
                      >
                        <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                          {r.image_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm leading-tight line-clamp-2" title={r.title}>
                            {r.title}
                          </div>
                          <div className="text-[10px] text-gray-400 font-mono">
                            {r.cate_label ?? r.cate_cd} · {r.goods_no}
                          </div>
                        </div>
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-xs text-gray-600 font-mono">
                      {formatDateShort(r.current_sold_out_start)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-xs font-mono">
                      {r.days_sold_out.toFixed(1)}d
                    </td>
                    <td className={`px-3 py-2 text-center whitespace-nowrap font-mono ${dday.cls}`}>
                      {dday.label}
                      <div className="text-[10px] text-gray-500 font-normal">
                        ~ {formatDateShort(r.predicted_restock_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap text-[11px] text-gray-600 font-mono">
                      {formatDateShort(r.predicted_low)} ~ {formatDateShort(r.predicted_high)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono">
                      {r.sample_size === 0 ? <span className="text-gray-400">0</span> : r.sample_size}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono">
                      {r.sku_median_days != null ? `${r.sku_median_days.toFixed(1)}d` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono">
                      {r.cate_median_days != null ? `${r.cate_median_days.toFixed(1)}d` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-mono font-semibold">
                      {r.shrunk_median_days.toFixed(1)}d
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.is_watched ? (
                        <span className="inline-block bg-red-100 text-red-700 text-[10px] px-1.5 py-0.5 rounded font-semibold">
                          📌
                        </span>
                      ) : (
                        <span className="text-gray-300 text-[10px]">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 ETA 공식 (Bayesian shrinkage)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          shrunk_median = (n × sku_median + prior_weight × cate_median) / (n + prior_weight)
          <br />
          predicted_restock_at = current_sold_out_start + shrunk_median × 1d
          <br />
          신뢰구간 = (sold_out_start + p25, sold_out_start + p75) — SKU IQR 우선, fallback 카테고리 median
        </code>
        <div className="pt-2">
          <strong>자동 핀 큐:</strong> D-3 이내 SKU 는 <code>scripts/predict-restock-eta.mjs</code> cron 이{' '}
          <code>jimscanner_ggsan_restock_watch</code> 로 푸시. 재입고 즉시{' '}
          <code>scripts/coupang-register-one.mjs</code> 가 선점 등록.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
