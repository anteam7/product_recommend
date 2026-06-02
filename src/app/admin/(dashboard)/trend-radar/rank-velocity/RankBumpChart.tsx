'use client'
import { useState } from 'react'

export interface BumpSeries {
  keyword: string
  source: string
  points: { day: string; rank: number | null }[]
}

const COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#a78bfa',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]

export default function RankBumpChart({ series, days }: { series: BumpSeries[]; days: string[] }) {
  const [active, setActive] = useState<string | null>(null)

  const W = 760
  const H = 420
  const PAD_L = 44
  const PAD_R = 180 // 우측 라벨 공간
  const PAD_T = 20
  const PAD_B = 36

  // y 축: rank. 1위 = 맨 위. 관측된 최대 rank 까지.
  const allRanks = series.flatMap((s) => s.points.map((p) => p.rank).filter((r): r is number => r != null))
  const maxRank = Math.max(10, ...allRanks)
  const minRank = 1

  const n = Math.max(1, days.length - 1)
  const xScale = (i: number) => PAD_L + (i / n) * (W - PAD_L - PAD_R)
  const yScale = (rank: number) =>
    PAD_T + ((rank - minRank) / (maxRank - minRank || 1)) * (H - PAD_T - PAD_B)

  // y 그리드 눈금 (rank)
  const yTicks = [1, Math.round(maxRank * 0.25), Math.round(maxRank * 0.5), Math.round(maxRank * 0.75), maxRank]
    .filter((v, i, a) => a.indexOf(v) === i)

  const buildPath = (s: BumpSeries) => {
    let d = ''
    let started = false
    s.points.forEach((p, i) => {
      if (p.rank == null) return
      const cmd = started ? 'L' : 'M'
      d += `${cmd}${xScale(i).toFixed(1)},${yScale(p.rank).toFixed(1)} `
      started = true
    })
    return d
  }

  // 우측 끝 라벨 위치: 마지막 non-null rank
  const lastPoint = (s: BumpSeries) => {
    for (let i = s.points.length - 1; i >= 0; i--) {
      if (s.points[i].rank != null) return { i, rank: s.points[i].rank as number }
    }
    return null
  }

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} className="block" style={{ overflow: 'visible' }}>
        {/* y 그리드 + rank 라벨 */}
        {yTicks.map((rk) => (
          <g key={'y' + rk}>
            <line x1={PAD_L} y1={yScale(rk)} x2={W - PAD_R} y2={yScale(rk)} stroke="#e5e7eb" strokeDasharray="2,3" />
            <text x={PAD_L - 8} y={yScale(rk) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
              {rk}위
            </text>
          </g>
        ))}

        {/* x 날짜 라벨 (처음/중간/끝) */}
        {[0, Math.floor(n / 2), n].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
          <text key={'x' + i} x={xScale(i)} y={H - PAD_B + 18} fontSize="10" fill="#9ca3af" textAnchor="middle">
            {days[i]?.slice(5)}
          </text>
        ))}

        {/* 라인 */}
        {series.map((s, idx) => {
          const color = COLORS[idx % COLORS.length]
          const dim = active != null && active !== s.keyword + s.source
          const lp = lastPoint(s)
          return (
            <g
              key={s.keyword + s.source}
              onMouseEnter={() => setActive(s.keyword + s.source)}
              onMouseLeave={() => setActive(null)}
              style={{ cursor: 'pointer' }}
            >
              <path
                d={buildPath(s)}
                fill="none"
                stroke={color}
                strokeWidth={dim ? 1 : 2.5}
                strokeOpacity={dim ? 0.25 : 1}
              />
              {s.points.map((p, i) =>
                p.rank == null ? null : (
                  <circle key={i} cx={xScale(i)} cy={yScale(p.rank)} r={dim ? 1.5 : 3} fill={color} fillOpacity={dim ? 0.3 : 1} />
                ),
              )}
              {lp && (
                <text
                  x={xScale(lp.i) + 8}
                  y={yScale(lp.rank) + 3}
                  fontSize="11"
                  fill={dim ? '#cbd5e1' : color}
                  fontWeight={dim ? 'normal' : 'bold'}
                >
                  {s.keyword.length > 16 ? s.keyword.slice(0, 16) + '…' : s.keyword}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
