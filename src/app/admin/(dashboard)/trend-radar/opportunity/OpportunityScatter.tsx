'use client'
import Link from 'next/link'
import { useState } from 'react'

interface Row {
  id: string
  name: string
  category: string
  x: number
  y: number
  size: number
  final: number
  supplier: number
  deltaFinal: number
  deltaTrend: number
  hasPrev: boolean
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

const ARROW_THRESHOLD = 5

export default function OpportunityScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.sqrt(v / Math.PI) * 1.2

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 */}
          <rect x={xScale(50)} y={yScale(100)} width={xScale(100) - xScale(50)} height={yScale(50) - yScale(100)} fill="#f0fdf4" />

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
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            competition (→ 경쟁 약함)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            trend (↑ 트렌드 강함)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 핀 후보 (트렌드↑·경쟁↓)
          </text>

          {/* 점들 + Δ 화살표 오버레이 */}
          {rows.map((r) => {
            const cx = xScale(r.x)
            const cy = yScale(r.y)
            const radius = rScale(r.size)
            const showArrow = r.hasPrev && Math.abs(r.deltaFinal) > ARROW_THRESHOLD
            const goingUp = r.deltaFinal > 0
            const arrowColor = goingUp ? '#059669' : '#dc2626'
            const arrowY = cy - radius - 4
            return (
              <g key={r.id}>
                <a href={`/admin/trend-radar/products/${r.id}`}>
                  <circle
                    cx={cx}
                    cy={cy}
                    r={radius}
                    fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                    fillOpacity={0.55}
                    stroke={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                    strokeOpacity={0.9}
                    onMouseEnter={() => setHover(r)}
                    onMouseLeave={() => setHover(null)}
                    style={{ cursor: 'pointer' }}
                  />
                </a>
                {showArrow && (
                  <g pointerEvents="none">
                    {goingUp ? (
                      <polygon
                        points={`${cx},${arrowY - 8} ${cx - 5},${arrowY} ${cx + 5},${arrowY}`}
                        fill={arrowColor}
                        stroke="#ffffff"
                        strokeWidth={1}
                      />
                    ) : (
                      <polygon
                        points={`${cx},${arrowY} ${cx - 5},${arrowY - 8} ${cx + 5},${arrowY - 8}`}
                        fill={arrowColor}
                        stroke="#ffffff"
                        strokeWidth={1}
                      />
                    )}
                    <text
                      x={cx + 7}
                      y={arrowY - 1}
                      fontSize="9"
                      fontWeight="bold"
                      fill={arrowColor}
                      textAnchor="start"
                    >
                      {goingUp ? '+' : ''}
                      {r.deltaFinal.toFixed(0)}
                    </text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>

        {/* hover tooltip */}
        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>final: {hover.final} · trend: {hover.y} · competition: {hover.x} · supplier: {hover.supplier}</div>
            {hover.hasPrev ? (
              <div className="mt-1 border-t border-white/20 pt-1">
                Δfinal: <span className={hover.deltaFinal > 0 ? 'text-emerald-300' : hover.deltaFinal < 0 ? 'text-rose-300' : ''}>
                  {hover.deltaFinal > 0 ? '+' : ''}
                  {hover.deltaFinal.toFixed(1)}
                </span>
                {' · '}
                Δtrend: <span className={hover.deltaTrend > 0 ? 'text-emerald-300' : hover.deltaTrend < 0 ? 'text-rose-300' : ''}>
                  {hover.deltaTrend > 0 ? '+' : ''}
                  {hover.deltaTrend.toFixed(1)}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-gray-400 text-[10px]">Δ 데이터 없음 (점수 누적 1회)</div>
            )}
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3 text-gray-500">
          <span className="flex items-center gap-1">
            <span className="text-emerald-600">▲</span> Δfinal &gt; {ARROW_THRESHOLD}
          </span>
          <span className="flex items-center gap-1">
            <span className="text-rose-600">▼</span> Δfinal &lt; -{ARROW_THRESHOLD}
          </span>
        </span>
      </div>

      {/* 우상단 sub-list */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">핀 후보 (trend≥60 + competition≥60)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.y >= 60 && r.x >= 60)
            .sort((a, b) => b.final - a.final)
            .slice(0, 10)
            .map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="block px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="font-mono text-gray-500 mr-2">{r.final}</span>
                {r.name}
                {r.hasPrev && Math.abs(r.deltaFinal) > 0.01 && (
                  <span
                    className={`ml-2 text-xs font-mono ${
                      r.deltaFinal > 0 ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    ({r.deltaFinal > 0 ? '+' : ''}
                    {r.deltaFinal.toFixed(1)})
                  </span>
                )}
              </Link>
            ))}
          {rows.filter((r) => r.y >= 60 && r.x >= 60).length === 0 && (
            <div className="text-gray-400 text-xs">아직 우상단 후보 없음. 30일 누적 후 자연 등장.</div>
          )}
        </div>
      </div>
    </div>
  )
}
