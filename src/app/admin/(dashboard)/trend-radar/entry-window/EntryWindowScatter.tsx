'use client'
import { useState } from 'react'

interface Row {
  id: string
  name: string
  cate: string
  x: number // supply_drop_pct_7d (%) — clamp -20..50 표시
  y: number // demand_accel_7d × 100 (%) — clamp -100..300 표시
  score: number
  isImminent: boolean
  dRemain: number
}

const W = 720
const H = 480
const PAD = 60

const X_MIN = -20
const X_MAX = 50
const Y_MIN = -100
const Y_MAX = 300

export default function EntryWindowScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)

  const xScale = (v: number) =>
    PAD + ((Math.max(X_MIN, Math.min(X_MAX, v)) - X_MIN) / (X_MAX - X_MIN)) * (W - 2 * PAD)
  const yScale = (v: number) =>
    H - PAD - ((Math.max(Y_MIN, Math.min(Y_MAX, v)) - Y_MIN) / (Y_MAX - Y_MIN)) * (H - 2 * PAD)
  const rScale = (s: number) => 4 + Math.sqrt(Math.max(0, s) * 300)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-sm font-semibold mb-2">4분면 산점도 — 공급개선속도 × 수요가속도</div>
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 4분면 배경: 우상단(공급↓ + 수요↑) 골든 존 */}
          <rect
            x={xScale(0)}
            y={yScale(Y_MAX)}
            width={xScale(X_MAX) - xScale(0)}
            height={yScale(0) - yScale(Y_MAX)}
            fill="#ecfdf5"
          />

          {/* 0 축 강조 */}
          <line x1={xScale(0)} y1={PAD} x2={xScale(0)} y2={H - PAD} stroke="#9ca3af" strokeWidth="1" />
          <line x1={PAD} y1={yScale(0)} x2={W - PAD} y2={yScale(0)} stroke="#9ca3af" strokeWidth="1" />

          {/* grid */}
          {[X_MIN, -10, 0, 10, 20, 30, 40, X_MAX].map((v) => (
            <g key={'gx' + v}>
              <line
                x1={xScale(v)}
                y1={PAD}
                x2={xScale(v)}
                y2={H - PAD}
                stroke="#f3f4f6"
                strokeDasharray={v === 0 ? '' : '2,3'}
              />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}%
              </text>
            </g>
          ))}
          {[Y_MIN, -50, 0, 50, 100, 150, 200, 250, Y_MAX].map((v) => (
            <g key={'gy' + v}>
              <line
                x1={PAD}
                y1={yScale(v)}
                x2={W - PAD}
                y2={yScale(v)}
                stroke="#f3f4f6"
                strokeDasharray={v === 0 ? '' : '2,3'}
              />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}%
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 20} fontSize="11" fill="#6b7280" textAnchor="middle">
            공급개선속도 — supply_drop_pct_7d (→ 더 많이 떨어짐)
          </text>
          <text x={20} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 20 ${H / 2})`}>
            수요가속도 — demand_accel_7d × 100 (↑ 가속)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(35)} y={yScale(270)} fontSize="11" fill="#059669" fontWeight="bold" textAnchor="middle">
            🎯 골든존 (공급↓ × 수요↑)
          </text>
          <text x={xScale(-10)} y={yScale(270)} fontSize="10" fill="#9ca3af" textAnchor="middle">
            수요만 ↑
          </text>
          <text x={xScale(35)} y={yScale(-50)} fontSize="10" fill="#9ca3af" textAnchor="middle">
            공급만 ↓
          </text>
          <text x={xScale(-10)} y={yScale(-50)} fontSize="10" fill="#d1d5db" textAnchor="middle">
            죽은 영역
          </text>

          {/* 점들 */}
          {rows.map((r) => {
            const isGolden = r.x > 0 && r.y > 0
            const isExpiring = isGolden && r.dRemain <= 3
            return (
              <circle
                key={r.id}
                cx={xScale(r.x)}
                cy={yScale(r.y)}
                r={rScale(r.score)}
                fill={isExpiring ? '#dc2626' : isGolden ? '#10b981' : r.isImminent ? '#f59e0b' : '#9ca3af'}
                fillOpacity={isGolden ? 0.7 : 0.35}
                stroke={isExpiring ? '#7f1d1d' : isGolden ? '#047857' : '#6b7280'}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold leading-snug">{hover.name}</div>
            <div className="text-gray-300">cate: {hover.cate}</div>
            <div>공급↓: {hover.x.toFixed(1)}% · 수요↑: {hover.y.toFixed(0)}%</div>
            <div>convergence: {hover.score.toFixed(3)}</div>
            <div className={hover.dRemain <= 3 ? 'text-red-300 font-bold' : ''}>
              {hover.dRemain > 0 ? `D-${hover.dRemain}` : 'EXPIRED'}
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-emerald-500" /> 골든존
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-red-600" /> D-3 이하 마감임박
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-amber-500 opacity-60" /> 임박특가
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-gray-400 opacity-50" /> 일반
        </span>
        <span className="ml-auto text-gray-400">크기 = convergence_score</span>
      </div>
    </div>
  )
}
