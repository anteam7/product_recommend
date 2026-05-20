'use client'
import { useState } from 'react'

interface Row {
  id: string
  predicted: number
  realized: number
  category: string
  checkpoint: number
  keyword: string
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
  _unknown: '#9ca3af',
}

export default function CalibrationScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (Math.max(0, Math.min(100, v)) / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.max(0, Math.min(100, v)) / 100) * (H - 2 * PAD)
  const rScale = (cp: number) => (cp === 30 ? 4 : cp === 60 ? 6 : 8)

  const cats = Array.from(new Set(rows.map((r) => r.category)))

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 대각선 (예측 = 실현) */}
          <line x1={xScale(0)} y1={yScale(0)} x2={xScale(100)} y2={yScale(100)} stroke="#d1d5db" strokeDasharray="4,4" />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#f3f4f6" />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#f3f4f6" />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            예측 final_score (핀 시점)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            실현 realized_score (체크포인트)
          </text>

          {/* 영역 라벨 */}
          <text x={xScale(80)} y={yScale(20)} fontSize="11" fill="#dc2626" textAnchor="middle">
            예측 초과 (헛스윙)
          </text>
          <text x={xScale(20)} y={yScale(80)} fontSize="11" fill="#059669" textAnchor="middle">
            과소평가 (놓친 기회)
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <circle
              key={r.id}
              cx={xScale(r.predicted)}
              cy={yScale(r.realized)}
              r={rScale(r.checkpoint)}
              fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
              fillOpacity={0.7}
              stroke="#fff"
              strokeWidth={1}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {/* 범례 */}
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-600">
          {cats.map((c) => (
            <span key={c} className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ background: CATEGORY_COLORS[c] ?? '#6b7280' }}
              />
              {c}
            </span>
          ))}
          <span className="ml-4 text-gray-400">크기 = checkpoint (30/60/90일)</span>
        </div>

        {/* 호버 정보 */}
        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white px-3 py-2 text-xs space-y-0.5 pointer-events-none">
            <div className="font-semibold">{hover.keyword}</div>
            <div>예측 {hover.predicted.toFixed(1)} → 실현 {hover.realized.toFixed(1)}</div>
            <div className="text-gray-300">
              {hover.category} · +{hover.checkpoint}일
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
