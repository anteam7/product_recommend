'use client'
import { useMemo, useState } from 'react'
import type { LifecycleRow } from './page'

const LIFECYCLES = ['pre_peak', 'sustained', 'seasonal', 'fad', 'episodic'] as const
type Lifecycle = (typeof LIFECYCLES)[number]

const LIFECYCLE_COLORS: Record<Lifecycle, string> = {
  pre_peak: '#10b981',
  sustained: '#22c55e',
  seasonal: '#3b82f6',
  fad: '#ef4444',
  episodic: '#a78bfa',
}

const LIFECYCLE_LABELS_KO: Record<Lifecycle, string> = {
  pre_peak: 'Pre-peak (상승)',
  sustained: 'Sustained (안정)',
  seasonal: 'Seasonal (주기)',
  fad: 'Fad (급락)',
  episodic: 'Episodic (단발)',
}

const LIFECYCLE_HINTS: Record<Lifecycle, string> = {
  pre_peak: '진입 골든존 — 상승 가속',
  sustained: '저-decay 안정수요 — 핀 안전',
  seasonal: '연/월 주기 ACF≥0.5 — 시즌 진입',
  fad: '피크 후 half-life<14d — 재고/광고 금지',
  episodic: '단발 bump — 광고 대신 컨텐츠',
}

interface CategorySummary {
  category: string
  counts: Record<Lifecycle, number>
  total: number
}

function Sparkline({ data, color }: { data: { day: string; volume: number }[]; color: string }) {
  const W = 100
  const H = 28
  if (data.length < 2) {
    return <div className="text-[10px] text-gray-400">n={data.length}</div>
  }
  const vols = data.map((d) => d.volume)
  const minV = Math.min(...vols)
  const maxV = Math.max(...vols)
  const range = Math.max(maxV - minV, 0.001)
  const pts = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * W
      const y = H - ((d.volume - minV) / range) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={W} height={H} className="block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  )
}

function Donut({ counts, total, size = 72 }: { counts: Record<Lifecycle, number>; total: number; size?: number }) {
  if (total === 0) return null
  const R = size / 2 - 2
  const cx = size / 2
  const cy = size / 2
  let acc = 0
  const segments = LIFECYCLES.map((lc) => {
    const v = counts[lc]
    if (v === 0) return null
    const startA = (acc / total) * Math.PI * 2 - Math.PI / 2
    acc += v
    const endA = (acc / total) * Math.PI * 2 - Math.PI / 2
    const large = endA - startA > Math.PI ? 1 : 0
    const x1 = cx + R * Math.cos(startA)
    const y1 = cy + R * Math.sin(startA)
    const x2 = cx + R * Math.cos(endA)
    const y2 = cy + R * Math.sin(endA)
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`
    return <path key={lc} d={d} fill={LIFECYCLE_COLORS[lc]} fillOpacity={0.85} />
  })
  return (
    <svg width={size} height={size}>
      {segments}
      <circle cx={cx} cy={cy} r={R * 0.5} fill="white" />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#374151">
        {total}
      </text>
    </svg>
  )
}

export default function LifecycleClient({
  rows,
  categorySummary,
}: {
  rows: LifecycleRow[]
  categorySummary: CategorySummary[]
}) {
  const [filter, setFilter] = useState<Lifecycle | 'all'>('all')

  const filtered = useMemo(() => {
    const base = filter === 'all' ? rows : rows.filter((r) => r.lifecycle_label === filter)
    return base.sort((a, b) => (b.lifecycle_confidence ?? 0) - (a.lifecycle_confidence ?? 0))
  }, [rows, filter])

  const totalCounts = useMemo(() => {
    const c: Record<Lifecycle, number> = {
      pre_peak: 0,
      sustained: 0,
      seasonal: 0,
      fad: 0,
      episodic: 0,
    }
    for (const r of rows) if (r.lifecycle_label) c[r.lifecycle_label] += 1
    return c
  }, [rows])

  return (
    <div className="space-y-8">
      {/* 전체 lifecycle 비율 + 필터 */}
      <div className="rounded border border-gray-200 p-4">
        <div className="flex items-center gap-6">
          <Donut counts={totalCounts} total={rows.length} size={100} />
          <div className="flex-1">
            <div className="text-sm font-semibold mb-2">전체 키워드 ({rows.length})</div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`text-xs px-2 py-1 rounded border ${filter === 'all' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700'}`}
              >
                전체
              </button>
              {LIFECYCLES.map((lc) => (
                <button
                  key={lc}
                  onClick={() => setFilter(lc)}
                  className={`text-xs px-2 py-1 rounded border flex items-center gap-1.5 ${
                    filter === lc ? 'border-gray-900' : 'border-gray-300 text-gray-700'
                  }`}
                  style={filter === lc ? { background: LIFECYCLE_COLORS[lc], color: '#fff', borderColor: LIFECYCLE_COLORS[lc] } : {}}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ background: LIFECYCLE_COLORS[lc] }}
                  />
                  {LIFECYCLE_LABELS_KO[lc]} ({totalCounts[lc]})
                </button>
              ))}
            </div>
            <div className="mt-2 text-xs text-gray-500">
              {filter !== 'all' && LIFECYCLE_HINTS[filter]}
            </div>
          </div>
        </div>
      </div>

      {/* 카테고리×lifecycle 도넛 */}
      {categorySummary.length > 0 && (
        <div className="rounded border border-gray-200 p-4">
          <h3 className="text-sm font-semibold mb-3">카테고리별 lifecycle 분포</h3>
          <div className="flex flex-wrap gap-6">
            {categorySummary.slice(0, 12).map((c) => (
              <div key={c.category} className="text-center">
                <Donut counts={c.counts} total={c.total} />
                <div className="mt-1 text-xs text-gray-600 max-w-[80px] truncate">{c.category}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 키워드 목록 */}
      <div className="rounded border border-gray-200 divide-y divide-gray-100">
        <div className="px-4 py-2 bg-gray-50 grid grid-cols-12 text-xs font-semibold text-gray-600">
          <div className="col-span-3">keyword</div>
          <div className="col-span-2">lifecycle</div>
          <div className="col-span-2">sparkline (30d)</div>
          <div className="col-span-1 text-right">half-life</div>
          <div className="col-span-1 text-right">conf</div>
          <div className="col-span-1 text-right">peak</div>
          <div className="col-span-2 text-right">acf y/m/w</div>
        </div>
        {filtered.slice(0, 200).map((r) => {
          const lc = r.lifecycle_label
          const color = lc ? LIFECYCLE_COLORS[lc] : '#9ca3af'
          const postPeakFad = lc === 'fad'
          return (
            <div key={r.id} className="px-4 py-2 grid grid-cols-12 items-center text-sm">
              <div className="col-span-3">
                <div className="font-medium truncate" title={r.keyword}>
                  {r.keyword}
                </div>
                <div className="text-[10px] text-gray-500">
                  {r.source} · {r.classified_category ?? r.category_top ?? '-'}
                </div>
              </div>
              <div className="col-span-2">
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium"
                  style={{ background: color + '22', color }}
                >
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
                  {lc ? LIFECYCLE_LABELS_KO[lc] : '미분류'}
                </span>
                {postPeakFad && (
                  <span
                    className="ml-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700"
                    title="post-peak Fad — 핀 등록 시 confirm-gate"
                  >
                    ⚠ 핀-차단
                  </span>
                )}
              </div>
              <div className="col-span-2">
                <Sparkline data={r.series} color={color} />
              </div>
              <div className="col-span-1 text-right font-mono text-xs">
                {r.half_life_days != null ? r.half_life_days.toFixed(1) + 'd' : '-'}
              </div>
              <div className="col-span-1 text-right font-mono text-xs">
                {r.lifecycle_confidence != null ? r.lifecycle_confidence.toFixed(2) : '-'}
              </div>
              <div className="col-span-1 text-right font-mono text-xs">
                {r.peak_volume != null ? r.peak_volume.toFixed(0) : '-'}
              </div>
              <div className="col-span-2 text-right font-mono text-[10px] text-gray-600">
                {[r.acf_year, r.acf_month, r.acf_week].map((a) => (a != null ? a.toFixed(2) : '-')).join(' / ')}
              </div>
            </div>
          )
        })}
      </div>

      {filtered.length > 200 && (
        <div className="text-xs text-gray-400 text-center">
          {filtered.length}개 중 200개 표시
        </div>
      )}
    </div>
  )
}
