'use client'

// 24시간 라디얼 히트맵 — 0시(상단)부터 시계방향. 야간(21-02)은 보라 강조.
export function RadialClock({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours)
  const cx = 70
  const cy = 70
  const rIn = 22
  const rOut = 60
  const NIGHT = new Set([21, 22, 23, 0, 1, 2])

  return (
    <svg width={140} height={140} viewBox="0 0 140 140" className="shrink-0">
      {hours.map((v, h) => {
        const a0 = (h / 24) * 2 * Math.PI - Math.PI / 2 - Math.PI / 24
        const a1 = (h / 24) * 2 * Math.PI - Math.PI / 2 + Math.PI / 24
        const t = v / max
        const r = rIn + (rOut - rIn) * Math.sqrt(t)
        const x0 = cx + rIn * Math.cos(a0)
        const y0 = cy + rIn * Math.sin(a0)
        const x1 = cx + r * Math.cos(a0)
        const y1 = cy + r * Math.sin(a0)
        const x2 = cx + r * Math.cos(a1)
        const y2 = cy + r * Math.sin(a1)
        const x3 = cx + rIn * Math.cos(a1)
        const y3 = cy + rIn * Math.sin(a1)
        const fill = NIGHT.has(h) ? '#7c3aed' : '#2563eb'
        return (
          <path
            key={h}
            d={`M ${x0} ${y0} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} L ${x3} ${y3} A ${rIn} ${rIn} 0 0 0 ${x0} ${y0} Z`}
            fill={fill}
            opacity={v === 0 ? 0.06 : 0.25 + 0.7 * t}
          />
        )
      })}
      <circle cx={cx} cy={cy} r={rIn - 2} fill="white" stroke="#e5e7eb" />
      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-gray-400 text-[8px]">
        0시
      </text>
      <text x={cx} y={cy + 6} textAnchor="middle" className="fill-gray-300 text-[7px]">
        KST
      </text>
    </svg>
  )
}

const DOW = ['일', '월', '화', '수', '목', '금', '토']

export function DowBars({ dow }: { dow: number[] }) {
  const max = Math.max(1, ...dow)
  return (
    <div className="flex items-end gap-1 h-[60px]">
      {dow.map((v, i) => {
        const weekend = i === 0 || i === 6
        return (
          <div key={i} className="flex flex-col items-center justify-end gap-0.5">
            <div
              className={`w-4 rounded-sm ${weekend ? 'bg-violet-500' : 'bg-blue-500'}`}
              style={{ height: `${Math.max(2, (v / max) * 48)}px`, opacity: v === 0 ? 0.15 : 0.85 }}
            />
            <span className={`text-[9px] ${weekend ? 'text-violet-600' : 'text-gray-400'}`}>{DOW[i]}</span>
          </div>
        )
      })}
    </div>
  )
}
