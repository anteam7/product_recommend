'use client'

interface Point {
  t: number
  v: number
}

/**
 * 미니 스파크라인 — 이전 피크(▲)·휴면 골(▽)·현재 반등(●)을 강조.
 * trend_score 시계열(0~100)을 0..W / 0..H 로 매핑.
 */
export default function ResurgenceSparkline({
  series,
  peakThreshold,
  dormantThreshold,
}: {
  series: Point[]
  peakThreshold: number
  dormantThreshold: number
}) {
  const W = 160
  const H = 36
  const PAD = 3

  if (series.length < 2) return <span className="text-xs text-gray-300">—</span>

  const n = series.length
  const xs = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD)
  const ys = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs(i).toFixed(1)} ${ys(p.v).toFixed(1)}`).join(' ')

  // 과거(현재 4점 제외) 구간에서 피크·골 인덱스
  const past = series.slice(0, Math.max(1, n - 4))
  const pastVals = past.map((p) => p.v)
  const peakV = Math.max(...pastVals)
  const peakIdx = pastVals.indexOf(peakV)
  const troughV = Math.min(...pastVals)
  const troughIdx = pastVals.indexOf(troughV)
  const lastIdx = n - 1

  // 임계선 y
  const peakLineY = ys(peakThreshold)
  const dormLineY = ys(dormantThreshold)

  return (
    <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
      {/* 임계선 */}
      <line x1={PAD} y1={peakLineY} x2={W - PAD} y2={peakLineY} stroke="#fca5a5" strokeWidth={0.5} strokeDasharray="2,2" />
      <line x1={PAD} y1={dormLineY} x2={W - PAD} y2={dormLineY} stroke="#cbd5e1" strokeWidth={0.5} strokeDasharray="2,2" />

      {/* 추이선 */}
      <path d={path} fill="none" stroke="#7c3aed" strokeWidth={1.3} strokeLinejoin="round" />

      {/* 이전 피크 ▲ */}
      <circle cx={xs(peakIdx)} cy={ys(peakV)} r={2.6} fill="#ef4444" />
      {/* 휴면 골 ▽ */}
      <circle cx={xs(troughIdx)} cy={ys(troughV)} r={2.2} fill="#94a3b8" />
      {/* 현재 반등 ● */}
      <circle cx={xs(lastIdx)} cy={ys(series[lastIdx].v)} r={3} fill="#10b981" stroke="#fff" strokeWidth={1} />
    </svg>
  )
}
