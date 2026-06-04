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
  regime?: string | null
  blocker?: string
}

// 위탁 차단 강도별 배지
const BLOCKER_BADGE: Record<string, { icon: string; label: string; cls: string }> = {
  blocker: { icon: '⛔', label: '위탁불가', cls: 'bg-red-100 text-red-700' },
  high: { icon: '⚠️', label: '인증필요', cls: 'bg-amber-100 text-amber-800' },
  low: { icon: '🛡️', label: '경미', cls: 'bg-gray-100 text-gray-600' },
  none: { icon: '✅', label: '즉시판매', cls: 'bg-emerald-100 text-emerald-700' },
}
const isHeavy = (b?: string) => b === 'blocker' || b === 'high'

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

          {/* 점들 — 인증부담(blocker/high)은 회색 처리해 헛소싱 차단 */}
          {rows.map((r) => {
            const heavy = isHeavy(r.blocker)
            const color = heavy ? '#9ca3af' : CATEGORY_COLORS[r.category] ?? '#6b7280'
            return (
              <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
                <circle
                  cx={xScale(r.x)}
                  cy={yScale(r.y)}
                  r={rScale(r.size)}
                  fill={color}
                  fillOpacity={heavy ? 0.2 : 0.55}
                  stroke={color}
                  strokeOpacity={heavy ? 0.5 : 0.9}
                  strokeDasharray={r.blocker === 'blocker' ? '3,2' : ''}
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
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-1">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>final: {hover.final} · trend: {hover.y} · competition: {hover.x} · supplier: {hover.supplier}</div>
            <div>
              🛡️ {BLOCKER_BADGE[hover.blocker ?? 'none']?.icon} {BLOCKER_BADGE[hover.blocker ?? 'none']?.label}
              {hover.regime && hover.regime !== '해당없음' ? ` · ${hover.regime}` : ''}
            </div>
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
                className={`flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 ${
                  isHeavy(r.blocker) ? 'opacity-50' : ''
                }`}
              >
                <span className="font-mono text-gray-500">{r.final}</span>
                {(() => {
                  const b = BLOCKER_BADGE[r.blocker ?? 'none']
                  return b ? (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${b.cls}`}>
                      {b.icon} {r.regime && r.regime !== '해당없음' ? r.regime : b.label}
                    </span>
                  ) : null
                })()}
                <span className="truncate">{r.name}</span>
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
