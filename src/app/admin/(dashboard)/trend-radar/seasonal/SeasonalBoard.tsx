'use client'
import { useState } from 'react'

export interface SeasonalRow {
  keyword: string
  expected: number // 계절 기대치 (100 = 연평균, >100 = 성수기)
  current: number // 현재 30일 모멘텀 (0~100)
  residual: number // current - expected
  spark: (number | null)[] // 12개월 seasonal_index
  curMonth: number
}

const MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']

/** 키워드별 12개월 seasonal_index 미니 막대 */
function MiniChart({ spark, curMonth }: { spark: (number | null)[]; curMonth: number }) {
  const vals = spark.map((v) => v ?? 0)
  const max = Math.max(100, ...vals)
  return (
    <div className="flex items-end gap-[2px] h-8" title="12개월 seasonal_index (100=연평균)">
      {vals.map((v, i) => {
        const h = Math.max(2, (v / max) * 32)
        const isCur = i + 1 === curMonth
        return (
          <div
            key={i}
            style={{ height: `${h}px` }}
            className={`w-[5px] rounded-sm ${isCur ? 'bg-rose-500' : v >= 100 ? 'bg-amber-400' : 'bg-gray-300'}`}
            title={`${MONTHS[i]}월: ${Math.round(v)}`}
          />
        )
      })}
    </div>
  )
}

export default function SeasonalBoard({ rows }: { rows: SeasonalRow[] }) {
  const [hover, setHover] = useState<SeasonalRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // X: 계절 기대치 0~200 (100 = 연평균). Y: 잔차 -100~+100.
  const xScale = (v: number) => PAD + (Math.min(200, Math.max(0, v)) / 200) * (W - 2 * PAD)
  const yScale = (v: number) => {
    const clamped = Math.min(100, Math.max(-100, v))
    return H - PAD - ((clamped + 100) / 200) * (H - 2 * PAD)
  }

  const breakouts = rows.filter((r) => r.residual >= 15).sort((a, b) => b.residual - a.residual)
  const seasonalConstants = rows
    .filter((r) => r.expected >= 120 && r.residual < 15)
    .sort((a, b) => b.expected - a.expected)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우상단/상단 = 진짜 브레이크아웃(잔차 양수) 배경 */}
          <rect
            x={PAD}
            y={yScale(100)}
            width={W - 2 * PAD}
            height={yScale(15) - yScale(100)}
            fill="#f0fdf4"
          />
          {/* 우하단 = 계절 상수(기대 높고 잔차 낮음) — 디스카운트 */}
          <rect
            x={xScale(120)}
            y={yScale(15)}
            width={xScale(200) - xScale(120)}
            height={yScale(-100) - yScale(15)}
            fill="#fef2f2"
          />

          {/* grid X */}
          {[0, 50, 100, 150, 200].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v === 100 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {/* grid Y */}
          {[-100, -50, 0, 50, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            계절 기대치 (100 = 연평균, → 성수기)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            잔차 (↑ 달력 너머 신규 수요)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(40)} y={yScale(80)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🚀 진짜 브레이크아웃
          </text>
          <text x={xScale(165)} y={yScale(-70)} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            📅 계절 상수 (디스카운트)
          </text>

          {/* 점들 */}
          {rows.map((r) => {
            const color = r.residual >= 15 ? '#10b981' : r.expected >= 120 ? '#ef4444' : '#9ca3af'
            return (
              <circle
                key={r.keyword}
                cx={xScale(r.expected)}
                cy={yScale(r.residual)}
                r={6}
                fill={color}
                fillOpacity={0.55}
                stroke={color}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-1">
            <div className="font-semibold">{hover.keyword}</div>
            <div>
              기대 {hover.expected} · 현재 {hover.current} · 잔차{' '}
              <b className={hover.residual >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {hover.residual >= 0 ? '+' : ''}
                {hover.residual}
              </b>
            </div>
            <MiniChart spark={hover.spark} curMonth={hover.curMonth} />
          </div>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* 진짜 브레이크아웃 */}
        <div className="border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold mb-2 text-emerald-700">
            🚀 진짜 브레이크아웃 (잔차 ≥ 15)
          </h3>
          <div className="space-y-2 text-sm">
            {breakouts.slice(0, 12).map((r) => (
              <div key={r.keyword} className="flex items-center justify-between gap-3 px-2 py-1 rounded hover:bg-gray-50">
                <span className="truncate">
                  <span className="font-mono text-emerald-600 mr-2">+{r.residual}</span>
                  {r.keyword}
                </span>
                <MiniChart spark={r.spark} curMonth={r.curMonth} />
              </div>
            ))}
            {breakouts.length === 0 && (
              <div className="text-gray-400 text-xs">아직 잔차 큰 키워드 없음.</div>
            )}
          </div>
        </div>

        {/* 계절 상수 — 디스카운트 */}
        <div className="border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold mb-2 text-rose-700">
            📅 계절 상수 — 디스카운트 (기대 ≥ 120 · 잔차 &lt; 15)
          </h3>
          <div className="space-y-2 text-sm">
            {seasonalConstants.slice(0, 12).map((r) => (
              <div key={r.keyword} className="flex items-center justify-between gap-3 px-2 py-1 rounded hover:bg-gray-50">
                <span className="truncate">
                  <span className="font-mono text-rose-500 mr-2">{r.expected}</span>
                  {r.keyword}
                </span>
                <MiniChart spark={r.spark} curMonth={r.curMonth} />
              </div>
            ))}
            {seasonalConstants.length === 0 && (
              <div className="text-gray-400 text-xs">계절 상수로 분류된 키워드 없음.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
