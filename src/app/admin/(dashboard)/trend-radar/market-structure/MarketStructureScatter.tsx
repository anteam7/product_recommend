'use client'
import { useMemo, useState } from 'react'
import type { CategoryStructureRow, DrilldownItem } from './page'

// HHI 해석 기준 (미국 DOJ 가이드라인 차용)
// < 1500 비집중(파편화) · 1500~2500 중간 · > 2500 고집중(독과점)
const HHI_FRAGMENTED = 1500
const HHI_CONCENTRATED = 2500

function momentumColor(m: number): string {
  if (m >= 5) return '#10b981'   // 강한 상승
  if (m > 0) return '#84cc16'    // 약상승
  if (m === 0) return '#9ca3af'  // 보합
  if (m > -5) return '#f59e0b'   // 약하락
  return '#ef4444'               // 강하락
}

export default function MarketStructureScatter({
  rows,
  drill,
}: {
  rows: CategoryStructureRow[]
  drill: Record<string, DrilldownItem[]>
}) {
  const [hover, setHover] = useState<CategoryStructureRow | null>(null)
  const [selected, setSelected] = useState<CategoryStructureRow | null>(null)

  const W = 720
  const H = 480
  const PAD = 60

  const maxDemand = useMemo(
    () => Math.max(100, ...rows.map((r) => r.demand_total)),
    [rows],
  )
  const maxCount = useMemo(
    () => Math.max(1, ...rows.map((r) => r.product_count)),
    [rows],
  )

  // x: 수요규모 0~max → 왼쪽~오른쪽
  const xScale = (v: number) => PAD + (v / maxDemand) * (W - 2 * PAD)
  // y: HHI 0~10000 → 위(파편화, 낮은 HHI)~아래(독점, 높은 HHI)
  const yScale = (hhi: number) => PAD + (Math.min(hhi, 10000) / 10000) * (H - 2 * PAD)
  const rScale = (count: number) => 6 + (count / maxCount) * 22

  // 진입 용이존 경계 (수요 상위 절반 + 파편화)
  const demandMid = maxDemand / 2

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 진입 용이존: x > demandMid AND HHI < HHI_FRAGMENTED (좌표상 우상단) */}
          <rect
            x={xScale(demandMid)}
            y={PAD}
            width={xScale(maxDemand) - xScale(demandMid)}
            height={yScale(HHI_FRAGMENTED) - PAD}
            fill="#f0fdf4"
          />

          {/* HHI 임계선 (가로) */}
          <line x1={PAD} y1={yScale(HHI_FRAGMENTED)} x2={W - PAD} y2={yScale(HHI_FRAGMENTED)} stroke="#86efac" strokeDasharray="4,3" />
          <text x={W - PAD} y={yScale(HHI_FRAGMENTED) - 4} fontSize="9" fill="#16a34a" textAnchor="end">
            HHI {HHI_FRAGMENTED} (파편화 경계)
          </text>
          <line x1={PAD} y1={yScale(HHI_CONCENTRATED)} x2={W - PAD} y2={yScale(HHI_CONCENTRATED)} stroke="#fca5a5" strokeDasharray="4,3" />
          <text x={W - PAD} y={yScale(HHI_CONCENTRATED) - 4} fontSize="9" fill="#dc2626" textAnchor="end">
            HHI {HHI_CONCENTRATED} (독과점 경계)
          </text>

          {/* y grid (HHI) */}
          {[0, 2500, 5000, 7500, 10000].map((v) => (
            <g key={'gy' + v}>
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 12} fontSize="11" fill="#6b7280" textAnchor="middle">
            카테고리 수요규모 (→ 큰 시장)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            HHI (↑ 파편화 · ↓ 독점)
          </text>

          {/* 용이존 라벨 */}
          <text x={(xScale(demandMid) + xScale(maxDemand)) / 2} y={PAD + 14} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 진입 용이존 (대수요·파편화)
          </text>

          {/* 버블 */}
          {rows.map((r) => {
            const cx = xScale(r.demand_total)
            const cy = yScale(r.hhi)
            const color = momentumColor(r.trend_momentum)
            const isSel = selected?.category_mid === r.category_mid
            return (
              <g key={r.category_mid} style={{ cursor: 'pointer' }}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={rScale(r.product_count)}
                  fill={color}
                  fillOpacity={isSel ? 0.85 : 0.5}
                  stroke={color}
                  strokeWidth={isSel ? 3 : 1}
                  strokeOpacity={0.95}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setSelected(isSel ? null : r)}
                />
                <text x={cx} y={cy - rScale(r.product_count) - 3} fontSize="9" fill="#374151" textAnchor="middle">
                  {r.category_mid}
                </text>
              </g>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.category_mid} <span className="text-gray-300">({hover.category_top})</span></div>
            <div>수요총량: {hover.demand_total} · 상품수: {hover.product_count}</div>
            <div>HHI: {hover.hhi} · CR3: {hover.cr3}% · 모멘텀 Δ: {hover.trend_momentum}</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: momentumColor(6) }} /> 모멘텀 ↑↑</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: momentumColor(1) }} /> 약상승</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: momentumColor(0) }} /> 보합</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: momentumColor(-1) }} /> 약하락</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: momentumColor(-6) }} /> 하락</span>
        <span className="text-gray-400">· 버블 크기 = 상품수</span>
      </div>

      {/* 진입 용이존 카테고리 랭킹 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">진입 용이 카테고리 (대수요 + 저HHI)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-1 pr-3">카테고리</th>
                <th className="py-1 pr-3 text-right">수요총량</th>
                <th className="py-1 pr-3 text-right">HHI</th>
                <th className="py-1 pr-3 text-right">CR3</th>
                <th className="py-1 pr-3 text-right">상품수</th>
                <th className="py-1 pr-3 text-right">모멘텀</th>
                <th className="py-1 pr-3">구조</th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                .sort((a, b) => a.hhi - b.hhi || b.demand_total - a.demand_total)
                .map((r) => {
                  const struct =
                    r.hhi < HHI_FRAGMENTED ? { t: '파편화', c: 'text-green-600' }
                    : r.hhi < HHI_CONCENTRATED ? { t: '중간', c: 'text-gray-500' }
                    : { t: '독과점', c: 'text-red-600' }
                  const isSel = selected?.category_mid === r.category_mid
                  return (
                    <tr
                      key={r.category_mid}
                      className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${isSel ? 'bg-emerald-50' : ''}`}
                      onClick={() => setSelected(isSel ? null : r)}
                    >
                      <td className="py-1 pr-3 font-medium">{r.category_mid}</td>
                      <td className="py-1 pr-3 text-right font-mono">{r.demand_total}</td>
                      <td className="py-1 pr-3 text-right font-mono">{r.hhi}</td>
                      <td className="py-1 pr-3 text-right font-mono">{r.cr3}%</td>
                      <td className="py-1 pr-3 text-right font-mono">{r.product_count}</td>
                      <td className={`py-1 pr-3 text-right font-mono ${r.trend_momentum > 0 ? 'text-green-600' : r.trend_momentum < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {r.trend_momentum > 0 ? '+' : ''}{r.trend_momentum}
                      </td>
                      <td className={`py-1 pr-3 ${struct.c}`}>{struct.t}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 드릴다운: 선택 카테고리 구성 상품 점유율 */}
      {selected && (
        <div className="mt-6 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold mb-3">
            {selected.category_mid} — 구성 상품 점유율 (HHI {selected.hhi} · CR3 {selected.cr3}%)
          </h3>
          {(drill[selected.category_mid] ?? []).length === 0 ? (
            <div className="text-gray-400 text-xs">드릴다운 데이터 없음.</div>
          ) : (
            <div className="space-y-1.5">
              {(drill[selected.category_mid] ?? []).map((it, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <div className="w-40 truncate text-gray-700" title={it.name}>{it.name}</div>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                    <div
                      className="h-full bg-emerald-400"
                      style={{ width: `${Math.max(2, it.share)}%` }}
                    />
                  </div>
                  <div className="w-12 text-right font-mono text-gray-500">{it.share.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
