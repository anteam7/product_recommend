'use client'
import { useMemo, useState } from 'react'
import type { MoqRow } from './page'

const GATE_COLORS: Record<MoqRow['gate'], string> = {
  green: '#10b981',
  yellow: '#f59e0b',
  red: '#ef4444',
}

export default function MoqWindowScatter({ rows }: { rows: MoqRow[] }) {
  const [hover, setHover] = useState<MoqRow | null>(null)

  const W = 760
  const H = 480
  const PAD = 56

  // X 축 = 소진 주(weeks_of_supply). 0~24 주로 클램프 (그 이상은 24 에 모음).
  const xMax = 24
  const clampedX = (w: number) => Math.min(Math.max(w, 0), xMax)

  // 자본잠김 색 그라데이션은 게이트로 단순화 (요청대로 green/yellow/red).
  const xScale = (v: number) => PAD + (clampedX(v) / xMax) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.min(Math.max(v, 0), 100) / 100) * (H - 2 * PAD)
  const rScale = (capital: number) => {
    // 자본 잠김 크기. 30만 = 8, 1000만 = 16, 1억 = 28.
    const k = Math.log10(Math.max(capital, 10000))
    return Math.max(5, Math.min(28, (k - 4) * 6 + 6))
  }

  const gateBands = useMemo(
    () => [
      { from: 0, to: 4, color: '#dcfce7' },
      { from: 4, to: 12, color: '#fef3c7' },
      { from: 12, to: xMax, color: '#fee2e2' },
    ],
    [],
  )

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 게이트 배경 */}
          {gateBands.map((b) => (
            <rect
              key={b.from}
              x={xScale(b.from)}
              y={PAD}
              width={xScale(b.to) - xScale(b.from)}
              height={H - 2 * PAD}
              fill={b.color}
              fillOpacity={0.45}
            />
          ))}

          {/* grid */}
          {[0, 4, 8, 12, 16, 20, 24].map((v) => (
            <g key={'gx' + v}>
              <line
                x1={xScale(v)}
                y1={PAD}
                x2={xScale(v)}
                y2={H - PAD}
                stroke="#e5e7eb"
                strokeDasharray={v === 4 || v === 12 ? '' : '2,3'}
                strokeWidth={v === 4 || v === 12 ? 1.5 : 1}
              />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v === xMax ? `${v}+` : v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray="2,3" />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">
            MOQ 소진 예상 (주)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            final_score
          </text>

          {/* 게이트 라벨 */}
          <text x={xScale(2)} y={PAD - 6} fontSize="11" fill="#047857" fontWeight="bold" textAnchor="middle">
            🟢 회전 양호
          </text>
          <text x={xScale(8)} y={PAD - 6} fontSize="11" fill="#b45309" fontWeight="bold" textAnchor="middle">
            🟡 주의
          </text>
          <text x={xScale(18)} y={PAD - 6} fontSize="11" fill="#b91c1c" fontWeight="bold" textAnchor="middle">
            🔴 자본 잠김
          </text>

          {/* 점 */}
          {rows.map((r) => {
            const final = r.final_score == null ? 0 : Number(r.final_score)
            return (
              <a key={r.supplier_id} href={`/admin/trend-radar/products/${r.product_id}`}>
                <circle
                  cx={xScale(r.weeks_of_supply)}
                  cy={yScale(final)}
                  r={rScale(r.capital_locked_krw)}
                  fill={GATE_COLORS[r.gate]}
                  fillOpacity={0.55}
                  stroke={GATE_COLORS[r.gate]}
                  strokeOpacity={0.95}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold">{hover.canonical_name}</div>
            <div>cate: {hover.category_top} · supplier: {hover.supplier_source}</div>
            <div>
              MOQ: {hover.moq} · 단가: {hover.price_krw ?? '-'} · 자본:{' '}
              {Math.round(hover.capital_locked_krw / 10000).toLocaleString()}만
            </div>
            <div>
              주간 추정: {hover.weekly_sales_estimate.toFixed(1)} · 소진: {hover.weeks_of_supply.toFixed(1)}주
            </div>
            <div>
              final: {hover.final_score == null ? '-' : Math.round(hover.final_score)} · trend:{' '}
              {hover.trend_score == null ? '-' : Math.round(hover.trend_score)} · commerce:{' '}
              {hover.commerce_score == null ? '-' : Math.round(hover.commerce_score)}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {(Object.keys(GATE_COLORS) as MoqRow['gate'][]).map((g) => (
          <span key={g} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: GATE_COLORS[g], opacity: 0.65 }} />
            {g === 'green' ? '< 4주' : g === 'yellow' ? '4–12주' : '> 12주'}
          </span>
        ))}
        <span className="text-gray-500">· 점 크기 = 자본 잠김 추정액 (log scale)</span>
      </div>
    </div>
  )
}
