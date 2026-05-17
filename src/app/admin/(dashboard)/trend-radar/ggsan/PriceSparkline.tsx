interface Point {
  observed_at: string
  price_krw: number | null
  status: string | null
}

interface Props {
  points: Point[]
  width?: number
  height?: number
}

export default function PriceSparkline({ points, width = 120, height = 32 }: Props) {
  if (!points || points.length < 2) {
    return (
      <span className="text-[10px] text-gray-400 font-mono">이력 부족</span>
    )
  }
  const ordered = [...points].sort(
    (a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime()
  )
  const prices = ordered.map((p) => p.price_krw).filter((v): v is number => typeof v === 'number')
  if (prices.length < 2) {
    return <span className="text-[10px] text-gray-400 font-mono">가격이력 부족</span>
  }
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = Math.max(1, max - min)
  const stepX = ordered.length === 1 ? 0 : width / (ordered.length - 1)
  const pad = 2
  const coords = ordered.map((p, i) => {
    const x = i * stepX
    const v = typeof p.price_krw === 'number' ? p.price_krw : min
    const y = height - pad - ((v - min) / range) * (height - pad * 2)
    return { x, y, status: p.status }
  })
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const last = coords[coords.length - 1]
  const first = coords[0]
  const trendUp = last.y < first.y // y inverted, so lower = higher price
  const lineColor = trendUp ? '#dc2626' : '#16a34a'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
      aria-label="가격 sparkline"
    >
      <path d={path} fill="none" stroke={lineColor} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map((c, i) => {
        const isStockout = c.status === 'sold_out' || c.status === 'imminent'
        if (!isStockout) return null
        return (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={2.2}
            fill={c.status === 'sold_out' ? '#dc2626' : '#f59e0b'}
            stroke="#fff"
            strokeWidth={0.5}
          />
        )
      })}
      <circle cx={last.x} cy={last.y} r={1.8} fill={lineColor} />
    </svg>
  )
}
