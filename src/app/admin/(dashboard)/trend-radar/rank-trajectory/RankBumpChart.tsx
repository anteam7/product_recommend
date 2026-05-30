'use client'
import { useMemo, useState } from 'react'
import type { ProductTrajectory } from './page'

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function RankBumpChart({
  days,
  trajectories,
  topN,
  entrantIds,
}: {
  days: string[]
  trajectories: ProductTrajectory[]
  topN: number
  entrantIds: string[]
}) {
  const [hover, setHover] = useState<string | null>(null)
  const entrantSet = useMemo(() => new Set(entrantIds), [entrantIds])

  // 차트엔 '오늘 기준 Top-N' 궤적만 그린다 (가독성)
  const today = days[days.length - 1]
  const shown = useMemo(
    () =>
      trajectories
        .filter((t) => t.latestRank != null && t.latestRank <= topN)
        .sort((a, b) => (a.latestRank ?? 999) - (b.latestRank ?? 999)),
    [trajectories, topN]
  )

  const W = 860
  const rowH = 22
  const H = Math.max(240, topN * rowH + 80)
  const PAD_L = 40
  const PAD_R = 220
  const PAD_T = 30
  const PAD_B = 30

  const dayIndex = (d: string) => days.indexOf(d)
  const xScale = (d: string) =>
    days.length <= 1 ? PAD_L : PAD_L + (dayIndex(d) / (days.length - 1)) * (W - PAD_L - PAD_R)
  const yScale = (rank: number) => PAD_T + ((rank - 1) / Math.max(1, topN - 1)) * (H - PAD_T - PAD_B)

  function pathFor(t: ProductTrajectory): string {
    const pts = t.points.filter((p) => p.rank <= topN || p.day === today)
    if (pts.length === 0) return ''
    return pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.day).toFixed(1)} ${yScale(Math.min(p.rank, topN + 1)).toFixed(1)}`)
      .join(' ')
  }

  return (
    <div className="rounded border border-gray-200 p-4 overflow-x-auto">
      <div className="text-sm font-semibold text-gray-700 mb-1">
        Bump chart — 일자별 순위 궤적 (위 = 1위)
      </div>
      <div className="text-xs text-gray-500 mb-3">
        오늘 기준 Top-{topN} {shown.length}개 · 점선 = 신규 진입. 라인 hover 로 강조.
      </div>
      <svg width={W} height={H} style={{ minWidth: W }}>
        {/* rank grid */}
        {[1, 5, 10, 15, 20, 25, 30].filter((r) => r <= topN).map((r) => (
          <g key={'r' + r}>
            <line x1={PAD_L} y1={yScale(r)} x2={W - PAD_R} y2={yScale(r)} stroke="#f3f4f6" />
            <text x={PAD_L - 6} y={yScale(r) + 3} fontSize="9" fill="#9ca3af" textAnchor="end">{r}</text>
          </g>
        ))}

        {/* day ticks */}
        {days.map((d, i) =>
          i % Math.ceil(days.length / 8 || 1) === 0 || i === days.length - 1 ? (
            <text key={d} x={xScale(d)} y={H - PAD_B + 16} fontSize="9" fill="#9ca3af" textAnchor="middle">
              {d.slice(5)}
            </text>
          ) : null
        )}

        {/* trajectories */}
        {shown.map((t) => {
          const color = CATEGORY_COLORS[t.category] ?? '#6b7280'
          const isEntrant = entrantSet.has(t.id)
          const active = hover === t.id
          const dim = hover != null && !active
          return (
            <g key={t.id} onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
              <path
                d={pathFor(t)}
                fill="none"
                stroke={color}
                strokeWidth={active ? 3 : 1.5}
                strokeOpacity={dim ? 0.12 : active ? 1 : 0.6}
                strokeDasharray={isEntrant ? '4,3' : ''}
              />
              {/* 오늘 위치 점 + 라벨 */}
              {t.latestRank != null && (
                <>
                  <circle cx={xScale(today)} cy={yScale(t.latestRank)} r={active ? 4 : 2.5} fill={color} fillOpacity={dim ? 0.2 : 1} />
                  <text
                    x={W - PAD_R + 8}
                    y={yScale(t.latestRank) + 3}
                    fontSize="10"
                    fill={dim ? '#d1d5db' : active ? '#111827' : '#6b7280'}
                    fontWeight={active || isEntrant ? 'bold' : 'normal'}
                  >
                    {t.latestRank}. {t.name.length > 24 ? t.name.slice(0, 24) + '…' : t.name}
                    {isEntrant ? ' 🆕' : ''}
                  </text>
                </>
              )}
            </g>
          )
        })}
      </svg>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-500">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5" style={{ background: color }} />
            {cat}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-gray-400" /> 신규 진입
        </span>
      </div>
    </div>
  )
}
