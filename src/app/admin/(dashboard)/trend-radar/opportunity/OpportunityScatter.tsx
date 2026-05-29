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
  returnRisk?: number | null
  returnGate?: string | null
}

// 반품 리스크 게이트 → 점 테두리 색 오버레이
const RISK_STROKE: Record<string, string> = {
  high: '#dc2626',   // red-600
  medium: '#f59e0b', // amber-500
  low: '#10b981',    // emerald-500
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function OpportunityScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // x, y 0-100 → SVG 좌표
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

          {/* 점들 — 채움 = 카테고리색, 테두리 = 반품 리스크 게이트(점선) */}
          {rows.map((r) => {
            const riskStroke = r.returnGate ? RISK_STROKE[r.returnGate] : null
            const catColor = CATEGORY_COLORS[r.category] ?? '#6b7280'
            return (
              <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
                <circle
                  cx={xScale(r.x)}
                  cy={yScale(r.y)}
                  r={rScale(r.size)}
                  fill={catColor}
                  fillOpacity={0.55}
                  stroke={riskStroke ?? catColor}
                  strokeWidth={riskStroke ? 2.5 : 1}
                  strokeDasharray={riskStroke ? '3,2' : ''}
                  strokeOpacity={0.95}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {/* hover tooltip */}
        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>final: {hover.final} · trend: {hover.y} · competition: {hover.x} · supplier: {hover.supplier}</div>
            {hover.returnRisk != null && (
              <div className="mt-1 border-t border-white/20 pt-1">
                반품 리스크: <span className="font-semibold">{hover.returnRisk}</span> ({hover.returnGate})
              </div>
            )}
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

      {/* 반품 리스크 테두리 범례 */}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span>테두리(점선) = 반품 리스크:</span>
        {Object.entries(RISK_STROKE).map(([gate, color]) => (
          <span key={gate} className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-dashed"
              style={{ borderColor: color }}
            />
            {gate}
          </span>
        ))}
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
