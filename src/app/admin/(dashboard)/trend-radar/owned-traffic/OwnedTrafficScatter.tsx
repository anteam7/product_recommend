'use client'
import { useState } from 'react'

interface Row {
  query: string
  productId: string
  canonicalName: string
  category: string
  impressions: number
  position: number
  trendScore: number
  trendDelta: number
  priority: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function OwnedTrafficScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 760
  const H = 480
  const PAD = 60

  // X = log10(impressions), 1~1e5 → 0~100
  // Y = trendScore (0~100) + 보정 (trendDelta 가 큰 양수면 위로 살짝)
  const maxImpr = Math.max(...rows.map((r) => r.impressions), 100)
  const xRaw = (impr: number) => {
    const v = Math.log10(Math.max(impr, 1)) / Math.log10(Math.max(maxImpr, 10))
    return Math.max(0, Math.min(1, v)) * 100
  }
  const yVal = (r: Row) => Math.max(0, Math.min(100, r.trendScore))

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (priority: number) => {
    const v = Math.max(8, Math.min(80, priority))
    return Math.sqrt(v) * 1.5 + 4
  }

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우상단(높은 노출 + 높은 트렌드) 사분면 highlight */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(50) - yScale(100)}
            fill="#ecfdf5"
          />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            노출량 (log scale → 오른쪽 = 많음)
          </text>
          <text
            x={15}
            y={H / 2}
            fontSize="11"
            fill="#6b7280"
            textAnchor="middle"
            transform={`rotate(-90 15 ${H / 2})`}
          >
            트렌드 모멘텀 (final_score, ↑ 높음)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 진입 1순위 (노출많음 + 트렌드↑)
          </text>
          <text x={xScale(25)} y={yScale(95)} fontSize="11" fill="#6b7280" textAnchor="middle">
            육성 후보 (노출↓ + 트렌드↑)
          </text>
          <text x={xScale(75)} y={yScale(5)} fontSize="11" fill="#6b7280" textAnchor="middle">
            SEO 자산 (노출↑ + 트렌드↓)
          </text>

          {/* 점 */}
          {rows.map((r) => (
            <a key={r.query + r.productId} href={`/admin/trend-radar/products/${r.productId}`}>
              <circle
                cx={xScale(xRaw(r.impressions))}
                cy={yScale(yVal(r))}
                r={rScale(r.priority)}
                fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                fillOpacity={0.55}
                stroke={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            </a>
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.query}</div>
            <div className="text-[10px] text-gray-300">→ {hover.canonicalName}</div>
            <div className="mt-1">
              impr {hover.impressions.toLocaleString()} · pos {hover.position.toFixed(1)} · trend {hover.trendScore.toFixed(0)}
              {hover.trendDelta !== 0 && (
                <span className={hover.trendDelta > 0 ? ' text-emerald-400' : ' text-red-400'}>
                  {' '}
                  ({hover.trendDelta > 0 ? '+' : ''}
                  {hover.trendDelta.toFixed(1)})
                </span>
              )}
            </div>
            <div className="text-amber-300 mt-1">priority {hover.priority.toFixed(0)}</div>
          </div>
        )}
      </div>

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
