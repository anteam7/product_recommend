'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface VacuumRow {
  id: string
  name: string
  category: string
  brand: string | null
  genericRatio: number | null // 0~1
  trend: number // 0~100
  supplier: number // 0~100
  total: number
  generic: number
  repKeyword: string | null
}

// supplier_score → 색 (낮음 회색 → 높음 초록)
function supplierColor(s: number): string {
  if (s >= 70) return '#10b981'
  if (s >= 40) return '#f59e0b'
  if (s > 0) return '#9ca3af'
  return '#d1d5db'
}

export default function BrandVacuumScatter({ rows }: { rows: VacuumRow[] }) {
  const [hover, setHover] = useState<VacuumRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const plotted = rows.filter((r) => r.genericRatio != null)

  // x: generic_demand_ratio 0~1 → 0~100, y: trend 0~100
  const xScale = (v: number) => PAD + v * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

  // 골든존: 제네릭 수요비율↑ × 트렌드↑ × supplier 있음
  const isGolden = (r: VacuumRow) =>
    (r.genericRatio ?? 0) >= 0.6 && r.trend >= 60 && r.supplier > 0

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 골든존 배경 (우상단) */}
          <rect
            x={xScale(0.6)}
            y={yScale(100)}
            width={xScale(1) - xScale(0.6)}
            height={yScale(60) - yScale(100)}
            fill="#f0fdf4"
          />

          {/* grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v === 0 || v === 0.5 || v === 1 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {Math.round(v * 100)}%
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
            제네릭 수요비율 (→ 일반명사 검색 ↑ = 노브랜드 진입 가능)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            trend (↑ 수요 강함)
          </text>

          {/* 골든존 라벨 */}
          <text x={xScale(0.8)} y={yScale(96)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🏷️ 화이트라벨 골든존
          </text>

          {/* 점들 */}
          {plotted.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.genericRatio ?? 0)}
                cy={yScale(r.trend)}
                r={isGolden(r) ? 9 : 6}
                fill={supplierColor(r.supplier)}
                fillOpacity={0.6}
                stroke={isGolden(r) ? '#065f46' : supplierColor(r.supplier)}
                strokeWidth={isGolden(r) ? 2 : 1}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            </a>
          ))}
        </svg>

        {/* hover tooltip */}
        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>브랜드: {hover.brand ?? '(무브랜드)'}</div>
            <div>
              제네릭 수요비율: {hover.genericRatio != null ? Math.round(hover.genericRatio * 100) + '%' : '?'} ({hover.generic}/{hover.total} alias)
            </div>
            <div>trend: {hover.trend} · supplier: {hover.supplier}</div>
            {hover.repKeyword && <div>대표 일반명: “{hover.repKeyword}”</div>}
          </div>
        )}
      </div>

      {/* 범례 (supplier_score 색) */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#10b981', opacity: 0.6 }} /> supplier 강함 (≥70)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#f59e0b', opacity: 0.6 }} /> supplier 보통 (40~69)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#9ca3af', opacity: 0.6 }} /> supplier 약함
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full border-2" style={{ borderColor: '#065f46' }} /> 골든존 강조
        </span>
      </div>

      {/* 골든존 표 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          🏷️ 화이트라벨 골든존 (제네릭≥60% · trend≥60 · supplier 매칭)
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
              <th className="py-1 pr-2">제품</th>
              <th className="py-1 pr-2">제네릭비율</th>
              <th className="py-1 pr-2">대표 일반명</th>
              <th className="py-1 pr-2">trend</th>
              <th className="py-1 pr-2">supplier</th>
            </tr>
          </thead>
          <tbody>
            {plotted
              .filter(isGolden)
              .sort((a, b) => (b.genericRatio ?? 0) - (a.genericRatio ?? 0))
              .slice(0, 20)
              .map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-1 pr-2">
                    <Link href={`/admin/trend-radar/products/${r.id}`} className="text-blue-700 hover:underline">
                      {r.name}
                    </Link>
                    {r.brand && <span className="ml-1 text-xs text-gray-400">({r.brand})</span>}
                  </td>
                  <td className="py-1 pr-2 font-mono">{r.genericRatio != null ? Math.round(r.genericRatio * 100) + '%' : '-'}</td>
                  <td className="py-1 pr-2 text-gray-600">{r.repKeyword ?? '-'}</td>
                  <td className="py-1 pr-2 font-mono">{r.trend}</td>
                  <td className="py-1 pr-2 font-mono">{r.supplier}</td>
                </tr>
              ))}
            {plotted.filter(isGolden).length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-xs text-gray-400">
                  아직 골든존 후보 없음. alias·supplier 누적 후 자연 등장.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
