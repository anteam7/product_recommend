'use client'
import { useState } from 'react'

export interface RampRow {
  category: string
  weeks: string[]
  transSeries: number[] // transactional_share %, 주별
  infoSeries: number[] // informational_share %, 주별
  transSlope: number // %/주 (최소제곱)
  latestTrans: number // 최신주 transactional %
  latestInfo: number // 최신주 informational %
  avgVolume: number
  sampleCount: number
}

const CAT_COLOR: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  food: '#ef4444',
  other: '#6b7280',
}
const color = (c: string) => CAT_COLOR[c] ?? '#6b7280'

// 작은 스파크라인 (transactional_share 추세).
function Spark({ series, stroke }: { series: number[]; stroke: string }) {
  const W = 96
  const H = 28
  if (series.length < 2) {
    return <div className="text-[10px] text-gray-400">데이터 부족</div>
  }
  const max = Math.max(...series, 1)
  const min = Math.min(...series, 0)
  const span = max - min || 1
  const pts = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * W
      const y = H - ((v - min) / span) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const lastX = W
  const lastY = H - ((series[series.length - 1] - min) / span) * H
  return (
    <svg width={W} height={H} className="block">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} />
      <circle cx={lastX} cy={lastY} r={2.5} fill={stroke} />
    </svg>
  )
}

export default function IntentRampBoard({ rows }: { rows: RampRow[]; weeks: string[] }) {
  const [hover, setHover] = useState<RampRow | null>(null)

  // 사분면: X = 최신 transactional 비중(성숙도), Y = transactional 기울기(가속도).
  const W = 720
  const H = 460
  const PAD = 50
  const maxSlope = Math.max(1, ...rows.map((r) => Math.abs(r.transSlope)))
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD) // 0~100%
  const yScale = (v: number) => H / 2 - (v / maxSlope) * (H / 2 - PAD) // -maxSlope~+maxSlope, 0 중앙
  const rScale = (v: number) => Math.max(5, Math.sqrt(Math.max(v, 1) / Math.PI) * 2)

  // '지금 진입' 큐: 전환 가속(기울기>0) + 어느정도 성숙(최신 transactional≥25%).
  const enterQueue = rows
    .filter((r) => r.transSlope > 0.3 && r.latestTrans >= 25)
    .sort((a, b) => b.transSlope - a.transSlope)

  return (
    <div className="space-y-6">
      <div className="rounded border border-gray-200 p-4">
        <div className="relative">
          <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
            {/* 우상단 = 성숙+가속 = 진입 */}
            <rect
              x={xScale(50)}
              y={PAD}
              width={xScale(100) - xScale(50)}
              height={H / 2 - PAD}
              fill="#f0fdf4"
            />
            {/* 중앙 0 기울기 라인 */}
            <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="#d1d5db" />
            <line x1={xScale(50)} y1={PAD} x2={xScale(50)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray="2,3" />

            {/* x grid */}
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={'x' + v}>
                <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                  {v}%
                </text>
              </g>
            ))}

            {/* 축 라벨 */}
            <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
              최신 transactional 비중 (→ 구매의도 성숙)
            </text>
            <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
              transactional Δ/주 (↑ 전환 가속)
            </text>
            <text x={xScale(75)} y={PAD - 8} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
              🚀 지금 진입 (성숙↑·가속↑)
            </text>

            {rows.map((r) => (
              <g key={r.category}>
                <circle
                  cx={xScale(r.latestTrans)}
                  cy={yScale(r.transSlope)}
                  r={rScale(r.avgVolume)}
                  fill={color(r.category)}
                  fillOpacity={0.55}
                  stroke={color(r.category)}
                  strokeOpacity={0.9}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
                <text
                  x={xScale(r.latestTrans)}
                  y={yScale(r.transSlope) - rScale(r.avgVolume) - 3}
                  fontSize="10"
                  fill="#374151"
                  textAnchor="middle"
                >
                  {r.category}
                </text>
              </g>
            ))}
          </svg>

          {hover && (
            <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
              <div className="font-semibold">{hover.category}</div>
              <div>transactional: {hover.latestTrans}% (Δ {hover.transSlope > 0 ? '+' : ''}{hover.transSlope}/주)</div>
              <div>informational: {hover.latestInfo}%</div>
              <div>avg volume: {hover.avgVolume} · 표본 {hover.sampleCount}</div>
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-xs">
          {Object.entries(CAT_COLOR).map(([cat, c]) => (
            <span key={cat} className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: c, opacity: 0.6 }} />
              {cat}
            </span>
          ))}
        </div>
      </div>

      {/* 지금 진입 큐 */}
      <div className="rounded border border-gray-200 p-4">
        <h3 className="text-sm font-semibold mb-3">🚀 지금 진입 큐 (전환 가속 + 성숙 ≥25%)</h3>
        {enterQueue.length === 0 ? (
          <div className="text-gray-400 text-xs">아직 전환 가속 중인 카테고리 없음. 주 단위 누적 후 등장.</div>
        ) : (
          <div className="space-y-2">
            {enterQueue.map((r) => (
              <div key={r.category} className="flex items-center gap-3 text-sm">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: color(r.category) }}
                />
                <span className="font-medium w-20">{r.category}</span>
                <Spark series={r.transSeries} stroke={color(r.category)} />
                <span className="font-mono text-xs text-emerald-600">+{r.transSlope}/주</span>
                <span className="text-xs text-gray-500">{r.latestTrans}% transactional</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 전체 추세 테이블 */}
      <div className="rounded border border-gray-200 p-4">
        <h3 className="text-sm font-semibold mb-3">카테고리별 인텐트 추세</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-1 pr-2">카테고리</th>
              <th className="py-1 pr-2">transactional 추세</th>
              <th className="py-1 pr-2">Δ/주</th>
              <th className="py-1 pr-2">최신 transactional</th>
              <th className="py-1 pr-2">최신 informational</th>
              <th className="py-1 pr-2">표본</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category} className="border-b border-gray-100">
                <td className="py-1.5 pr-2 font-medium">{r.category}</td>
                <td className="py-1.5 pr-2">
                  <Spark series={r.transSeries} stroke={color(r.category)} />
                </td>
                <td className={`py-1.5 pr-2 font-mono ${r.transSlope > 0 ? 'text-emerald-600' : r.transSlope < 0 ? 'text-red-500' : 'text-gray-400'}`}>
                  {r.transSlope > 0 ? '+' : ''}{r.transSlope}
                </td>
                <td className="py-1.5 pr-2">{r.latestTrans}%</td>
                <td className="py-1.5 pr-2 text-gray-500">{r.latestInfo}%</td>
                <td className="py-1.5 pr-2 text-gray-400">{r.sampleCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
