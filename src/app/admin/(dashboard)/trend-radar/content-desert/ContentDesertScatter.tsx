'use client'
import { useState } from 'react'
import type { GapRow } from './page'

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
}

export default function ContentDesertScatter({ rows }: { rows: GapRow[] }) {
  const [hover, setHover] = useState<GapRow | null>(null)
  const W = 540
  const H = 480
  const PAD_L = 50
  const PAD_R = 24
  const PAD_T = 24
  const PAD_B = 44

  // X = content_count (log scale 0..log(maxContent+1))
  // Y = demand_z  (clamp -2..3)
  const maxContent = Math.max(10, ...rows.map((r) => r.content_count ?? 0))
  const xMax = Math.log1p(maxContent)
  const yMin = -2
  const yMax = 3

  const xScale = (count: number) =>
    PAD_L + (Math.log1p(count) / xMax) * (W - PAD_L - PAD_R)
  const yScale = (z: number) => {
    const clamped = Math.min(yMax, Math.max(yMin, z))
    return (
      H -
      PAD_B -
      ((clamped - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B)
    )
  }

  // Sweet spot box: X 작음 (content_count <= 3) AND Y 큼 (demand_z >= 0.5)
  const boxX0 = xScale(0)
  const boxX1 = xScale(3)
  const boxY0 = yScale(3)
  const boxY1 = yScale(0.5)

  return (
    <div className="rounded border border-gray-200 p-4">
      <h3 className="text-sm font-semibold mb-2">
        산점도 — X 콘텐츠 수(log) · Y 수요 z-score
      </h3>
      <div className="relative">
        <svg
          width={W}
          height={H}
          className="block mx-auto"
          style={{ overflow: 'visible' }}
        >
          {/* sweet spot */}
          <rect
            x={boxX0}
            y={boxY0}
            width={boxX1 - boxX0}
            height={boxY1 - boxY0}
            fill="#dcfce7"
            opacity={0.6}
          />
          <text
            x={(boxX0 + boxX1) / 2}
            y={boxY0 + 14}
            fontSize="10"
            fill="#15803d"
            fontWeight="bold"
            textAnchor="middle"
          >
            🎯 sweet spot
          </text>

          {/* axes */}
          <line
            x1={PAD_L}
            y1={H - PAD_B}
            x2={W - PAD_R}
            y2={H - PAD_B}
            stroke="#9ca3af"
          />
          <line
            x1={PAD_L}
            y1={PAD_T}
            x2={PAD_L}
            y2={H - PAD_B}
            stroke="#9ca3af"
          />

          {/* x ticks: 0,1,3,10,30,100 */}
          {[0, 1, 3, 10, 30, 100]
            .filter((v) => v <= maxContent + 1)
            .map((v) => (
              <g key={'tx' + v}>
                <line
                  x1={xScale(v)}
                  y1={H - PAD_B}
                  x2={xScale(v)}
                  y2={H - PAD_B + 4}
                  stroke="#9ca3af"
                />
                <text
                  x={xScale(v)}
                  y={H - PAD_B + 16}
                  fontSize="10"
                  fill="#6b7280"
                  textAnchor="middle"
                >
                  {v}
                </text>
              </g>
            ))}

          {/* y ticks */}
          {[-2, -1, 0, 1, 2, 3].map((v) => (
            <g key={'ty' + v}>
              <line
                x1={PAD_L - 4}
                y1={yScale(v)}
                x2={W - PAD_R}
                y2={yScale(v)}
                stroke={v === 0 ? '#cbd5e1' : '#f1f5f9'}
                strokeDasharray={v === 0 ? '' : '2,2'}
              />
              <text
                x={PAD_L - 8}
                y={yScale(v) + 3}
                fontSize="10"
                fill="#6b7280"
                textAnchor="end"
              >
                {v}
              </text>
            </g>
          ))}

          {/* axis labels */}
          <text
            x={(PAD_L + W - PAD_R) / 2}
            y={H - 6}
            fontSize="11"
            fill="#6b7280"
            textAnchor="middle"
          >
            한국어 콘텐츠 수 (blog+news+suggest, log)
          </text>
          <text
            x={14}
            y={(PAD_T + H - PAD_B) / 2}
            fontSize="11"
            fill="#6b7280"
            textAnchor="middle"
            transform={`rotate(-90 14 ${(PAD_T + H - PAD_B) / 2})`}
          >
            수요 z-score
          </text>

          {/* points */}
          {rows.map((r) => {
            const z = r.demand_z ?? 0
            const cx = xScale(r.content_count ?? 0)
            const cy = yScale(z)
            const cat = r.category_top ?? 'all'
            const color = CATEGORY_COLORS[cat] ?? '#6b7280'
            const inSweet = z >= 0.5 && (r.content_count ?? 0) <= 3
            return (
              <a
                key={r.product_id + '::' + r.keyword}
                href={`/admin/trend-radar/products/${r.product_id}`}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={inSweet ? 6 : 4}
                  fill={color}
                  fillOpacity={inSweet ? 0.9 : 0.5}
                  stroke={color}
                  strokeOpacity={0.9}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs pointer-events-none">
            <div className="font-semibold">{hover.keyword}</div>
            {hover.canonical_name && hover.canonical_name !== hover.keyword && (
              <div className="text-gray-300">→ {hover.canonical_name}</div>
            )}
            <div className="mt-1">
              gap: {fmt(hover.gap_score)} · z: {fmt(hover.demand_z)} ·
              content: {hover.content_count}
            </div>
            <div className="text-gray-300">
              blog {hover.blog_count} · news {hover.news_count} · suggest{' '}
              {hover.suggest_count}
            </div>
            <div className="text-gray-300">
              {hover.has_ggsan_match ? 'ggsan ✓ ' : ''}
              {hover.is_pinned ? '📌 pinned' : ''}
            </div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-full"
              style={{ background: color, opacity: 0.6 }}
            />
            {cat}
          </span>
        ))}
      </div>
    </div>
  )
}

function fmt(v: number | null | undefined) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(2)
}
