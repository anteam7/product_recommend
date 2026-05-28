'use client'
import { useState } from 'react'

interface Row {
  scope_kind: string
  scope_value: string
  openness_index: number
  candidate_sku_count: number | null
  verdict: string
  avg_days_to_promote: number | null
  newcomer_rate: number
  turnover_ratio: number
}

export default function OpennessScatter({
  rows,
  verdictColor,
}: {
  rows: Row[]
  verdictColor: Record<string, string>
}) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 720
  const H = 480
  const PAD = 56

  const maxSku = Math.max(10, ...rows.map((r) => r.candidate_sku_count ?? 0))
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / maxSku) * (H - 2 * PAD)
  const rScale = (r: Row) => {
    const days = r.avg_days_to_promote ?? 60
    return Math.max(5, Math.min(22, (90 - days) / 4))
  }

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 (우상단 = openness↑ × SKU 후보 많음) */}
          <rect
            x={xScale(70)}
            y={yScale(maxSku)}
            width={xScale(100) - xScale(70)}
            height={yScale(maxSku * 0.5) - yScale(maxSku)}
            fill="#ecfdf5"
          />
          {/* 좌측 봉쇄 영역 */}
          <rect
            x={xScale(0)}
            y={yScale(maxSku)}
            width={xScale(30) - xScale(0)}
            height={H - 2 * PAD}
            fill="#fef2f2"
          />

          {/* grid */}
          {[0, 30, 50, 70, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v === 30 || v === 70 ? '4,3' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((p) => {
            const v = Math.round(maxSku * p)
            return (
              <g key={'gy' + v}>
                <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray="2,3" />
                <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {v}
                </text>
              </g>
            )
          })}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            Openness Index (→ 신규 진입 빠름·개방)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            발행 후보 SKU 수 (↑ 풀 큼)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(85)} y={yScale(maxSku * 0.95)} fontSize="11" fill="#059669" fontWeight="bold" textAnchor="middle">
            🚀 진입 추천
          </text>
          <text x={xScale(15)} y={yScale(maxSku * 0.05)} fontSize="11" fill="#dc2626" fontWeight="bold" textAnchor="middle">
            🚫 봉쇄 경고
          </text>

          {/* 점 */}
          {rows.map((r) => (
            <circle
              key={`${r.scope_kind}|${r.scope_value}`}
              cx={xScale(Number(r.openness_index))}
              cy={yScale(r.candidate_sku_count ?? 0)}
              r={rScale(r)}
              fill={verdictColor[r.verdict] ?? '#6b7280'}
              fillOpacity={0.55}
              stroke={verdictColor[r.verdict] ?? '#6b7280'}
              strokeOpacity={0.9}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold">{hover.scope_kind}/{hover.scope_value}</div>
            <div>Openness: <span className="font-mono">{Number(hover.openness_index).toFixed(1)}</span> · {hover.verdict}</div>
            <div>신규 출현율: {(Number(hover.newcomer_rate) * 100).toFixed(0)}%</div>
            <div>평균 days→TOP10: {hover.avg_days_to_promote != null ? `${Number(hover.avg_days_to_promote).toFixed(0)}일` : '—'}</div>
            <div>Turnover: {(Number(hover.turnover_ratio) * 100).toFixed(0)}%</div>
            <div>SKU 후보: {hover.candidate_sku_count ?? '—'}</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(verdictColor).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: c, opacity: 0.6 }} />
            {k}
          </span>
        ))}
        <span className="ml-auto text-gray-400">⚪ 크기 = 부상 속도 (큰 점 = 빠르게 TOP-10 도달)</span>
      </div>
    </div>
  )
}
