'use client'
import { useState } from 'react'

export interface ShareRow {
  category: string
  generic_share: number   // 0~100 (X)
  trend_velocity: number  // -100~100 (Y)
  total_volume: number
  generic_volume: number
  branded_volume: number
  keyword_count: number
  generic_keyword_count: number
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

// generic_share ≥ 60 → 위탁 충족 가능 (브랜드 지배 아님)
const GENERIC_GATE = 60

export default function GenericShareScatter({ rows }: { rows: ShareRow[] }) {
  const [hover, setHover] = useState<ShareRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 56

  // X: 0~100, Y: -100~100
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - ((v + 100) / 200) * (H - 2 * PAD)
  // 버블 크기 = 전체 수요량 (sqrt 스케일)
  const maxVol = Math.max(1, ...rows.map((r) => r.total_volume))
  const rScale = (v: number) => 8 + Math.sqrt(v / maxVol) * 34

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 골드존: generic_share≥60 + velocity>0 (우상단) */}
          <rect
            x={xScale(GENERIC_GATE)}
            y={yScale(100)}
            width={xScale(100) - xScale(GENERIC_GATE)}
            height={yScale(0) - yScale(100)}
            fill="#f0fdf4"
          />
          {/* 브랜드 지배존: generic_share<60 (좌측) — 위탁 불가, 회색 */}
          <rect x={xScale(0)} y={yScale(100)} width={xScale(GENERIC_GATE) - xScale(0)} height={yScale(-100) - yScale(100)} fill="#f9fafb" />

          {/* generic gate 선 */}
          <line x1={xScale(GENERIC_GATE)} y1={yScale(100)} x2={xScale(GENERIC_GATE)} y2={yScale(-100)} stroke="#10b981" strokeDasharray="4,4" />
          {/* velocity 0 선 */}
          <line x1={xScale(0)} y1={yScale(0)} x2={xScale(100)} y2={yScale(0)} stroke="#9ca3af" strokeDasharray="2,3" />

          {/* X grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <text key={'gx' + v} x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
              {v}
            </text>
          ))}
          {/* Y grid */}
          {[-100, -50, 0, 50, 100].map((v) => (
            <text key={'gy' + v} x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
              {v}
            </text>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            generic_share (→ 무명 수요 점유율 ↑ = 위탁 충족 가능)
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            trend_velocity (↑ 수요 상승)
          </text>

          {/* 존 라벨 */}
          <text x={xScale(80)} y={yScale(88)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🏆 위탁 골드존 (일반수요 큼 + 상승)
          </text>
          <text x={xScale(28)} y={yScale(88)} fontSize="11" fill="#9ca3af" fontWeight="bold" textAnchor="middle">
            🚫 브랜드 지배 (위탁 불가)
          </text>

          {/* 버블 */}
          {rows.map((r) => {
            const isGold = r.generic_share >= GENERIC_GATE && r.trend_velocity > 0
            const isBranded = r.generic_share < GENERIC_GATE
            const fill = isBranded ? '#9ca3af' : isGold ? '#10b981' : '#f59e0b'
            return (
              <g key={r.category}>
                <circle
                  cx={xScale(r.generic_share)}
                  cy={yScale(r.trend_velocity)}
                  r={rScale(r.total_volume)}
                  fill={fill}
                  fillOpacity={isBranded ? 0.3 : 0.55}
                  stroke={fill}
                  strokeOpacity={0.9}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
                <text
                  x={xScale(r.generic_share)}
                  y={yScale(r.trend_velocity) + 4}
                  fontSize="11"
                  fill={isBranded ? '#6b7280' : '#065f46'}
                  fontWeight="600"
                  textAnchor="middle"
                  style={{ pointerEvents: 'none' }}
                >
                  {CATEGORY_LABEL[r.category] ?? r.category}
                </text>
              </g>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{CATEGORY_LABEL[hover.category] ?? hover.category}</div>
            <div>generic_share: {hover.generic_share}% · velocity: {hover.trend_velocity}</div>
            <div>
              무명 {Math.round(hover.generic_volume)} / 전체 {Math.round(hover.total_volume)} 수요
            </div>
            <div>
              키워드 {hover.generic_keyword_count}/{hover.keyword_count} generic
            </div>
          </div>
        )}
      </div>

      {/* 표 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">카테고리별 위탁 적합도</h3>
        <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
          <div className="col-span-3">카테고리</div>
          <div className="col-span-2 text-right">generic_share</div>
          <div className="col-span-2 text-right">velocity</div>
          <div className="col-span-2 text-right">전체 수요</div>
          <div className="col-span-2 text-right">키워드</div>
          <div className="col-span-1 text-right">판정</div>
        </div>
        {rows
          .slice()
          .sort((a, b) => b.generic_volume - a.generic_volume)
          .map((r) => {
            const isGold = r.generic_share >= GENERIC_GATE && r.trend_velocity > 0
            const isBranded = r.generic_share < GENERIC_GATE
            return (
              <div key={r.category} className={`grid grid-cols-12 px-2 py-1.5 text-sm rounded ${isBranded ? 'opacity-60' : ''} hover:bg-gray-50`}>
                <div className="col-span-3 font-medium">{CATEGORY_LABEL[r.category] ?? r.category}</div>
                <div className="col-span-2 text-right font-mono font-bold">{r.generic_share}%</div>
                <div className={`col-span-2 text-right font-mono ${r.trend_velocity > 0 ? 'text-emerald-600' : 'text-gray-500'}`}>
                  {r.trend_velocity > 0 ? '+' : ''}{r.trend_velocity}
                </div>
                <div className="col-span-2 text-right font-mono text-gray-600">{Math.round(r.total_volume)}</div>
                <div className="col-span-2 text-right text-xs text-gray-500">
                  {r.generic_keyword_count}/{r.keyword_count}
                </div>
                <div className="col-span-1 text-right">
                  {isGold ? '🏆' : isBranded ? '🚫' : '⚠️'}
                </div>
              </div>
            )
          })}
        {rows.length === 0 && (
          <div className="text-gray-400 text-xs py-4 text-center">
            아직 집계 데이터 없음. 키워드 누적 + classify cron 후 등장.
          </div>
        )}
      </div>
    </div>
  )
}
