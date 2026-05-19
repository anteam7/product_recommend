'use client'

interface Point {
  day: string
  ratio: number | null
}

interface Props {
  points: Point[]
  width?: number
  height?: number
}

export default function Sparkline({ points, width = 200, height = 48 }: Props) {
  const vals = points.map((p) => p.ratio).filter((r): r is number => r !== null)
  if (vals.length < 2) {
    return (
      <svg width={width} height={height} className="block">
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="10" fill="#9ca3af">
          데이터 부족
        </text>
      </svg>
    )
  }

  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1

  const pad = 4
  const stepX = (width - pad * 2) / Math.max(points.length - 1, 1)

  let i = 0
  const segments: string[] = []
  let pen = false
  points.forEach((p) => {
    const x = pad + i * stepX
    if (p.ratio == null) {
      pen = false
    } else {
      const y = height - pad - ((p.ratio - min) / range) * (height - pad * 2)
      segments.push(`${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
      pen = true
    }
    i++
  })
  const d = segments.join(' ')

  const first = vals[0]
  const last = vals[vals.length - 1]
  const trendColor = last < first ? '#dc2626' : last > first ? '#16a34a' : '#6b7280'

  return (
    <svg width={width} height={height} className="block">
      <path d={d} fill="none" stroke={trendColor} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}
