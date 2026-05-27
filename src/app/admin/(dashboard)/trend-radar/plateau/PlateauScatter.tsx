'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface PlateauRow {
  id: string
  name: string
  category: string
  trend: number
  commerce: number
  competition: number
  supplier: number
  final: number
  trendStddev: number
  trendVelocityStddev: number | null
  trendSampleCount: number
  supplierPriceCv: number | null
  supplierCount: number
  ggsanGoodsNo: string | null
  ggsanTitle: string | null
  ggsanSim: number | null
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function PlateauScatter({ rows }: { rows: PlateauRow[] }) {
  const [hover, setHover] = useState<PlateauRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.sqrt(Math.max(50, v * 4) / Math.PI) * 1.2

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 — 우상단 */}
          <rect
            x={xScale(60)}
            y={yScale(100)}
            width={xScale(100) - xScale(60)}
            height={yScale(70) - yScale(100)}
            fill="#fefce8"
          />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">{v}</text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">{v}</text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            competition (→ 경쟁 약함)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            commerce (↑ 마진·구매력)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(80)} y={yScale(95)} fontSize="11" fill="#a16207" fontWeight="bold" textAnchor="middle">
            💎 Plateau Goldmine
          </text>

          {/* 점들 — 크기는 supplier_score */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.competition)}
                cy={yScale(r.commerce)}
                r={rScale(r.supplier)}
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
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>
              trend {hover.trend.toFixed(1)} (σ{hover.trendStddev.toFixed(1)}) · commerce {hover.commerce.toFixed(0)} · competition {hover.competition.toFixed(0)}
            </div>
            {hover.ggsanGoodsNo && (
              <div className="text-amber-300">ggsan: {hover.ggsanGoodsNo} (sim {(hover.ggsanSim ?? 0).toFixed(2)})</div>
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
        <span className="text-gray-400">· 원 크기 = supplier_score</span>
      </div>

      {/* 결과 표 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">정체수요 × 고-Commerce × 저-경쟁 후보 ({rows.length}건)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500 border-b border-gray-200">
              <tr>
                <th className="py-2 pr-2">상품명</th>
                <th className="py-2 pr-2 text-right">trend</th>
                <th className="py-2 pr-2 text-right">σ(30d)</th>
                <th className="py-2 pr-2 text-right">commerce</th>
                <th className="py-2 pr-2 text-right">competition</th>
                <th className="py-2 pr-2 text-right">supplier CV%</th>
                <th className="py-2 pr-2">ggsan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 pr-2">
                    <Link href={`/admin/trend-radar/products/${r.id}`} className="hover:underline">
                      {r.name}
                    </Link>
                    <span className="ml-2 text-gray-400">{r.category}</span>
                  </td>
                  <td className="py-2 pr-2 text-right font-mono">{r.trend.toFixed(1)}</td>
                  <td className="py-2 pr-2 text-right font-mono text-amber-700">{r.trendStddev.toFixed(2)}</td>
                  <td className="py-2 pr-2 text-right font-mono">{r.commerce.toFixed(0)}</td>
                  <td className="py-2 pr-2 text-right font-mono">{r.competition.toFixed(0)}</td>
                  <td className="py-2 pr-2 text-right font-mono text-gray-500">
                    {r.supplierPriceCv != null ? r.supplierPriceCv.toFixed(1) : '—'}
                  </td>
                  <td className="py-2 pr-2">
                    {r.ggsanGoodsNo ? (
                      <span className="text-amber-700" title={r.ggsanTitle ?? ''}>
                        {r.ggsanGoodsNo} <span className="text-gray-400">({(r.ggsanSim ?? 0).toFixed(2)})</span>
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="text-gray-400 text-xs py-6 text-center">
              조건에 맞는 정체 후보 없음. stddev 임계치를 높이거나 commerce/competition 기준을 낮춰보기.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
