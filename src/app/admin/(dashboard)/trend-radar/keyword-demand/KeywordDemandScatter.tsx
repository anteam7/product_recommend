'use client'
import { useMemo, useState } from 'react'

export interface DemandRow {
  keyword: string
  monthly_pc: number
  monthly_mobile: number
  monthly_total: number
  comp_idx: string | null
  ad_depth: number | null
  est_cpc: number | null
}

const COMP_COLOR: Record<string, string> = {
  낮음: '#10b981',
  중간: '#f59e0b',
  높음: '#ef4444',
}

// CPC 미수집 시 경쟁정도로 비용 프록시 (원)
const COMP_CPC_PROXY: Record<string, number> = { 낮음: 800, 중간: 2500, 높음: 6000 }

function costOf(r: DemandRow): number {
  if (typeof r.est_cpc === 'number' && r.est_cpc > 0) return r.est_cpc
  return COMP_CPC_PROXY[r.comp_idx ?? ''] ?? 1500
}

export default function KeywordDemandScatter({ rows }: { rows: DemandRow[] }) {
  const [hover, setHover] = useState<DemandRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 56

  const maxVol = useMemo(() => Math.max(100, ...rows.map((r) => r.monthly_total)), [rows])
  const maxCost = useMemo(() => Math.max(100, ...rows.map((r) => costOf(r))), [rows])

  // x = 비용(CPC) → 왼쪽이 저비용 / y = 검색량 → 위가 고수요
  const xScale = (cost: number) => PAD + (cost / maxCost) * (W - 2 * PAD)
  const yScale = (vol: number) => H - PAD - (vol / maxVol) * (H - 2 * PAD)

  // 좌상단 저비용·고수요 후보 = 비용 하위 40% & 수요 상위 40%
  const isPick = (r: DemandRow) => costOf(r) <= maxCost * 0.4 && r.monthly_total >= maxVol * 0.4

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 좌상단 기회 사분면 */}
          <rect
            x={PAD}
            y={PAD}
            width={xScale(maxCost * 0.4) - PAD}
            height={yScale(maxVol * 0.4) - PAD}
            fill="#f0fdf4"
          />

          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={'gx' + f}>
              <line x1={xScale(maxCost * f)} y1={PAD} x2={xScale(maxCost * f)} y2={H - PAD} stroke="#e5e7eb" />
              <text x={xScale(maxCost * f)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {Math.round((maxCost * f) / 100) / 10}k
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={'gy' + f}>
              <line x1={PAD} y1={yScale(maxVol * f)} x2={W - PAD} y2={yScale(maxVol * f)} stroke="#e5e7eb" />
              <text x={PAD - 8} y={yScale(maxVol * f) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {Math.round(maxVol * f).toLocaleString()}
              </text>
            </g>
          ))}

          <text x={W / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">
            예상 획득비용 CPC (← 저비용)
          </text>
          <text x={14} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 14 ${H / 2})`}>
            월간 검색량 (↑ 고수요)
          </text>
          <text x={xScale(maxCost * 0.2)} y={yScale(maxVol * 0.92)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 저비용·고수요 진입 키워드
          </text>

          {rows.map((r) => (
            <circle
              key={r.keyword}
              cx={xScale(costOf(r))}
              cy={yScale(r.monthly_total)}
              r={isPick(r) ? 7 : 5}
              fill={COMP_COLOR[r.comp_idx ?? ''] ?? '#6b7280'}
              fillOpacity={0.55}
              stroke={COMP_COLOR[r.comp_idx ?? ''] ?? '#6b7280'}
              strokeOpacity={0.9}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.keyword}</div>
            <div>월검색 {hover.monthly_total.toLocaleString()} (PC {hover.monthly_pc.toLocaleString()} / MO {hover.monthly_mobile.toLocaleString()})</div>
            <div>경쟁 {hover.comp_idx ?? '?'} · 광고수 {hover.ad_depth ?? '?'} · CPC {hover.est_cpc != null ? hover.est_cpc.toLocaleString() + '원' : '미수집(프록시)'}</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(COMP_COLOR).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: c, opacity: 0.6 }} />
            경쟁 {k}
          </span>
        ))}
      </div>

      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">저비용·고수요 후보 (비용 하위 40% · 수요 상위 40%)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter(isPick)
            .sort((a, b) => b.monthly_total / costOf(b) - a.monthly_total / costOf(a))
            .slice(0, 12)
            .map((r) => (
              <div key={r.keyword} className="flex justify-between px-2 py-1 rounded hover:bg-gray-50">
                <span className="font-medium">{r.keyword}</span>
                <span className="font-mono text-gray-500">
                  {r.monthly_total.toLocaleString()}검색 · {r.est_cpc != null ? r.est_cpc.toLocaleString() + '원' : r.comp_idx}
                </span>
              </div>
            ))}
          {rows.filter(isPick).length === 0 && (
            <div className="text-gray-400 text-xs">아직 후보 없음. cron 누적 후 다시 방문.</div>
          )}
        </div>
      </div>
    </div>
  )
}
