'use client'
import { useState } from 'react'
import type { PinDecayRow } from './page'

const QUADRANT_COLOR: Record<string, string> = {
  alive: '#10b981',
  slowing: '#f59e0b',
  saturated: '#f97316',
  dead: '#ef4444',
  unknown: '#9ca3af',
}

export default function PinWatchdogScatter({ rows }: { rows: PinDecayRow[] }) {
  const [hover, setHover] = useState<PinDecayRow | null>(null)

  const W = 720
  const H = 480
  const PAD = 60

  // x: trend strength (final_score + slope normalized) → 0~100
  // y: saturation (competition_score) → 0~100
  const xVal = (r: PinDecayRow) => {
    const f = r.final_score_latest ?? 0
    const slopeBoost = Math.max(-20, Math.min(20, (r.final_slope_window ?? 0) * 5))
    return Math.max(0, Math.min(100, f + slopeBoost))
  }
  const yVal = (r: PinDecayRow) => Math.max(0, Math.min(100, r.competition_score_latest ?? 0))
  const rVal = (r: PinDecayRow) =>
    4 + Math.min(14, Math.max(0, (r.pin_health_score ?? 0) / 8))

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 4사분면 배경 */}
          <rect x={xScale(50)} y={yScale(100)} width={xScale(100) - xScale(50)} height={yScale(50) - yScale(100)} fill="#fff7ed" />
          <rect x={xScale(0)}  y={yScale(100)} width={xScale(50) - xScale(0)}   height={yScale(50) - yScale(100)} fill="#fef2f2" />
          <rect x={xScale(50)} y={yScale(50)}  width={xScale(100) - xScale(50)} height={yScale(0)  - yScale(50)}  fill="#f0fdf4" />
          <rect x={xScale(0)}  y={yScale(50)}  width={xScale(50) - xScale(0)}   height={yScale(0)  - yScale(50)}  fill="#fefce8" />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">
            trend strength (→ 살아있음)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            competition (↑ 포화)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(92)} fontSize="11" fill="#f97316" fontWeight="bold" textAnchor="middle">
            🟧 포화 (정리 검토)
          </text>
          <text x={xScale(25)} y={yScale(92)} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            🔴 소멸 (종료)
          </text>
          <text x={xScale(75)} y={yScale(45)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🟢 살아있음 (유지)
          </text>
          <text x={xScale(25)} y={yScale(45)} fontSize="11" fill="#ca8a04" fontWeight="bold" textAnchor="middle">
            🟡 둔화 (리스팅 갱신)
          </text>

          {/* 점들 */}
          {rows.map((r) => {
            const q = (r.pin_quadrant ?? 'unknown') as string
            const fill = QUADRANT_COLOR[q] ?? '#9ca3af'
            return (
              <circle
                key={`${r.source}::${r.keyword}`}
                cx={xScale(xVal(r))}
                cy={yScale(yVal(r))}
                r={rVal(r)}
                fill={fill}
                fillOpacity={0.55}
                stroke={fill}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.keyword}</div>
            <div>source: {hover.source}</div>
            <div>
              final: {hover.final_score_latest?.toFixed(0) ?? '—'} · slope:{' '}
              {hover.final_slope_window?.toFixed(2) ?? '—'} · comp:{' '}
              {hover.competition_score_latest?.toFixed(0) ?? '—'}
            </div>
            <div>부패도: {hover.pin_health_score?.toFixed(0) ?? '—'}</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(QUADRANT_COLOR).map(([q, c]) => (
          <span key={q} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: c, opacity: 0.6 }} />
            {q}
          </span>
        ))}
      </div>
    </div>
  )
}
