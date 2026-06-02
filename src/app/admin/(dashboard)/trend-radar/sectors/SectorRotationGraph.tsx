'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

export interface SectorRow {
  category_top: string
  category_mid: string | null
  product_count: number
  rising_count: number
  breadth_pct: number | null
  level: number | null
  prior_level: number | null
  momentum: number | null
  trend_level: number | null
}

const TOP_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
}

// RRG 4분면 분류 — 축 교차점(cx, cy) 기준
function quadrant(level: number, momentum: number, cx: number, cy: number) {
  if (level >= cx && momentum >= cy) return { key: 'leading', label: '주도', color: '#10b981' }
  if (level >= cx && momentum < cy) return { key: 'weakening', label: '둔화', color: '#f59e0b' }
  if (level < cx && momentum < cy) return { key: 'lagging', label: '소외', color: '#9ca3af' }
  return { key: 'improving', label: '회복', color: '#3b82f6' }
}

export default function SectorRotationGraph({
  rows,
  drilldown,
}: {
  rows: SectorRow[]
  drilldown: boolean
}) {
  const [hover, setHover] = useState<SectorRow | null>(null)

  const pts = useMemo(
    () =>
      rows
        .filter((r) => r.level != null && r.momentum != null)
        .map((r) => ({
          ...r,
          lvl: Number(r.level),
          mom: Number(r.momentum),
          breadth: Number(r.breadth_pct ?? 0),
        })),
    [rows],
  )

  // 축 교차점: level 은 카테고리 평균, momentum 은 0(상승/하락 경계)
  const cx = pts.length ? pts.reduce((a, p) => a + p.lvl, 0) / pts.length : 50
  const cy = 0

  // 동적 도메인 (여유 패딩)
  const lvls = pts.map((p) => p.lvl)
  const moms = pts.map((p) => p.mom)
  const xMin = Math.min(...lvls, cx) - 5
  const xMax = Math.max(...lvls, cx) + 5
  const yAbs = Math.max(5, ...moms.map((m) => Math.abs(m))) + 2
  const yMin = -yAbs
  const yMax = yAbs

  const W = 720
  const H = 520
  const PAD = 56

  const xScale = (v: number) => PAD + ((v - xMin) / (xMax - xMin || 1)) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - ((v - yMin) / (yMax - yMin || 1)) * (H - 2 * PAD)
  const rScale = (breadth: number) => 8 + (breadth / 100) * 18

  const cxPx = xScale(cx)
  const cyPx = yScale(cy)

  const label = (r: SectorRow) => (drilldown ? r.category_mid ?? '(미지정)' : r.category_top)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 4분면 배경 */}
          <rect x={cxPx} y={PAD} width={W - PAD - cxPx} height={cyPx - PAD} fill="#f0fdf4" />
          <rect x={cxPx} y={cyPx} width={W - PAD - cxPx} height={H - PAD - cyPx} fill="#fffbeb" />
          <rect x={PAD} y={cyPx} width={cxPx - PAD} height={H - PAD - cyPx} fill="#f9fafb" />
          <rect x={PAD} y={PAD} width={cxPx - PAD} height={cyPx - PAD} fill="#eff6ff" />

          {/* 교차 축 */}
          <line x1={cxPx} y1={PAD} x2={cxPx} y2={H - PAD} stroke="#9ca3af" strokeWidth={1.2} />
          <line x1={PAD} y1={cyPx} x2={W - PAD} y2={cyPx} stroke="#9ca3af" strokeWidth={1.2} />

          {/* 외곽 */}
          <rect x={PAD} y={PAD} width={W - 2 * PAD} height={H - 2 * PAD} fill="none" stroke="#e5e7eb" />

          {/* 분면 라벨 */}
          <text x={W - PAD - 6} y={PAD + 16} fontSize="12" fill="#10b981" fontWeight="bold" textAnchor="end">
            🟢 주도 (강·상승)
          </text>
          <text x={W - PAD - 6} y={H - PAD - 8} fontSize="12" fill="#f59e0b" fontWeight="bold" textAnchor="end">
            🟡 둔화 (강·하락)
          </text>
          <text x={PAD + 6} y={PAD + 16} fontSize="12" fill="#3b82f6" fontWeight="bold" textAnchor="start">
            🔵 회복 (약·상승)
          </text>
          <text x={PAD + 6} y={H - PAD - 8} fontSize="12" fill="#9ca3af" fontWeight="bold" textAnchor="start">
            ⚪ 소외 (약·하락)
          </text>

          {/* 축 제목 */}
          <text x={W / 2} y={H - 12} fontSize="11" fill="#6b7280" textAnchor="middle">
            상대 강도 level → (평균 final_score, 점선 = 카테고리 평균 {cx.toFixed(1)})
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            모멘텀 ↑ (직전 7일 대비 변화)
          </text>

          {/* 점 */}
          {pts.map((p) => {
            const q = quadrant(p.lvl, p.mom, cx, cy)
            const cxp = xScale(p.lvl)
            const cyp = yScale(p.mom)
            const color = drilldown ? q.color : TOP_COLORS[p.category_top] ?? q.color
            const circle = (
              <g
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: drilldown ? 'default' : 'pointer' }}
              >
                <circle
                  cx={cxp}
                  cy={cyp}
                  r={rScale(p.breadth)}
                  fill={color}
                  fillOpacity={0.5}
                  stroke={color}
                  strokeOpacity={0.95}
                  strokeWidth={1.5}
                />
                <text x={cxp} y={cyp - rScale(p.breadth) - 4} fontSize="11" fontWeight="600" fill="#374151" textAnchor="middle">
                  {label(p)}
                </text>
              </g>
            )
            return drilldown ? (
              <g key={(p.category_mid ?? '') + p.category_top}>{circle}</g>
            ) : (
              <a key={p.category_top} href={`/admin/trend-radar/sectors?top=${encodeURIComponent(p.category_top)}`}>
                {circle}
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{label(hover)}</div>
            <div>분면: {quadrant(Number(hover.level), Number(hover.momentum), cx, cy).label}</div>
            <div>
              level {hover.level} · momentum {Number(hover.momentum) > 0 ? '+' : ''}
              {hover.momentum}
            </div>
            <div>
              breadth {hover.breadth_pct}% · 상품 {hover.rising_count}/{hover.product_count} 상승
            </div>
            {!drilldown && <div className="text-gray-300 mt-1">클릭 → mid 드릴다운</div>}
          </div>
        )}
      </div>

      {/* 우선순위 테이블 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">우선순위 (level↓ 정렬)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-1 pr-4">{drilldown ? 'category_mid' : 'category_top'}</th>
                <th className="py-1 pr-4">분면</th>
                <th className="py-1 pr-4 text-right">level</th>
                <th className="py-1 pr-4 text-right">momentum</th>
                <th className="py-1 pr-4 text-right">breadth</th>
                <th className="py-1 pr-4 text-right">상품</th>
              </tr>
            </thead>
            <tbody>
              {pts
                .slice()
                .sort((a, b) => b.lvl - a.lvl)
                .map((p) => {
                  const q = quadrant(p.lvl, p.mom, cx, cy)
                  const name = label(p)
                  const cell = (
                    <>
                      <td className="py-1 pr-4 font-medium">{name}</td>
                      <td className="py-1 pr-4">
                        <span className="inline-block px-2 py-0.5 rounded text-xs text-white" style={{ background: q.color }}>
                          {q.label}
                        </span>
                      </td>
                      <td className="py-1 pr-4 text-right font-mono">{p.lvl.toFixed(1)}</td>
                      <td className={`py-1 pr-4 text-right font-mono ${p.mom >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {p.mom > 0 ? '+' : ''}
                        {p.mom.toFixed(1)}
                      </td>
                      <td className="py-1 pr-4 text-right font-mono">{p.breadth.toFixed(0)}%</td>
                      <td className="py-1 pr-4 text-right font-mono text-gray-500">
                        {p.rising_count}/{p.product_count}
                      </td>
                    </>
                  )
                  return drilldown ? (
                    <tr key={(p.category_mid ?? '') + p.category_top} className="border-b border-gray-100">
                      {cell}
                    </tr>
                  ) : (
                    <tr key={p.category_top} className="border-b border-gray-100 hover:bg-gray-50">
                      <td colSpan={6} className="p-0">
                        <Link
                          href={`/admin/trend-radar/sectors?top=${encodeURIComponent(p.category_top)}`}
                          className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-0"
                        >
                          <span className="py-1 font-medium">{name}</span>
                          <span className="py-1">
                            <span className="inline-block px-2 py-0.5 rounded text-xs text-white" style={{ background: q.color }}>
                              {q.label}
                            </span>
                          </span>
                          <span className="py-1 font-mono text-right">{p.lvl.toFixed(1)}</span>
                          <span className={`py-1 font-mono text-right ${p.mom >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {p.mom > 0 ? '+' : ''}
                            {p.mom.toFixed(1)}
                          </span>
                          <span className="py-1 font-mono text-right">{p.breadth.toFixed(0)}%</span>
                          <span className="py-1 font-mono text-right text-gray-500">
                            {p.rising_count}/{p.product_count}
                          </span>
                        </Link>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
        {!drilldown && (
          <p className="mt-3 text-xs text-gray-400">
            행/점 클릭 → 해당 category_top 의 category_mid 단위로 드릴다운.
          </p>
        )}
      </div>
    </div>
  )
}
