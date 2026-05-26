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
  rrs?: number
}

const RRS_BLOCK_THRESHOLD = 0.35
const RRS_WARN_THRESHOLD = 0.2
const REVERSE_LOGISTICS_FACTOR = 0.6 // 반품 1건당 마진 60% 잠식 (가정)

function rrsBadgeColor(rrs: number): string {
  if (rrs >= RRS_BLOCK_THRESHOLD) return '#dc2626' // red
  if (rrs >= RRS_WARN_THRESHOLD) return '#f59e0b' // amber
  return '#10b981' // green
}

function rrsLabel(rrs: number): string {
  if (rrs >= RRS_BLOCK_THRESHOLD) return 'BLOCK'
  if (rrs >= RRS_WARN_THRESHOLD) return 'WARN'
  return 'PASS'
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function OpportunityScatter({
  rows,
  riskByCategory = {},
}: {
  rows: Row[]
  riskByCategory?: Record<string, number>
}) {
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

          {/* 점들 */}
          {rows.map((r) => {
            const rrs = r.rrs ?? riskByCategory[r.category] ?? 0
            const blocked = rrs >= RRS_BLOCK_THRESHOLD
            const warned = !blocked && rrs >= RRS_WARN_THRESHOLD
            const baseColor = CATEGORY_COLORS[r.category] ?? '#6b7280'
            return (
              <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
                <circle
                  cx={xScale(r.x)}
                  cy={yScale(r.y)}
                  r={rScale(r.size)}
                  fill={blocked ? '#dc2626' : baseColor}
                  fillOpacity={blocked ? 0.35 : 0.55}
                  stroke={blocked ? '#dc2626' : warned ? '#f59e0b' : baseColor}
                  strokeWidth={blocked || warned ? 2 : 1}
                  strokeOpacity={0.9}
                  strokeDasharray={blocked ? '4,2' : undefined}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {/* hover tooltip */}
        {hover && (() => {
          const rrs = hover.rrs ?? riskByCategory[hover.category] ?? 0
          const realizedFactor = Math.max(0, 1 - rrs * REVERSE_LOGISTICS_FACTOR)
          return (
            <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
              <div className="font-semibold">{hover.name}</div>
              <div>category: {hover.category}</div>
              <div>final: {hover.final} · trend: {hover.y} · competition: {hover.x} · supplier: {hover.supplier}</div>
              <div className="mt-1 pt-1 border-t border-white/20">
                RRS{' '}
                <span style={{ color: rrsBadgeColor(rrs) }} className="font-mono font-bold">
                  {rrs.toFixed(3)} ({rrsLabel(rrs)})
                </span>
              </div>
              <div className="text-[10px] text-gray-300">
                실현마진 ≈ 명목 × {realizedFactor.toFixed(2)} (역물류 {REVERSE_LOGISTICS_FACTOR})
              </div>
            </div>
          )
        })()}
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

      {/* RRS 히트맵: 카테고리별 평균 반품 리스크 */}
      {Object.keys(riskByCategory).length > 0 && (
        <div className="mt-4 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold mb-2">
            🛑 Return Risk (카테고리 평균) ·{' '}
            <span className="text-xs font-normal text-gray-500">
              임계 ≥ {RRS_BLOCK_THRESHOLD} 자동 hide · ≥ {RRS_WARN_THRESHOLD} 주의
            </span>
          </h3>
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(riskByCategory)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, rrs]) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 rounded border px-2 py-1"
                  style={{ borderColor: rrsBadgeColor(rrs) }}
                >
                  <span className="font-medium">{cat}</span>
                  <span className="font-mono" style={{ color: rrsBadgeColor(rrs) }}>
                    {rrs.toFixed(3)} {rrsLabel(rrs)}
                  </span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* 우상단 sub-list */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">핀 후보 (trend≥60 + competition≥60)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.y >= 60 && r.x >= 60)
            .sort((a, b) => b.final - a.final)
            .slice(0, 10)
            .map((r) => {
              const rrs = r.rrs ?? riskByCategory[r.category] ?? 0
              const blocked = rrs >= RRS_BLOCK_THRESHOLD
              return (
                <Link
                  key={r.id}
                  href={`/admin/trend-radar/products/${r.id}`}
                  className={`flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 ${blocked ? 'opacity-60' : ''}`}
                >
                  <span className="font-mono text-gray-500">{r.final}</span>
                  <span className="flex-1 truncate">{r.name}</span>
                  {rrs > 0 && (
                    <span
                      className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                      style={{
                        background: rrsBadgeColor(rrs) + '22',
                        color: rrsBadgeColor(rrs),
                      }}
                      title={`RRS=${rrs.toFixed(3)} · 실현마진 ≈ 명목 × ${Math.max(0, 1 - rrs * REVERSE_LOGISTICS_FACTOR).toFixed(2)}`}
                    >
                      RRS {rrs.toFixed(2)}
                    </span>
                  )}
                </Link>
              )
            })}
          {rows.filter((r) => r.y >= 60 && r.x >= 60).length === 0 && (
            <div className="text-gray-400 text-xs">아직 우상단 후보 없음. 30일 누적 후 자연 등장.</div>
          )}
        </div>
      </div>
    </div>
  )
}
