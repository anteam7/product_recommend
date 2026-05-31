// 의존성 없는 인라인 SVG 스파크라인. 통화별 환율 시계열 미니 차트.
export default function Sparkline({
  values,
  width = 64,
  height = 18,
}: {
  values: number[]
  width?: number
  height?: number
}) {
  if (!values || values.length < 2) {
    return <span className="text-[10px] text-gray-300">—</span>
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (values.length - 1)

  const points = values.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const last = values[values.length - 1]
  const first = values[0]
  const up = last >= first
  const stroke = up ? '#dc2626' : '#2563eb' // 원화 약세(상승)=빨강, 강세=파랑

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
