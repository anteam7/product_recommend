'use client'
import { useMemo, useState } from 'react'

export interface ScorePoint {
  computed_at: string
  trend: number
  commerce: number
  supplier: number
  competition: number
  final: number
}

export interface SignalPoint {
  date: string // YYYY-MM-DD
  count: number
}

export interface PriceTick {
  date: string
  price_krw: number | null
}

interface Props {
  scoreSeries: ScorePoint[]
  signals: Record<string, SignalPoint[]> // source → daily counts
  prices: PriceTick[]
  ggsanTitle?: string | null
}

const SCORE_KEYS: Array<{ key: keyof Omit<ScorePoint, 'computed_at'>; label: string; color: string }> = [
  { key: 'final', label: 'final', color: '#111827' },
  { key: 'trend', label: 'trend', color: '#3b82f6' },
  { key: 'commerce', label: 'commerce', color: '#10b981' },
  { key: 'supplier', label: 'supplier', color: '#f59e0b' },
]

const SOURCE_COLORS: Record<string, string> = {
  naver_search_trend: '#3b82f6',
  naver_shopping_insight: '#10b981',
  naver_news: '#ef4444',
  naver_tvtime: '#a78bfa',
}

function buildDateAxis(days = 30): string[] {
  const out: string[] = []
  const now = new Date()
  now.setUTCHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

function Sparkline({
  series,
  color,
  label,
  latest,
}: {
  series: number[]
  color: string
  label: string
  latest: number
}) {
  const W = 160
  const H = 48
  const PAD = 4
  const valid = series.filter((v) => Number.isFinite(v))
  if (valid.length < 2) {
    return (
      <div className="rounded border border-gray-200 p-2">
        <div className="text-[10px] uppercase text-gray-500">{label}</div>
        <div className="text-lg font-bold mt-1">{latest}</div>
        <div className="text-[10px] text-gray-400">데이터 부족</div>
      </div>
    )
  }
  const max = Math.max(...valid)
  const min = Math.min(...valid)
  const range = Math.max(max - min, 1)
  const step = (W - PAD * 2) / (series.length - 1)
  const pts = series
    .map((v, i) => {
      if (!Number.isFinite(v)) return null
      const x = PAD + i * step
      const y = H - PAD - ((v - min) / range) * (H - PAD * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')
  return (
    <div className="rounded border border-gray-200 p-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase text-gray-500">{label}</div>
        <div className="text-sm font-bold" style={{ color }}>
          {latest}
        </div>
      </div>
      <svg width={W} height={H} className="block mt-1">
        <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      </svg>
      <div className="flex justify-between text-[9px] text-gray-400 font-mono">
        <span>{min.toFixed(0)}</span>
        <span>30d</span>
        <span>{max.toFixed(0)}</span>
      </div>
    </div>
  )
}

export default function SignalTimeline({ scoreSeries, signals, prices, ggsanTitle }: Props) {
  const axis = useMemo(() => buildDateAxis(30), [])
  const [hover, setHover] = useState<{ date: string; x: number } | null>(null)

  // Build aligned series for each score key
  const scoreByDate: Record<string, ScorePoint> = useMemo(() => {
    const m: Record<string, ScorePoint> = {}
    for (const p of scoreSeries) {
      const d = p.computed_at.slice(0, 10)
      if (!m[d] || p.computed_at > m[d].computed_at) m[d] = p
    }
    return m
  }, [scoreSeries])

  function alignedScore(key: keyof Omit<ScorePoint, 'computed_at'>): number[] {
    let lastVal: number = NaN
    return axis.map((d) => {
      if (scoreByDate[d]) {
        lastVal = scoreByDate[d][key] as number
      }
      return lastVal
    })
  }

  // Stacked area chart for signals
  const sources = Object.keys(signals).sort()
  const stack = useMemo(() => {
    // For each date, compute cumulative stacked counts per source
    return axis.map((d) => {
      const row: Record<string, number> = { date: 0 as any }
      ;(row as any).date = d
      let cum = 0
      const layers: Record<string, { y0: number; y1: number; count: number }> = {}
      for (const s of sources) {
        const c = signals[s].find((x) => x.date === d)?.count ?? 0
        layers[s] = { y0: cum, y1: cum + c, count: c }
        cum += c
      }
      ;(row as any)._max = cum
      ;(row as any)._layers = layers
      return row
    })
  }, [axis, signals, sources])

  const maxStack = Math.max(1, ...stack.map((r) => (r as any)._max as number))
  const W = 760
  const H = 200
  const PAD_L = 36
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 24
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B
  const xStep = innerW / Math.max(1, axis.length - 1)
  const x = (i: number) => PAD_L + i * xStep
  const yStack = (v: number) => PAD_T + innerH - (v / maxStack) * innerH

  // Build area polygons per source
  const polygons = sources.map((s) => {
    const top: string[] = []
    const bottom: string[] = []
    stack.forEach((row, i) => {
      const layer = (row as any)._layers[s] as { y0: number; y1: number }
      top.push(`${x(i).toFixed(1)},${yStack(layer.y1).toFixed(1)}`)
      bottom.push(`${x(i).toFixed(1)},${yStack(layer.y0).toFixed(1)}`)
    })
    const poly = [...top, ...bottom.reverse()].join(' ')
    return { source: s, points: poly, color: SOURCE_COLORS[s] ?? '#9ca3af' }
  })

  // Price overlay: scale price into 0..innerH using its own range (right axis, but we just normalize)
  const priceVals = prices.map((p) => p.price_krw).filter((v): v is number => v != null && v > 0)
  const priceMin = priceVals.length ? Math.min(...priceVals) : 0
  const priceMax = priceVals.length ? Math.max(...priceVals) : 1
  const priceRange = Math.max(priceMax - priceMin, 1)
  // Forward-fill price by date
  const priceByDate: Record<string, number | null> = {}
  for (const p of prices) priceByDate[p.date] = p.price_krw
  let lastPrice: number | null = null
  const priceLine = axis
    .map((d, i) => {
      if (priceByDate[d] != null) lastPrice = priceByDate[d]
      if (lastPrice == null) return null
      const y = PAD_T + innerH - ((lastPrice - priceMin) / priceRange) * innerH
      return `${x(i).toFixed(1)},${y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const i = Math.round((px - PAD_L) / xStep)
    if (i < 0 || i >= axis.length) {
      setHover(null)
      return
    }
    setHover({ date: axis[i], x: x(i) })
  }

  const hoverIdx = hover ? axis.indexOf(hover.date) : -1
  const hoverRow = hoverIdx >= 0 ? (stack[hoverIdx] as any) : null

  return (
    <div className="space-y-4">
      {/* Sparklines */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {SCORE_KEYS.map((k) => {
          const series = alignedScore(k.key)
          const lastVal = scoreSeries[0] ? (scoreSeries[0][k.key] as number) : 0
          return <Sparkline key={k.key} series={series} color={k.color} label={k.label} latest={lastVal} />
        })}
      </div>

      {/* Stacked area */}
      <div className="rounded border border-gray-200 p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">underlying signals (30일)</h3>
          <div className="flex gap-3 text-[10px] text-gray-600">
            {sources.map((s) => (
              <span key={s} className="flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ background: SOURCE_COLORS[s] ?? '#9ca3af' }}
                />
                {s}
              </span>
            ))}
            {priceLine && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-px bg-gray-800" />
                ggsan price{ggsanTitle ? ` (${ggsanTitle.slice(0, 18)}…)` : ''}
              </span>
            )}
          </div>
        </div>
        <svg
          width={W}
          height={H}
          className="block w-full"
          viewBox={`0 0 ${W} ${H}`}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* y grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
            <g key={i}>
              <line
                x1={PAD_L}
                y1={PAD_T + innerH * (1 - p)}
                x2={W - PAD_R}
                y2={PAD_T + innerH * (1 - p)}
                stroke="#f3f4f6"
              />
              <text x={PAD_L - 4} y={PAD_T + innerH * (1 - p) + 3} fontSize="9" fill="#9ca3af" textAnchor="end">
                {Math.round(maxStack * p)}
              </text>
            </g>
          ))}
          {/* x axis labels */}
          {axis.map((d, i) =>
            i % 5 === 0 ? (
              <text
                key={d}
                x={x(i)}
                y={H - PAD_B + 14}
                fontSize="9"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {d.slice(5)}
              </text>
            ) : null,
          )}
          {/* areas */}
          {polygons.map((p) => (
            <polygon
              key={p.source}
              points={p.points}
              fill={p.color}
              fillOpacity={0.55}
              stroke={p.color}
              strokeWidth={0.5}
            />
          ))}
          {/* price line */}
          {priceLine && <polyline points={priceLine} fill="none" stroke="#111827" strokeWidth={1.5} strokeDasharray="3,2" />}
          {/* hover */}
          {hover && (
            <line x1={hover.x} y1={PAD_T} x2={hover.x} y2={H - PAD_B} stroke="#6b7280" strokeDasharray="2,2" />
          )}
        </svg>
        {hover && hoverRow && (
          <div className="text-xs font-mono text-gray-700 mt-1">
            {hover.date} ·{' '}
            {sources.map((s) => (
              <span key={s} className="mr-3">
                <span style={{ color: SOURCE_COLORS[s] ?? '#9ca3af' }}>{s}</span>={hoverRow._layers[s].count}
              </span>
            ))}
            {priceByDate[hover.date] != null && (
              <span className="ml-2">
                price=<b>{priceByDate[hover.date]?.toLocaleString()}원</b>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
