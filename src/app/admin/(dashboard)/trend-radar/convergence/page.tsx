import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const SOURCES = [
  'naver_tvtime',
  'naver_search_trend',
  'naver_shopping_insight',
  'naver_blog',
  'naver_news',
  'google_suggest',
  'ggsan',
] as const
type Source = (typeof SOURCES)[number]

const SOURCE_LABEL: Record<Source, string> = {
  naver_tvtime: 'TV',
  naver_search_trend: '검색트렌드',
  naver_shopping_insight: '쇼핑인사이트',
  naver_blog: '블로그',
  naver_news: '뉴스',
  google_suggest: 'Google자동완성',
  ggsan: 'ggsan재고',
}

interface PerSourceEntry {
  count: number
  z: number
}

interface ConvergenceRow {
  keyword: string
  source_count: number
  positive_source_count: number
  total_count_7d: number
  positive_z_sum: number
  max_z: number
  convergence_score: number
  per_source: Partial<Record<Source, PerSourceEntry>>
}

async function fetchConvergence(): Promise<{ rows: ConvergenceRow[]; error: string | null }> {
  const sb = createAdminClient()
  // jimscanner_keyword_convergence 매뷰 — generated 타입 미반영
  const { data, error } = await sb
    .from('jimscanner_keyword_convergence' as never)
    .select(
      'keyword, source_count, positive_source_count, total_count_7d, positive_z_sum, max_z, convergence_score, per_source',
    )
    .order('convergence_score', { ascending: false })
    .limit(300)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as unknown as ConvergenceRow[], error: null }
}

type Mode = 'multi' | 'single' | 'all'

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/convergence' + (qs ? `?${qs}` : '')
}

export default async function ConvergencePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; sel?: string }>
}) {
  const sp = await searchParams
  const mode: Mode = sp.mode === 'single' ? 'single' : sp.mode === 'all' ? 'all' : 'multi'
  const sel = sp.sel ?? ''

  const { rows: allRows, error } = await fetchConvergence()

  const filtered = allRows.filter((r) => {
    if (mode === 'multi') return r.positive_source_count >= 2
    if (mode === 'single') return r.positive_source_count <= 1
    return true
  })

  const rows = filtered.slice(0, 100)

  const selectedRow =
    (sel && rows.find((r) => r.keyword === sel)) ||
    rows[0] ||
    null

  // KPI
  const totalAnalyzed = allRows.length
  const multiCount = allRows.filter((r) => r.positive_source_count >= 2).length
  const singleCount = allRows.filter((r) => r.positive_source_count === 1).length
  const top1 = allRows[0]

  const current: Record<string, string> = {
    mode,
    sel,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 Cross-Source Convergence</h1>
          <p className="text-sm text-gray-500 mt-1">
            7개 소스(TV·검색·쇼핑·블로그·뉴스·자동완성·ggsan)에서 7일 z-score 를 합산한 다소스 수렴 점수.
            한 소스만 튄 ephemeral 노이즈를 구조적으로 깎는다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <strong>공식</strong> · convergence_score = √(positive_source_count) × Σ max(z, 0).
        같은 키워드에 z=1.5 인 소스 3개가 있으면, z=5 인 단일 소스보다 높게 평가됨.
        매뷰는 nightly 로 갱신 — supabase/keyword_convergence.sql 참조.
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="분석된 키워드" value={totalAnalyzed} />
        <Kpi label="🟢 다소스 수렴 (≥2)" value={multiCount} highlight />
        <Kpi label="🟡 단일소스 스파이크" value={singleCount} />
        <Kpi
          label="Top1 convergence"
          value={top1 ? `${top1.convergence_score.toFixed(2)} (${top1.keyword.slice(0, 12)})` : '—'}
        />
      </section>

      {/* 토글 */}
      <div className="flex flex-wrap items-center gap-3 rounded border border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">필터:</span>
        {(['multi', 'single', 'all'] as const).map((m) => (
          <Link
            key={m}
            href={buildHref(current, { mode: m, sel: null })}
            className={`px-3 py-1 text-xs rounded ${
              mode === m
                ? 'bg-black text-white font-semibold'
                : 'text-gray-500 hover:text-black bg-gray-100'
            }`}
          >
            {m === 'multi' ? '🟢 다소스만 (≥2)' : m === 'single' ? '🟡 단일소스만' : '전체'}
          </Link>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          매뷰 조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            supabase/keyword_convergence.sql 미적용 가능성. 적용 후 한번
            jimscanner_refresh_keyword_convergence() 호출 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          조건에 맞는 키워드 없음. 다른 모드를 시도하거나 cron 누적을 기다려야 함.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* 좌: 레이더 */}
          <div className="lg:col-span-2 space-y-3">
            <div className="rounded border border-gray-200 p-4">
              <div className="text-xs text-gray-500 mb-1">선택된 키워드</div>
              <div className="text-lg font-bold mb-3 break-all">
                {selectedRow ? selectedRow.keyword : '—'}
              </div>
              {selectedRow ? (
                <>
                  <RadarChart row={selectedRow} />
                  <div className="grid grid-cols-2 gap-2 text-xs mt-4">
                    <Stat label="convergence" value={selectedRow.convergence_score.toFixed(2)} bold />
                    <Stat label="active sources" value={`${selectedRow.positive_source_count} / 7`} />
                    <Stat label="Σ max(z,0)" value={selectedRow.positive_z_sum.toFixed(2)} />
                    <Stat label="max z" value={selectedRow.max_z.toFixed(2)} />
                  </div>
                  <div className="mt-3 space-y-1">
                    {SOURCES.map((s) => {
                      const v = selectedRow.per_source[s]
                      return (
                        <div key={s} className="flex items-center justify-between text-[11px]">
                          <span className={v ? 'text-gray-700' : 'text-gray-300'}>
                            {SOURCE_LABEL[s]}
                          </span>
                          <span className="font-mono text-gray-500">
                            {v ? `${v.count} · z=${v.z.toFixed(2)}` : '—'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="text-xs text-gray-400">선택된 키워드 없음</div>
              )}
            </div>
          </div>

          {/* 우: 랭킹 */}
          <div className="lg:col-span-3">
            <div className="rounded border border-gray-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left px-2 py-2 w-8">#</th>
                    <th className="text-left px-2 py-2">키워드</th>
                    <th className="text-right px-2 py-2 w-16">소스</th>
                    <th className="text-right px-2 py-2 w-16">Σz</th>
                    <th className="text-right px-2 py-2 w-20">conv</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const isSel = selectedRow?.keyword === r.keyword
                    return (
                      <tr
                        key={r.keyword}
                        className={`border-t border-gray-100 hover:bg-amber-50 ${
                          isSel ? 'bg-amber-100' : ''
                        }`}
                      >
                        <td className="px-2 py-1.5 text-gray-400 font-mono">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <Link
                            href={buildHref(current, { sel: r.keyword })}
                            className="font-medium text-gray-800 hover:text-black hover:underline break-all"
                          >
                            {r.keyword}
                          </Link>
                          <div className="flex gap-0.5 mt-0.5">
                            {SOURCES.map((s) => {
                              const e = r.per_source[s]
                              const active = e && e.z > 0
                              return (
                                <span
                                  key={s}
                                  title={`${SOURCE_LABEL[s]}: ${
                                    e ? `count=${e.count}, z=${e.z}` : '없음'
                                  }`}
                                  className={`inline-block w-2 h-2 rounded-sm ${
                                    active
                                      ? 'bg-emerald-500'
                                      : e
                                      ? 'bg-gray-300'
                                      : 'bg-gray-100'
                                  }`}
                                />
                              )
                            })}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-600">
                          {r.positive_source_count}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-600">
                          {r.positive_z_sum.toFixed(1)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold text-amber-700">
                          {r.convergence_score.toFixed(2)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 점수 해석</div>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>z-score 는 같은 소스 내 모든 키워드 분포에서 계산 — 소스 간 절대값 비교 불가</li>
          <li>positive_source_count ≥ 2 → 다소스 수렴 (false positive 가능성 낮음)</li>
          <li>positive_source_count == 1 → 단일 소스 스파이크 (검증 필요)</li>
          <li>convergence_score = √(N) × Σmax(z,0) — 소스 다양성 보너스</li>
        </ul>
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
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function Stat({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="rounded bg-gray-50 px-2 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`font-mono ${bold ? 'font-bold text-amber-700' : 'text-gray-700'}`}>
        {value}
      </div>
    </div>
  )
}

function RadarChart({ row }: { row: ConvergenceRow }) {
  const size = 240
  const cx = size / 2
  const cy = size / 2
  const radius = 90
  const n = SOURCES.length
  // z-score 시각화 범위: clip 0..3
  const maxZ = 3
  const clip = (z: number) => Math.max(0, Math.min(z, maxZ)) / maxZ

  const axisPts = SOURCES.map((_, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      angle,
    }
  })

  const dataPts = SOURCES.map((s, i) => {
    const e = row.per_source[s]
    const z = e ? Math.max(0, e.z) : 0
    const r = clip(z) * radius
    const angle = axisPts[i].angle
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      z,
    }
  })

  const polygon = dataPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-auto">
      {/* grid rings */}
      {[0.33, 0.66, 1].map((r, idx) => (
        <circle
          key={idx}
          cx={cx}
          cy={cy}
          r={radius * r}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={1}
          strokeDasharray={idx < 2 ? '2 2' : undefined}
        />
      ))}
      {/* axes */}
      {axisPts.map((p, i) => (
        <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#e5e7eb" strokeWidth={1} />
      ))}
      {/* polygon */}
      <polygon
        points={polygon}
        fill="rgba(245, 158, 11, 0.25)"
        stroke="#d97706"
        strokeWidth={2}
      />
      {/* labels */}
      {axisPts.map((p, i) => {
        const lx = cx + Math.cos(p.angle) * (radius + 18)
        const ly = cy + Math.sin(p.angle) * (radius + 14)
        const anchor =
          Math.abs(Math.cos(p.angle)) < 0.3
            ? 'middle'
            : Math.cos(p.angle) > 0
            ? 'start'
            : 'end'
        return (
          <text
            key={i}
            x={lx}
            y={ly}
            textAnchor={anchor}
            dominantBaseline="middle"
            fontSize={10}
            fill="#374151"
          >
            {SOURCE_LABEL[SOURCES[i]]}
          </text>
        )
      })}
      {/* data points */}
      {dataPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.z > 0 ? 3 : 2} fill={p.z > 0 ? '#d97706' : '#d1d5db'} />
      ))}
    </svg>
  )
}
