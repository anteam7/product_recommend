'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

const AXES = ['trend', 'commerce', 'supplier', 'competition'] as const
type Axis = (typeof AXES)[number]

export interface SkylineRow {
  id: string
  name: string
  category: string
  final: number
  v: Record<Axis, number>
  depth: number
  uniqueAxes: Axis[]
  strongestAxis: Axis
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

const AXIS_LABEL: Record<Axis, string> = {
  trend: '트렌드',
  commerce: '커머스',
  supplier: '소싱',
  competition: '경쟁우위',
}

function AxisBar({ axis, value, highlight }: { axis: Axis; value: number; highlight: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-16 text-xs ${highlight ? 'font-semibold text-black' : 'text-gray-500'}`}>
        {AXIS_LABEL[axis]}
      </span>
      <div className="relative h-2 flex-1 rounded bg-gray-100">
        <div
          className={`absolute left-0 top-0 h-2 rounded ${highlight ? 'bg-emerald-500' : 'bg-gray-400'}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      <span className="w-8 text-right font-mono text-xs text-gray-600">{value}</span>
    </div>
  )
}

export default function SkylineBoard({ rows, total }: { rows: SkylineRow[]; total: number }) {
  const categories = useMemo(() => {
    const set = new Set<string>(rows.map((r) => r.category))
    return ['all', ...Array.from(set).filter((c) => c !== 'all').sort()]
  }, [rows])

  const [cat, setCat] = useState<string>('all')

  const visible = cat === 'all' ? rows : rows.filter((r) => r.category === cat)

  return (
    <div className="space-y-4">
      {/* 카테고리 토글 */}
      <div className="flex flex-wrap gap-2">
        {categories.map((c) => {
          const n = c === 'all' ? rows.length : rows.filter((r) => r.category === c).length
          return (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                cat === c
                  ? 'border-black bg-black text-white'
                  : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
              }`}
            >
              {c === 'all' ? '전체' : c}
              <span className="ml-1 opacity-60">{n}</span>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-gray-400">
        지배깊이(depth) = 이 후보가 4축 전부에서 눌러버린 경쟁후보 수 · 높을수록 강한 비지배 후보 ·{' '}
        검토 풀 {total} → {visible.length}
      </p>

      {/* 카드 그리드 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((r) => {
          const color = CATEGORY_COLORS[r.category] ?? '#6b7280'
          return (
            <Link
              key={r.id}
              href={`/admin/trend-radar/products/${r.id}`}
              className="group block rounded-lg border border-gray-200 p-3 transition hover:border-gray-400 hover:shadow-sm"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold group-hover:underline">{r.name}</div>
                  <span
                    className="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: color + '22', color }}
                  >
                    {r.category}
                  </span>
                </div>
                <div
                  className="flex shrink-0 flex-col items-center rounded bg-gray-900 px-2 py-1 text-white"
                  title="지배깊이: 이 후보가 4축 전부에서 능가한 경쟁후보 수"
                >
                  <span className="text-base font-bold leading-none">{r.depth}</span>
                  <span className="text-[9px] uppercase tracking-wide opacity-70">dom</span>
                </div>
              </div>

              {/* 차별 강점 */}
              <div className="mb-2 flex flex-wrap gap-1">
                {r.uniqueAxes.length > 0 ? (
                  r.uniqueAxes.map((ax) => (
                    <span
                      key={ax}
                      className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
                      title="다른 모든 비피지배 후보보다 이 축에서 유일하게 우위"
                    >
                      ★ {AXIS_LABEL[ax]} 유일우위
                    </span>
                  ))
                ) : (
                  <span
                    className="rounded bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                    title="유일 우위 축은 없으나, 스카이라인 평균 대비 가장 앞선 축"
                  >
                    상대강점 {AXIS_LABEL[r.strongestAxis]}
                  </span>
                )}
              </div>

              {/* 4축 바 */}
              <div className="space-y-1">
                {AXES.map((ax) => (
                  <AxisBar
                    key={ax}
                    axis={ax}
                    value={r.v[ax]}
                    highlight={r.uniqueAxes.includes(ax) || (r.uniqueAxes.length === 0 && ax === r.strongestAxis)}
                  />
                ))}
              </div>

              <div className="mt-2 text-right text-[10px] text-gray-400">
                final {r.final} (참고용 · 스카이라인은 가중치 불변)
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
