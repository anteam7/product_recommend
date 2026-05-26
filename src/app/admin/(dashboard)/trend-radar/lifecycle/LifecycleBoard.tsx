'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

interface CurveRow {
  week_t: number
  at_risk: number
  events: number
  cohort_size: number
}
interface ActiveSku {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  current_score: number
  weeks_since_first: number
}

interface Props {
  curve: CurveRow[]
  active: ActiveSku[]
  threshold: number
  category: string
}

interface KmPoint {
  t: number
  s: number       // cumulative survival
  lower: number   // greenwood lower band (approx p25/p75 visualization → ±1 sd)
  upper: number
  at_risk: number
  events: number
}

function buildKm(curve: CurveRow[]): KmPoint[] {
  // S(t) = Π_{i ≤ t} (1 - d_i / n_i)
  // Greenwood variance: Var(S(t)) = S(t)^2 * Σ d_i / (n_i (n_i - d_i))
  let s = 1
  let varAccum = 0
  const out: KmPoint[] = []
  for (const row of curve) {
    const n = row.at_risk
    const d = row.events
    if (n > 0 && d > 0) {
      s = s * (1 - d / n)
      if (n - d > 0) {
        varAccum += d / (n * (n - d))
      }
    }
    const sd = Math.sqrt(Math.max(0, varAccum)) * s
    out.push({
      t: row.week_t,
      s,
      lower: Math.max(0, s - sd),
      upper: Math.min(1, s + sd),
      at_risk: n,
      events: d,
    })
  }
  return out
}

function medianSurvival(km: KmPoint[]): number | null {
  for (const p of km) if (p.s <= 0.5) return p.t
  return null
}

export default function LifecycleBoard({ curve, active, threshold, category }: Props) {
  const km = useMemo(() => buildKm(curve), [curve])
  const median = useMemo(() => medianSurvival(km), [km])
  const maxT = Math.max(1, km[km.length - 1]?.t ?? 1)

  const [hover, setHover] = useState<ActiveSku | null>(null)

  const W = 720
  const H = 420
  const PAD_L = 50
  const PAD_R = 20
  const PAD_T = 20
  const PAD_B = 40

  const xScale = (t: number) => PAD_L + (t / maxT) * (W - PAD_L - PAD_R)
  const yScale = (s: number) => PAD_T + (1 - s) * (H - PAD_T - PAD_B)

  // 활성 SKU 를 cohort 곡선 위에 점으로 오버레이
  const activePoints = active.map((a) => {
    // 자신의 weeks_since_first 에 해당하는 곡선 위 점.
    const t = Math.max(0, Math.min(maxT, a.weeks_since_first))
    // 곡선 보간
    let s = 1
    for (const p of km) {
      if (p.t <= t) s = p.s
      else break
    }
    const remaining =
      median != null ? Math.max(0, median - a.weeks_since_first) : null
    return { ...a, t, s, remaining }
  })

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* 좌측: KM 곡선 */}
      <div className="col-span-7 rounded border border-gray-200 p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">
            KM 생존곡선 — {category === 'all' ? '전체' : category}
          </h2>
          <div className="text-xs text-gray-500 font-mono">
            median: {median != null ? `${median}주` : '미도달'} · cohort N={curve[0]?.cohort_size ?? 0}
          </div>
        </div>

        <svg width={W} height={H} className="block">
          {/* y grid 0/0.25/0.5/0.75/1 */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={'y' + v}>
              <line
                x1={PAD_L}
                y1={yScale(v)}
                x2={W - PAD_R}
                y2={yScale(v)}
                stroke="#e5e7eb"
                strokeDasharray={v === 0.5 ? '4,3' : '2,3'}
              />
              <text x={PAD_L - 6} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v.toFixed(2)}
              </text>
            </g>
          ))}
          {/* x grid */}
          {Array.from({ length: Math.min(maxT, 12) + 1 }, (_, i) =>
            Math.round((i * maxT) / Math.min(maxT, 12)),
          )
            .filter((v, i, a) => a.indexOf(v) === i)
            .map((v) => (
              <g key={'x' + v}>
                <line
                  x1={xScale(v)}
                  y1={PAD_T}
                  x2={xScale(v)}
                  y2={H - PAD_B}
                  stroke="#f3f4f6"
                />
                <text
                  x={xScale(v)}
                  y={H - PAD_B + 14}
                  fontSize="10"
                  fill="#9ca3af"
                  textAnchor="middle"
                >
                  {v}w
                </text>
              </g>
            ))}

          {/* greenwood band */}
          {km.length > 1 && (
            <path
              d={
                'M ' +
                km.map((p) => `${xScale(p.t)},${yScale(p.upper)}`).join(' L ') +
                ' L ' +
                km
                  .slice()
                  .reverse()
                  .map((p) => `${xScale(p.t)},${yScale(p.lower)}`)
                  .join(' L ') +
                ' Z'
              }
              fill="#3b82f6"
              fillOpacity={0.1}
            />
          )}

          {/* step line */}
          {km.length > 1 && (
            <path
              d={km
                .map((p, i) => {
                  if (i === 0) return `M ${xScale(p.t)} ${yScale(p.s)}`
                  const prev = km[i - 1]
                  return `L ${xScale(p.t)} ${yScale(prev.s)} L ${xScale(p.t)} ${yScale(p.s)}`
                })
                .join(' ')}
              fill="none"
              stroke="#1d4ed8"
              strokeWidth={2}
            />
          )}

          {/* median line */}
          {median != null && (
            <g>
              <line
                x1={xScale(median)}
                y1={PAD_T}
                x2={xScale(median)}
                y2={H - PAD_B}
                stroke="#ef4444"
                strokeDasharray="4,3"
              />
              <text x={xScale(median) + 4} y={PAD_T + 12} fontSize="10" fill="#ef4444">
                median {median}w
              </text>
            </g>
          )}

          {/* axes */}
          <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="#9ca3af" />
          <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="#9ca3af" />

          <text x={W / 2} y={H - 6} fontSize="11" fill="#6b7280" textAnchor="middle">
            첫등장 후 경과 (주)
          </text>
          <text
            x={14}
            y={H / 2}
            fontSize="11"
            fill="#6b7280"
            textAnchor="middle"
            transform={`rotate(-90 14 ${H / 2})`}
          >
            S(t) = P(final_score ≥ {threshold})
          </text>
        </svg>
      </div>

      {/* 우측: 활성 SKU 오버레이 */}
      <div className="col-span-5 rounded border border-gray-200 p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">활성 SKU — cohort 위 위치</h2>
          <span className="text-xs text-gray-500">{activePoints.length}개</span>
        </div>

        <div className="relative">
          <svg width={W * 0.55} height={H} className="block">
            {/* y 0/0.5/1 */}
            {[0, 0.25, 0.5, 0.75, 1].map((v) => {
              const W2 = W * 0.55
              const yS = (s: number) => PAD_T + (1 - s) * (H - PAD_T - PAD_B)
              const xS = (t: number) => PAD_L + (t / maxT) * (W2 - PAD_L - PAD_R)
              return (
                <g key={'oy' + v}>
                  <line x1={PAD_L} y1={yS(v)} x2={W2 - PAD_R} y2={yS(v)} stroke="#e5e7eb" />
                  <text x={PAD_L - 6} y={yS(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                    {v.toFixed(2)}
                  </text>
                </g>
              )
            })}
            {/* curve (옅게) */}
            {km.length > 1 &&
              (() => {
                const W2 = W * 0.55
                const yS = (s: number) => PAD_T + (1 - s) * (H - PAD_T - PAD_B)
                const xS = (t: number) => PAD_L + (t / maxT) * (W2 - PAD_L - PAD_R)
                return (
                  <path
                    d={km
                      .map((p, i) => {
                        if (i === 0) return `M ${xS(p.t)} ${yS(p.s)}`
                        const prev = km[i - 1]
                        return `L ${xS(p.t)} ${yS(prev.s)} L ${xS(p.t)} ${yS(p.s)}`
                      })
                      .join(' ')}
                    fill="none"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                  />
                )
              })()}
            {/* 점들 */}
            {(() => {
              const W2 = W * 0.55
              const yS = (s: number) => PAD_T + (1 - s) * (H - PAD_T - PAD_B)
              const xS = (t: number) => PAD_L + (t / maxT) * (W2 - PAD_L - PAD_R)
              return activePoints.map((a) => (
                <circle
                  key={a.product_id}
                  cx={xS(a.t)}
                  cy={yS(a.s)}
                  r={4}
                  fill="#10b981"
                  fillOpacity={0.7}
                  stroke="#065f46"
                  strokeOpacity={0.4}
                  onMouseEnter={() => setHover(a)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              ))
            })()}
            <text
              x={(W * 0.55) / 2}
              y={H - 6}
              fontSize="11"
              fill="#6b7280"
              textAnchor="middle"
            >
              현재 주차 (cohort 곡선 위)
            </text>
          </svg>

          {hover && (
            <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
              <div className="font-semibold">{hover.canonical_name}</div>
              <div className="opacity-80">
                {hover.category_top}
                {hover.category_mid ? ` / ${hover.category_mid}` : ''}
              </div>
              <div className="mt-1 font-mono">
                cohort 중앙값 {median != null ? `${median.toFixed(1)}주` : 'N/A'} / 현재{' '}
                {hover.weeks_since_first.toFixed(1)}주차 / 잔여 추정{' '}
                {median != null
                  ? `${Math.max(0, median - hover.weeks_since_first).toFixed(1)}주`
                  : 'N/A'}
              </div>
            </div>
          )}
        </div>

        {/* sub-list: 잔여수명 짧은 순 */}
        <div className="mt-3 max-h-64 overflow-y-auto border-t border-gray-100 pt-2">
          <div className="text-xs text-gray-500 mb-1">잔여 추정 짧은 순 (상위 12)</div>
          {activePoints
            .slice()
            .sort((a, b) => {
              const ra = a.remaining ?? Number.POSITIVE_INFINITY
              const rb = b.remaining ?? Number.POSITIVE_INFINITY
              return ra - rb
            })
            .slice(0, 12)
            .map((a) => (
              <Link
                key={a.product_id}
                href={`/admin/trend-radar/products/${a.product_id}`}
                className="flex items-center justify-between text-xs py-1 px-1 rounded hover:bg-gray-50"
              >
                <span className="truncate max-w-[60%]">{a.canonical_name}</span>
                <span className="font-mono text-gray-500">
                  {a.weeks_since_first.toFixed(1)}w · 잔여{' '}
                  {a.remaining != null ? a.remaining.toFixed(1) + 'w' : '—'}
                </span>
              </Link>
            ))}
          {activePoints.length === 0 && (
            <div className="text-xs text-gray-400">활성 SKU 없음.</div>
          )}
        </div>
      </div>
    </div>
  )
}
