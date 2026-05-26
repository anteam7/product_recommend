'use client'
import { useState } from 'react'

interface Row {
  product_id: string
  ggsan_sku: string | null
  sellers_count: number | null
  winner_price: number | null
  winner_badge_type: string | null
  winner_churn_30d: number | null
  canonical_review_count: number | null
  snapshot_at: string
  quadrant: 'NO_ENTRY' | 'ENTRY_OK' | 'WATCH' | 'GREY'
  title?: string | null
}

const QUADRANT_COLORS: Record<Row['quadrant'], string> = {
  NO_ENTRY: '#ef4444',
  ENTRY_OK: '#10b981',
  WATCH: '#f59e0b',
  GREY: '#9ca3af',
}

export default function CatalogCrowdingScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // X: sellers_count 0..max(20), Y: winner_churn_30d 0..max(15)
  const maxSellers = Math.max(20, ...rows.map((r) => r.sellers_count ?? 0))
  const maxChurn = Math.max(15, ...rows.map((r) => r.winner_churn_30d ?? 0))

  const xScale = (v: number) => PAD + (Math.min(v, maxSellers) / maxSellers) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.min(v, maxChurn) / maxChurn) * (H - 2 * PAD)

  // 사분면 분할선: sellers=5, churn=4
  const xCut = xScale(5)
  const yCut = yScale(4)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 */}
          <rect x={PAD} y={yCut} width={xCut - PAD} height={H - PAD - yCut} fill="#f0fdf4" />
          <rect x={xCut} y={PAD} width={W - PAD - xCut} height={yCut - PAD} fill="#fef2f2" />
          <rect x={PAD} y={PAD} width={xCut - PAD} height={yCut - PAD} fill="#fffbeb" />

          {/* 분할선 */}
          <line x1={xCut} y1={PAD} x2={xCut} y2={H - PAD} stroke="#d1d5db" strokeDasharray="4,3" />
          <line x1={PAD} y1={yCut} x2={W - PAD} y2={yCut} stroke="#d1d5db" strokeDasharray="4,3" />

          {/* grid + 축 라벨 */}
          {[0, 0.25, 0.5, 0.75, 1].map((p) => {
            const v = Math.round(p * maxSellers)
            return (
              <g key={'gx' + p}>
                <text x={PAD + p * (W - 2 * PAD)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                  {v}
                </text>
              </g>
            )
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((p) => {
            const v = Math.round(p * maxChurn)
            return (
              <g key={'gy' + p}>
                <text x={PAD - 8} y={H - PAD - p * (H - 2 * PAD) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {v}
                </text>
              </g>
            )
          })}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            sellers_count (→ 합류 셀러 수)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            winner_churn_30d (↑ winner 교체 빈번)
          </text>

          {/* 사분면 라벨 */}
          <text x={(PAD + xCut) / 2} y={H - PAD - 8} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            진입 가능
          </text>
          <text x={(xCut + W - PAD) / 2} y={PAD + 14} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            진입 불가
          </text>
          <text x={(PAD + xCut) / 2} y={PAD + 14} fontSize="11" fill="#f59e0b" fontWeight="bold" textAnchor="middle">
            관망 (churn↑)
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <circle
              key={r.product_id}
              cx={xScale(r.sellers_count ?? 0)}
              cy={yScale(r.winner_churn_30d ?? 0)}
              r={6}
              fill={QUADRANT_COLORS[r.quadrant]}
              fillOpacity={0.6}
              stroke={QUADRANT_COLORS[r.quadrant]}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.title?.slice(0, 50) ?? hover.product_id}</div>
            <div>sellers: {hover.sellers_count ?? '?'} · churn30: {hover.winner_churn_30d ?? 0}</div>
            <div>
              badge: {hover.winner_badge_type ?? '?'} · winner: {hover.winner_price?.toLocaleString() ?? '?'}원
            </div>
            <div>reviews: {hover.canonical_review_count?.toLocaleString() ?? '?'}</div>
          </div>
        )}
      </div>
    </div>
  )
}
