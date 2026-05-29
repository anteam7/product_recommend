'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface CellRow {
  category_top: string
  keyword_count: number
  total_volume: number
  hhi: number
  effective_keywords: number
  top1_share_pct: number
  top3_share_pct: number
  hhi_delta: number | null
  demand_momentum: number | null
}

// 저집중(좌) × 성장(상) = 1인 위탁 셀러의 진입 사냥터
function quadrant(hhi: number, mom: number, midHHI: number): string {
  const lowConc = hhi <= midHHI
  const growing = mom > 0
  if (lowConc && growing) return 'hunt'      // 🎯 진입 사냥터
  if (lowConc && !growing) return 'open'     // 개방·정체
  if (!lowConc && growing) return 'giant'    // 거인 성장 (정면승부)
  return 'locked'                            // 거인 고착
}

const QUAD_COLOR: Record<string, string> = {
  hunt: '#10b981',
  open: '#94a3b8',
  giant: '#ef4444',
  locked: '#6b7280',
}

export default function ConcentrationScatter({ rows }: { rows: CellRow[] }) {
  const [hover, setHover] = useState<CellRow | null>(null)
  const W = 760
  const H = 500
  const PAD = 56

  const withMom = rows.filter((r) => r.demand_momentum != null)
  const maxHHI = Math.max(0.05, ...rows.map((r) => r.hhi))
  const moms = withMom.map((r) => r.demand_momentum as number)
  const maxMom = Math.max(0.2, ...moms.map((m) => Math.abs(m)))
  const midHHI = maxHHI / 2

  // X = HHI (왼쪽 = 저집중 = 개방), Y = demand momentum (위 = 성장)
  const xScale = (v: number) => PAD + (v / maxHHI) * (W - 2 * PAD)
  const yScale = (v: number) => H / 2 - (v / maxMom) * (H / 2 - PAD)
  const rScale = (vol: number) => {
    const max = Math.max(1, ...rows.map((r) => r.total_volume))
    return 6 + Math.sqrt(vol / max) * 26
  }

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경: 좌상단(저집중×성장) = 사냥터 강조 */}
          <rect x={PAD} y={PAD} width={xScale(midHHI) - PAD} height={H / 2 - PAD} fill="#f0fdf4" />
          <rect x={xScale(midHHI)} y={PAD} width={W - PAD - xScale(midHHI)} height={H / 2 - PAD} fill="#fef2f2" fillOpacity={0.6} />

          {/* 중앙 십자 */}
          <line x1={xScale(midHHI)} y1={PAD} x2={xScale(midHHI)} y2={H - PAD} stroke="#cbd5e1" strokeDasharray="4,4" />
          <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="#cbd5e1" strokeDasharray="4,4" />

          {/* 축 */}
          <text x={W / 2} y={H - 12} fontSize="11" fill="#6b7280" textAnchor="middle">
            HHI 집중도 (← 저집중·개방 · 고집중·거인 →)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            수요 모멘텀 (↑ 성장 · 하락 ↓)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(midHHI / 2)} y={PAD + 14} fontSize="12" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 진입 사냥터 (저집중 × 성장)
          </text>
          <text x={xScale(midHHI + maxHHI / 4)} y={PAD + 14} fontSize="11" fill="#ef4444" textAnchor="middle">
            ⚠️ 거인 성장 (정면승부)
          </text>

          {/* 점 */}
          {withMom.map((r) => {
            const q = quadrant(r.hhi, r.demand_momentum as number, midHHI)
            const cx = xScale(r.hhi)
            const cy = yScale(r.demand_momentum as number)
            return (
              <a key={r.category_top} href={`/admin/trend-radar/concentration?cat=${encodeURIComponent(r.category_top)}`}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={rScale(r.total_volume)}
                  fill={QUAD_COLOR[q]}
                  fillOpacity={0.5}
                  stroke={QUAD_COLOR[q]}
                  strokeOpacity={0.9}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
                <text x={cx} y={cy - rScale(r.total_volume) - 3} fontSize="9" fill="#374151" textAnchor="middle">
                  {r.category_top}
                </text>
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.category_top}</div>
            <div>HHI: {hover.hhi.toFixed(3)} · 유효키워드: {hover.effective_keywords.toFixed(1)}</div>
            <div>top1: {hover.top1_share_pct}% · top3: {hover.top3_share_pct}%</div>
            <div>
              모멘텀: {hover.demand_momentum != null ? `${(hover.demand_momentum * 100).toFixed(1)}%` : 'N/A'}
              {' · '}HHIΔ: {hover.hhi_delta != null ? hover.hhi_delta.toFixed(3) : 'N/A'}
            </div>
            <div className="text-gray-300 mt-1">클릭 → 롱테일 소싱 후보</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: QUAD_COLOR.hunt, opacity: 0.6 }} />진입 사냥터</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: QUAD_COLOR.giant, opacity: 0.6 }} />거인 성장</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: QUAD_COLOR.open, opacity: 0.6 }} />개방·정체</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-full" style={{ background: QUAD_COLOR.locked, opacity: 0.6 }} />거인 고착</span>
        <span className="text-gray-400 ml-2">크기 = 카테고리 총수요</span>
      </div>

      {/* 사냥터 카테고리 우선 리스트 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">🎯 진입 사냥터 (저집중 × 성장) 우선순위</h3>
        <div className="space-y-1 text-sm">
          {withMom
            .filter((r) => quadrant(r.hhi, r.demand_momentum as number, midHHI) === 'hunt')
            .sort((a, b) => (b.demand_momentum as number) - (a.demand_momentum as number))
            .slice(0, 12)
            .map((r) => (
              <Link
                key={r.category_top}
                href={`/admin/trend-radar/concentration?cat=${encodeURIComponent(r.category_top)}`}
                className="flex items-center justify-between px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="font-medium">{r.category_top}</span>
                <span className="text-xs text-gray-500 font-mono">
                  HHI {r.hhi.toFixed(3)} · 유효 {r.effective_keywords.toFixed(1)}개 · 모멘텀 +{((r.demand_momentum as number) * 100).toFixed(0)}%
                </span>
              </Link>
            ))}
          {withMom.filter((r) => quadrant(r.hhi, r.demand_momentum as number, midHHI) === 'hunt').length === 0 && (
            <div className="text-gray-400 text-xs">아직 사냥터 셀 없음. 직전 30일 대비 표본이 쌓이면 모멘텀이 계산됩니다.</div>
          )}
        </div>
      </div>
    </div>
  )
}
