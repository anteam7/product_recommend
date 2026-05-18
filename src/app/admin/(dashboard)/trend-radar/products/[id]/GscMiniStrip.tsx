'use client'

interface Row {
  date: string
  clicks: number
  impressions: number
  position: number
}

export default function GscMiniStrip({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null

  const W = 720
  const H = 120
  const PAD_L = 30
  const PAD_R = 10
  const PAD_T = 10
  const PAD_B = 22
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const maxImpr = Math.max(...rows.map((r) => r.impressions), 1)
  const positions = rows.map((r) => r.position).filter((p) => p > 0)
  const minPos = positions.length ? Math.min(...positions) : 1
  const maxPos = positions.length ? Math.max(...positions) : 100

  const xFor = (i: number) =>
    PAD_L + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW)
  const yImpr = (v: number) => PAD_T + innerH - (v / maxImpr) * innerH
  // position: 낮을수록 좋음 → 위로 가게 반전. minPos → top, maxPos → bottom
  const yPos = (v: number) => {
    if (maxPos <= minPos) return PAD_T + innerH / 2
    return PAD_T + ((v - minPos) / (maxPos - minPos)) * innerH
  }

  const impressionsPath = rows
    .map((r, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yImpr(r.impressions)}`)
    .join(' ')

  const positionPath = rows
    .filter((r) => r.position > 0)
    .map((r, i, arr) => {
      const idx = rows.indexOf(r)
      return `${i === 0 ? 'M' : 'L'} ${xFor(idx)} ${yPos(r.position)}`
    })
    .join(' ')

  return (
    <svg width={W} height={H} className="block" style={{ overflow: 'visible' }}>
      {/* 노출량 bars */}
      {rows.map((r, i) => {
        const barW = innerW / rows.length - 1
        return (
          <rect
            key={'b' + i}
            x={xFor(i) - barW / 2}
            y={yImpr(r.impressions)}
            width={Math.max(1, barW)}
            height={PAD_T + innerH - yImpr(r.impressions)}
            fill="#3b82f6"
            fillOpacity={0.18}
          />
        )
      })}

      {/* 노출 라인 */}
      <path d={impressionsPath} fill="none" stroke="#3b82f6" strokeWidth={1.5} />

      {/* position 라인 (오렌지) */}
      {positions.length > 0 && (
        <path d={positionPath} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3,2" />
      )}

      {/* X 라벨: 시작/끝 */}
      <text x={PAD_L} y={H - 6} fontSize="9" fill="#9ca3af">
        {rows[0]?.date.slice(5)}
      </text>
      <text x={W - PAD_R} y={H - 6} fontSize="9" fill="#9ca3af" textAnchor="end">
        {rows[rows.length - 1]?.date.slice(5)}
      </text>

      {/* 범례 */}
      <g transform={`translate(${PAD_L}, ${PAD_T - 2})`}>
        <rect x={0} y={-8} width={10} height={6} fill="#3b82f6" fillOpacity={0.5} />
        <text x={14} y={-2} fontSize="9" fill="#6b7280">
          노출
        </text>
        <line x1={50} y1={-5} x2={62} y2={-5} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3,2" />
        <text x={66} y={-2} fontSize="9" fill="#6b7280">
          position (↑ 좋음)
        </text>
      </g>
    </svg>
  )
}
