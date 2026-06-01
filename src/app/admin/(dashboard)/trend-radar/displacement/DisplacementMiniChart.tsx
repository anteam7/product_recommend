'use client'

interface Point {
  t: string
  v: number
}

/**
 * 떠오르는/쇠퇴하는 두 trend_score 궤적을 겹쳐 그리는 미니 라인차트 (의존성 없는 SVG).
 * rising = 초록(↗), declining = 빨강(↘).
 */
export default function DisplacementMiniChart({
  rising,
  declining,
}: {
  rising: Point[]
  declining: Point[]
}) {
  const W = 280
  const H = 96
  const PAD = 6

  const all = [...rising, ...declining]
  if (all.length === 0) {
    return <div className="text-xs text-gray-400">궤적 데이터 없음</div>
  }

  const ts = all.map((p) => new Date(p.t).getTime())
  const tMin = Math.min(...ts)
  const tMax = Math.max(...ts)
  // trend_score 는 0~100 이지만 가시성 위해 실제 범위로 스케일
  const vs = all.map((p) => p.v)
  const vMin = Math.min(...vs)
  const vMax = Math.max(...vs)
  const vSpan = vMax - vMin || 1

  const x = (t: string) =>
    PAD + ((new Date(t).getTime() - tMin) / (tMax - tMin || 1)) * (W - 2 * PAD)
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - 2 * PAD)

  const path = (pts: Point[]) =>
    pts
      .slice()
      .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ')

  return (
    <svg width={W} height={H} className="block" style={{ overflow: 'visible' }}>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e5e7eb" />
      <path d={path(declining)} fill="none" stroke="#ef4444" strokeWidth={2} />
      <path d={path(rising)} fill="none" stroke="#10b981" strokeWidth={2} />
      {rising.length > 0 && (
        <circle cx={x(rising[rising.length - 1].t)} cy={y(rising[rising.length - 1].v)} r={3} fill="#10b981" />
      )}
      {declining.length > 0 && (
        <circle
          cx={x(declining[declining.length - 1].t)}
          cy={y(declining[declining.length - 1].v)}
          r={3}
          fill="#ef4444"
        />
      )}
    </svg>
  )
}
