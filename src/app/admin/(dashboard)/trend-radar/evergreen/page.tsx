import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import EvergreenPinButton from './EvergreenPinButton'

export const dynamic = 'force-dynamic'

interface EvergreenRow {
  keyword: string
  category_top: string | null
  sources: string[]
  days_observed: number
  total_observations: number
  avg_demand: number
  stdev_demand: number
  cv: number
  zero_day_ratio: number
  age_factor: number
  score: number
  is_pinned: boolean
  has_ggsan_match: boolean
  ggsan_match_count: number
  sparkline: number[]
  last_seen_at: string
}

const DAYS_OPTIONS = [
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일 (기본)' },
] as const

const MIN_AVG_OPTIONS = [
  { v: 0.5, label: '0.5 (느슨)' },
  { v: 1.0, label: '1.0 (기본)' },
  { v: 2.0, label: '2.0 (엄격)' },
] as const

const MAX_CV_OPTIONS = [
  { v: 0.5, label: '0.5 (안정)' },
  { v: 1.0, label: '1.0 (기본)' },
  { v: 1.5, label: '1.5 (느슨)' },
] as const

async function fetchEvergreen(opts: {
  days: number
  minAvg: number
  maxCv: number
  category: string
}) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_evergreen_candidates' as never, {
    days_window: opts.days,
    min_avg_demand: opts.minAvg,
    max_cv: opts.maxCv,
    category_filter: opts.category || null,
    result_limit: 200,
  } as never)
  if (error) {
    return { rows: [] as EvergreenRow[], error: error.message }
  }
  return { rows: (data ?? []) as EvergreenRow[], error: null as string | null }
}

function buildHref(
  current: Record<string, string>,
  override: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/evergreen' + (qs ? `?${qs}` : '')
}

function Sparkline({ data }: { data: number[] }) {
  if (!data || data.length === 0) {
    return <div className="text-[10px] text-gray-300">no data</div>
  }
  const max = Math.max(...data, 1)
  const w = 120
  const h = 28
  const stepX = data.length > 1 ? w / (data.length - 1) : 0
  const points = data
    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={points}
        className="text-emerald-600"
      />
    </svg>
  )
}

function AgeBar({ factor }: { factor: number }) {
  const pct = Math.max(0, Math.min(1, factor)) * 100
  return (
    <div className="w-16 h-2 bg-gray-100 rounded overflow-hidden">
      <div
        className="h-full bg-emerald-500"
        style={{ width: `${pct.toFixed(0)}%` }}
      />
    </div>
  )
}

export default async function EvergreenPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string
    avg?: string
    cv?: string
    cat?: string
  }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '90', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 90
  const minAvg = parseFloat(sp.avg ?? '1.0')
  const validMinAvg = MIN_AVG_OPTIONS.some((o) => Math.abs(o.v - minAvg) < 0.001)
    ? minAvg
    : 1.0
  const maxCv = parseFloat(sp.cv ?? '1.0')
  const validMaxCv = MAX_CV_OPTIONS.some((o) => Math.abs(o.v - maxCv) < 0.001)
    ? maxCv
    : 1.0
  const cat = sp.cat ?? ''

  const current: Record<string, string> = {
    days: String(validDays),
    avg: String(validMinAvg),
    cv: String(validMaxCv),
    cat,
  }

  const { rows, error } = await fetchEvergreen({
    days: validDays,
    minAvg: validMinAvg,
    maxCv: validMaxCv,
    category: cat,
  })

  const total = rows.length
  const ggsanMatchCount = rows.filter((r) => r.has_ggsan_match).length
  const pinnedCount = rows.filter((r) => r.is_pinned).length
  const avgCv =
    rows.length > 0
      ? rows.reduce((s, r) => s + Number(r.cv || 0), 0) / rows.length
      : 0
  const topScore = rows.length > 0 ? Number(rows[0]?.score ?? 0) : 0

  const categories = Array.from(
    new Set(rows.map((r) => r.category_top).filter(Boolean) as string[]),
  ).sort()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🌲 Evergreen 안정수요 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            spike·가속도 반대 축 — 저변동(CV) + 장기 데이터 존재 키워드.
            long-term cash cow 카테고리(마그네슘·치실·고무장갑 등) 발굴용.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
        <strong>Anti-Spike 공식</strong> · score = ln(avg+1) × 1/(CV+0.1) ×
        age_factor × (1 − zero_day×0.5) — 평균이 높고, 변동계수가 낮고, 데이터가
        오래 누적될수록 점수 ↑
      </div>

      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validDays === d.v
                    ? 'bg-emerald-100 text-emerald-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">최소 평균 μ</span>
            {MIN_AVG_OPTIONS.map((o) => (
              <Link
                key={o.v}
                href={buildHref(current, { avg: String(o.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  Math.abs(validMinAvg - o.v) < 0.001
                    ? 'bg-emerald-100 text-emerald-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {o.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">최대 CV</span>
            {MAX_CV_OPTIONS.map((o) => (
              <Link
                key={o.v}
                href={buildHref(current, { cv: String(o.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  Math.abs(validMaxCv - o.v) < 0.001
                    ? 'bg-emerald-100 text-emerald-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {o.label}
              </Link>
            ))}
          </div>
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
            <Link
              href={buildHref(current, { cat: null })}
              className={`px-2 py-1 text-xs rounded ${
                cat === ''
                  ? 'bg-black text-white font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              전체 카테고리
            </Link>
            {categories.map((c) => (
              <Link
                key={c}
                href={buildHref(current, { cat: c })}
                className={`px-2 py-1 text-xs rounded ${
                  cat === c
                    ? 'bg-black text-white font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {c}
              </Link>
            ))}
          </div>
        )}
      </div>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="후보 키워드" value={total} />
        <Kpi label="ggsan 매칭" value={ggsanMatchCount} highlight={ggsanMatchCount > 0} />
        <Kpi label="이미 핀" value={pinnedCount} />
        <Kpi label="평균 CV" value={avgCv.toFixed(2)} />
        <Kpi label="최고 score" value={topScore.toFixed(2)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_evergreen_candidates</code> 가 DB에 적용 안 됐을
            가능성. supabase/evergreen_candidates_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 후보 없음</div>
          <div className="text-xs text-gray-400">
            min_avg 를 0.5 로 낮추거나, max_cv 를 1.5 로 늘려보기. 누적이 부족하면
            기간(30일)으로 좁히기.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-gray-500 border-b border-gray-200">
              <tr>
                <th className="text-left py-2 pr-3 font-medium">#</th>
                <th className="text-left py-2 pr-3 font-medium">키워드</th>
                <th className="text-left py-2 pr-3 font-medium">카테고리</th>
                <th className="text-right py-2 pr-3 font-medium">μ avg</th>
                <th className="text-right py-2 pr-3 font-medium">CV</th>
                <th className="text-right py-2 pr-3 font-medium">days</th>
                <th className="text-left py-2 pr-3 font-medium">age</th>
                <th className="text-left py-2 pr-3 font-medium">sparkline</th>
                <th className="text-left py-2 pr-3 font-medium">tag</th>
                <th className="text-right py-2 pr-3 font-medium">score</th>
                <th className="text-right py-2 pr-3 font-medium">핀</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.keyword}
                  className={`border-b border-gray-100 hover:bg-gray-50 ${
                    r.has_ggsan_match ? 'bg-amber-50/30' : ''
                  }`}
                >
                  <td className="py-2 pr-3 text-gray-400 font-mono text-xs">
                    {i + 1}
                  </td>
                  <td className="py-2 pr-3 font-medium">{r.keyword}</td>
                  <td className="py-2 pr-3 text-gray-500 text-xs">
                    {r.category_top ?? '—'}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {Number(r.avg_demand).toFixed(2)}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right font-mono ${
                      Number(r.cv) < 0.3
                        ? 'text-emerald-700 font-semibold'
                        : Number(r.cv) < 0.6
                          ? 'text-gray-700'
                          : 'text-amber-700'
                    }`}
                  >
                    {Number(r.cv).toFixed(2)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-gray-500">
                    {r.days_observed}
                  </td>
                  <td className="py-2 pr-3">
                    <AgeBar factor={r.age_factor} />
                  </td>
                  <td className="py-2 pr-3">
                    <Sparkline data={r.sparkline ?? []} />
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex gap-1 flex-wrap">
                      {r.has_ggsan_match && (
                        <span className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-[10px] font-mono">
                          📦 ggsan {r.ggsan_match_count}
                        </span>
                      )}
                      {(r.sources ?? []).slice(0, 2).map((s) => (
                        <span
                          key={s}
                          className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]"
                        >
                          {s.replace('naver_', '')}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono font-bold text-emerald-700">
                    {Number(r.score).toFixed(2)}
                  </td>
                  <td className="py-2 pr-1 text-right">
                    <EvergreenPinButton
                      keyword={r.keyword}
                      source={(r.sources ?? [])[0] ?? 'evergreen'}
                      initialPinned={r.is_pinned}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Evergreen Score 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          score = ln(avg_demand + 1) × 1/(CV + 0.1) × age_factor × (1 −
          zero_day_ratio × 0.5)
          <br />
          CV = stdev_demand / avg_demand · 낮을수록 안정
          <br />
          age_factor = (last_day − first_day) / days_window · 1.0 = 윈도우 전체
          누적
          <br />
          zero_day_ratio = 1 − (days_observed / days_window) · 결측일 패널티
        </code>
        <div className="pt-2">
          <strong>해석:</strong> spike·가속도 보드의 반대축. 매일 검색되지만
          폭발은 없고 6개월·1년 단위로 매출이 깔리는 카테고리. ggsan 매칭이 있는
          행을 우선 핀 후보로 검토.
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
    <div
      className={`rounded border p-3 ${
        highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'
      }`}
    >
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`text-2xl font-bold mt-1 ${
          highlight ? 'text-emerald-700' : ''
        }`}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
