'use client'

interface Point {
  t: string // ISO timestamp
  v: number
}

export default function ScissorsChart({
  priceSeries,
  demandSeries,
  productName,
}: {
  priceSeries: Point[]
  demandSeries: Point[]
  productName: string
}) {
  const W = 640
  const H = 360
  const PAD_L = 56 // 좌축 (도매가)
  const PAD_R = 56 // 우축 (수요)
  const PAD_T = 24
  const PAD_B = 40

  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B

  // 시간 축 범위 (두 시계열 합집합)
  const allT = [...priceSeries, ...demandSeries].map((p) => new Date(p.t).getTime())
  const tMin = allT.length ? Math.min(...allT) : 0
  const tMax = allT.length ? Math.max(...allT) : 1
  const tSpan = tMax - tMin || 1
  const xScale = (iso: string) => PAD_L + ((new Date(iso).getTime() - tMin) / tSpan) * plotW

  // 좌축 = 도매가
  const pVals = priceSeries.map((p) => p.v)
  const pMin = pVals.length ? Math.min(...pVals) : 0
  const pMax = pVals.length ? Math.max(...pVals) : 1
  const pSpan = pMax - pMin || 1
  const pY = (v: number) => PAD_T + plotH - ((v - pMin) / pSpan) * plotH

  // 우축 = 수요지수 (final_score)
  const dVals = demandSeries.map((p) => p.v)
  const dMin = dVals.length ? Math.min(...dVals) : 0
  const dMax = dVals.length ? Math.max(...dVals) : 1
  const dSpan = dMax - dMin || 1
  const dY = (v: number) => PAD_T + plotH - ((v - dMin) / dSpan) * plotH

  const priceLine = priceSeries.map((p) => `${xScale(p.t)},${pY(p.v)}`).join(' ')
  const demandLine = demandSeries.map((p) => `${xScale(p.t)},${dY(p.v)}`).join(' ')

  // 가위 음영: 두 시계열을 0~1 정규화해 수요>도매가 인 구간(공통 시간 그리드 샘플)
  // 시간 정렬 후 선형보간으로 같은 x 에서 비교.
  const shade = buildShade({
    priceSeries,
    demandSeries,
    tMin,
    tSpan,
    pMin,
    pSpan,
    dMin,
    dSpan,
    xScale,
    PAD_T,
    plotH,
  })

  const hasPrice = priceSeries.length >= 2
  const hasDemand = demandSeries.length >= 2

  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <div className="rounded border border-gray-200 p-4">
      <h3 className="text-sm font-semibold mb-1 truncate" title={productName}>
        {productName}
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        <span className="text-blue-600">— 도매가(좌축)</span> ·{' '}
        <span className="text-amber-600">— 수요지수(우축)</span> · 음영 = 수요↑·도매가↓ 가위 구간
      </p>

      {!hasDemand ? (
        <div className="text-xs text-gray-400 py-12 text-center">
          수요 시계열 2점 미만 — 차트 표시 불가 (cron 누적 대기)
        </div>
      ) : (
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 가위 음영 */}
          {shade.map((seg, i) => (
            <polygon key={i} points={seg} fill="#10b981" fillOpacity={0.12} />
          ))}

          {/* 좌축 grid + 라벨 (도매가) */}
          {hasPrice &&
            [0, 0.25, 0.5, 0.75, 1].map((f) => {
              const v = pMin + f * pSpan
              const y = pY(v)
              return (
                <g key={'pl' + f}>
                  <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="#f1f5f9" />
                  <text x={PAD_L - 6} y={y + 3} fontSize="9" fill="#3b82f6" textAnchor="end">
                    {Math.round(v).toLocaleString()}
                  </text>
                </g>
              )
            })}

          {/* 우축 라벨 (수요) */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const v = dMin + f * dSpan
            const y = dY(v)
            return (
              <text key={'dl' + f} x={W - PAD_R + 6} y={y + 3} fontSize="9" fill="#d97706" textAnchor="start">
                {v.toFixed(0)}
              </text>
            )
          })}

          {/* x축 라벨 (시작/끝) */}
          {allT.length > 0 && (
            <>
              <text x={PAD_L} y={H - PAD_B + 16} fontSize="9" fill="#9ca3af" textAnchor="start">
                {fmtDate(new Date(tMin).toISOString())}
              </text>
              <text x={W - PAD_R} y={H - PAD_B + 16} fontSize="9" fill="#9ca3af" textAnchor="end">
                {fmtDate(new Date(tMax).toISOString())}
              </text>
            </>
          )}

          {/* 축 선 */}
          <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="#cbd5e1" />
          <line x1={W - PAD_R} y1={PAD_T} x2={W - PAD_R} y2={H - PAD_B} stroke="#cbd5e1" />

          {/* 도매가 라인 */}
          {hasPrice ? (
            <>
              <polyline points={priceLine} fill="none" stroke="#3b82f6" strokeWidth={2} />
              {priceSeries.map((p, i) => (
                <circle key={'pc' + i} cx={xScale(p.t)} cy={pY(p.v)} r={2.5} fill="#3b82f6" />
              ))}
            </>
          ) : (
            <text x={W / 2} y={PAD_T + 14} fontSize="10" fill="#94a3b8" textAnchor="middle">
              도매가 이력 없음 (소싱 미연결)
            </text>
          )}

          {/* 수요 라인 */}
          <polyline points={demandLine} fill="none" stroke="#f59e0b" strokeWidth={2} />
          {demandSeries.map((p, i) => (
            <circle key={'dc' + i} cx={xScale(p.t)} cy={dY(p.v)} r={2.5} fill="#f59e0b" />
          ))}
        </svg>
      )}
    </div>
  )
}

// 두 곡선을 정규화(0~1, 위가 큼)해 수요_norm > 도매가_norm 구간을 음영 폴리곤으로.
function buildShade(args: {
  priceSeries: Point[]
  demandSeries: Point[]
  tMin: number
  tSpan: number
  pMin: number
  pSpan: number
  dMin: number
  dSpan: number
  xScale: (iso: string) => number
  PAD_T: number
  plotH: number
}): string[] {
  const { priceSeries, demandSeries, tMin, tSpan, pMin, pSpan, dMin, dSpan, PAD_T, plotH } = args
  if (priceSeries.length < 2 || demandSeries.length < 2) return []

  const pPts = priceSeries
    .map((p) => ({ x: new Date(p.t).getTime(), v: p.v }))
    .sort((a, b) => a.x - b.x)
  const dPts = demandSeries
    .map((p) => ({ x: new Date(p.t).getTime(), v: p.v }))
    .sort((a, b) => a.x - b.x)

  const interp = (pts: { x: number; v: number }[], x: number): number | null => {
    if (x < pts[0].x || x > pts[pts.length - 1].x) return null
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].x) {
        const a = pts[i - 1]
        const b = pts[i]
        const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)
        return a.v + f * (b.v - a.v)
      }
    }
    return pts[pts.length - 1].v
  }

  const W_PLOT = 640 - 56 - 56
  const SAMPLES = 60
  const xPx = (x: number) => 56 + ((x - tMin) / tSpan) * W_PLOT
  // 정규화: 수요는 높을수록 위(1), 도매가도 높을수록 위(1).
  // 가위 = 수요 상대위치가 도매가 상대위치보다 높은(=벌어진) 구간.
  const yTop = (norm: number) => PAD_T + plotH - norm * plotH

  const segs: string[] = []
  let cur: string[] = []
  for (let i = 0; i <= SAMPLES; i++) {
    const x = tMin + (i / SAMPLES) * tSpan
    const pv = interp(pPts, x)
    const dv = interp(dPts, x)
    if (pv == null || dv == null) {
      if (cur.length >= 2) segs.push(closePoly(cur))
      cur = []
      continue
    }
    const pNorm = pSpan ? (pv - pMin) / pSpan : 0.5
    const dNorm = dSpan ? (dv - dMin) / dSpan : 0.5
    if (dNorm > pNorm) {
      cur.push(`${xPx(x)},${yTop(dNorm)}|${xPx(x)},${yTop(pNorm)}`)
    } else {
      if (cur.length >= 2) segs.push(closePoly(cur))
      cur = []
    }
  }
  if (cur.length >= 2) segs.push(closePoly(cur))
  return segs
}

function closePoly(pairs: string[]): string {
  const top = pairs.map((p) => p.split('|')[0])
  const bottom = pairs.map((p) => p.split('|')[1]).reverse()
  return [...top, ...bottom].join(' ')
}
