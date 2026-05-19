'use client'
import { useMemo, useState } from 'react'

interface Row {
  keyword: string
  source: string
  category_top: string | null
  volume: number
  velocity: number
  acceleration: number
  quadrant: number
  quadrant_label: string
  day_count: number
  spark: number[] | null
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  food: '#84cc16',
  beauty: '#ec4899',
  all: '#6b7280',
}

function colorFor(cat: string | null) {
  if (!cat) return '#9ca3af'
  return CATEGORY_COLORS[cat] ?? '#9ca3af'
}

export default function VelocityQuadrant({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 760
  const H = 520
  const PAD = 60

  const { vMax, aMax, vMin, aMin, volMax } = useMemo(() => {
    let vMax = 1, vMin = -1, aMax = 1, aMin = -1, volMax = 1
    for (const r of rows) {
      if (r.velocity > vMax) vMax = r.velocity
      if (r.velocity < vMin) vMin = r.velocity
      if (r.acceleration > aMax) aMax = r.acceleration
      if (r.acceleration < aMin) aMin = r.acceleration
      if (r.volume > volMax) volMax = r.volume
    }
    // 대칭 스케일
    const vAbs = Math.max(Math.abs(vMax), Math.abs(vMin), 1)
    const aAbs = Math.max(Math.abs(aMax), Math.abs(aMin), 1)
    return { vMax: vAbs, vMin: -vAbs, aMax: aAbs, aMin: -aAbs, volMax }
  }, [rows])

  const xScale = (v: number) => PAD + ((v - vMin) / (vMax - vMin)) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - ((v - aMin) / (aMax - aMin)) * (H - 2 * PAD)
  const rScale = (v: number) => 3 + Math.sqrt(Math.max(0, v) / volMax) * 14

  const cx0 = xScale(0)
  const cy0 = yScale(0)

  return (
    <div className="rounded border border-gray-200 p-4 bg-white">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 */}
          <rect x={cx0} y={PAD} width={W - PAD - cx0} height={cy0 - PAD} fill="#f0fdf4" opacity={0.6} />
          <rect x={cx0} y={cy0} width={W - PAD - cx0} height={H - PAD - cy0} fill="#fffbeb" opacity={0.6} />
          <rect x={PAD} y={cy0} width={cx0 - PAD} height={H - PAD - cy0} fill="#fef2f2" opacity={0.6} />
          <rect x={PAD} y={PAD} width={cx0 - PAD} height={cy0 - PAD} fill="#eff6ff" opacity={0.6} />

          {/* 축 */}
          <line x1={PAD} y1={cy0} x2={W - PAD} y2={cy0} stroke="#9ca3af" strokeWidth={1.5} />
          <line x1={cx0} y1={PAD} x2={cx0} y2={H - PAD} stroke="#9ca3af" strokeWidth={1.5} />

          {/* 사분면 라벨 */}
          <text x={cx0 + (W - PAD - cx0) / 2} y={PAD + 18} fontSize="12" fill="#047857" fontWeight="bold" textAnchor="middle">
            ① 초기등판 (즉시 진입)
          </text>
          <text x={cx0 + (W - PAD - cx0) / 2} y={H - PAD - 8} fontSize="12" fill="#b45309" fontWeight="bold" textAnchor="middle">
            ② 정점임박 (보류 · 회수)
          </text>
          <text x={PAD + (cx0 - PAD) / 2} y={H - PAD - 8} fontSize="12" fill="#b91c1c" fontWeight="bold" textAnchor="middle">
            ③ 퇴조 (손절)
          </text>
          <text x={PAD + (cx0 - PAD) / 2} y={PAD + 18} fontSize="12" fill="#1d4ed8" fontWeight="bold" textAnchor="middle">
            ④ 반등 (관찰)
          </text>

          {/* 축 라벨 */}
          <text x={W - PAD + 6} y={cy0 + 4} fontSize="11" fill="#4b5563">
            velocity →
          </text>
          <text x={cx0 + 6} y={PAD - 8} fontSize="11" fill="#4b5563">
            ↑ acceleration
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <circle
              key={`${r.source}:${r.keyword}`}
              cx={xScale(r.velocity)}
              cy={yScale(r.acceleration)}
              r={rScale(r.volume)}
              fill={colorFor(r.category_top)}
              fillOpacity={0.55}
              stroke={colorFor(r.category_top)}
              strokeOpacity={0.9}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}

          {/* hover spark */}
          {hover && hover.spark && hover.spark.length > 1 && (() => {
            const s = hover.spark
            const sMax = Math.max(...s, 1)
            const sMin = Math.min(...s, 0)
            const sW = 160
            const sH = 40
            const sx = W - PAD - sW
            const sy = PAD + 6
            const pts = s
              .map((v, i) => {
                const x = sx + (i / (s.length - 1)) * sW
                const y = sy + sH - ((v - sMin) / Math.max(sMax - sMin, 0.0001)) * sH
                return `${x.toFixed(1)},${y.toFixed(1)}`
              })
              .join(' ')
            return (
              <g>
                <rect x={sx - 6} y={sy - 6} width={sW + 12} height={sH + 12} rx={4} fill="#ffffff" stroke="#e5e7eb" />
                <polyline points={pts} fill="none" stroke={colorFor(hover.category_top)} strokeWidth={1.5} />
                <text x={sx} y={sy - 8} fontSize="9" fill="#6b7280">
                  최근 {s.length}일 volume
                </text>
              </g>
            )
          })()}
        </svg>

        {hover && (
          <div className="absolute top-2 left-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs pointer-events-none">
            <div className="font-semibold">{hover.keyword}</div>
            <div className="opacity-80">
              {hover.source} · {hover.category_top ?? '—'}
            </div>
            <div>
              v {hover.velocity.toFixed(2)} · a {hover.acceleration.toFixed(2)} · vol {hover.volume.toFixed(1)} · {hover.quadrant_label}
            </div>
            <div className="opacity-60">n={hover.day_count}일</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
      </div>
    </div>
  )
}
