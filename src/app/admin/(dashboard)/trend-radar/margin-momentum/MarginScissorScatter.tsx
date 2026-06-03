'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface SeriesPoint {
  t: string // ISO
  v: number
}

export interface ScissorRow {
  id: string
  name: string
  category: string
  x: number // 수요 모멘텀 0-100 (50=무변동, 오른쪽=수요↑)
  y: number // 원가 모멘텀 0-100 (50=무변동, 위=원가↓ = 마진 확장)
  size: number // commerce/final 가중 크기
  demandDelta: number // trend_score Δ
  costDropPct: number // 원가 하락률 (+ = 하락)
  latestPrice: number | null
  basePrice: number | null
  urgency: number // 시급도 (높을수록 지금 진입)
  quadrant: 1 | 2 | 3 | 4
  demandSeries: SeriesPoint[]
  costSeries: SeriesPoint[]
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

const QUADRANT_META: Record<number, { label: string; color: string; bg: string }> = {
  1: { label: '① 즉시소싱 (수요↑·원가↓)', color: '#10b981', bg: '#f0fdf4' },
  2: { label: '② 마진압박 경계 (수요↑·원가↑)', color: '#f59e0b', bg: '#fffbeb' },
  3: { label: '③ 관망 (수요↓·원가↓)', color: '#3b82f6', bg: '#eff6ff' },
  4: { label: '④ 폐기 (수요↓·원가↑)', color: '#9ca3af', bg: '#f9fafb' },
}

function MiniDualChart({ row }: { row: ScissorRow }) {
  const W = 320
  const H = 120
  const PAD = 24
  const series = [
    { pts: row.demandSeries, color: '#2563eb', label: '수요(trend)' },
    { pts: row.costSeries, color: '#dc2626', label: '원가(price)' },
  ]
  const path = (pts: SeriesPoint[]) => {
    if (pts.length === 0) return ''
    const vs = pts.map((p) => p.v)
    const min = Math.min(...vs)
    const max = Math.max(...vs)
    const span = max - min || 1
    const n = pts.length
    return pts
      .map((p, i) => {
        const px = PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i / (n - 1)) * (W - 2 * PAD))
        const py = H - PAD - ((p.v - min) / span) * (H - 2 * PAD)
        return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`
      })
      .join(' ')
  }
  return (
    <svg width={W} height={H} className="block">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e5e7eb" />
      {series.map((s) => (
        <g key={s.label}>
          <path d={path(s.pts)} fill="none" stroke={s.color} strokeWidth={1.8} />
          {s.pts.map((p, i) => {
            const vs = s.pts.map((q) => q.v)
            const min = Math.min(...vs)
            const span = (Math.max(...vs) - min) || 1
            const n = s.pts.length
            const px = PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i / (n - 1)) * (W - 2 * PAD))
            const py = H - PAD - ((p.v - min) / span) * (H - 2 * PAD)
            return <circle key={i} cx={px} cy={py} r={2} fill={s.color} />
          })}
        </g>
      ))}
    </svg>
  )
}

export default function MarginScissorScatter({ rows }: { rows: ScissorRow[] }) {
  const [hover, setHover] = useState<ScissorRow | null>(null)
  const [selected, setSelected] = useState<ScissorRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.max(3, Math.sqrt(v / Math.PI) * 1.2)

  const sourcingQueue = rows
    .filter((r) => r.quadrant === 1)
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 15)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경: ① 즉시소싱 (우상단) */}
          <rect x={xScale(50)} y={yScale(100)} width={xScale(100) - xScale(50)} height={yScale(50) - yScale(100)} fill="#f0fdf4" />
          {/* ② 마진압박 (우하단) */}
          <rect x={xScale(50)} y={yScale(50)} width={xScale(100) - xScale(50)} height={yScale(0) - yScale(50)} fill="#fffbeb" />

          {/* 0축 (Δ=0) 강조선 */}
          <line x1={xScale(50)} y1={PAD} x2={xScale(50)} y2={H - PAD} stroke="#9ca3af" strokeWidth={1} />
          <line x1={PAD} y1={yScale(50)} x2={W - PAD} y2={yScale(50)} stroke="#9ca3af" strokeWidth={1} />

          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v - 50 > 0 ? `+${v - 50}` : v - 50}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v - 50 > 0 ? `+${v - 50}` : v - 50}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            수요 모멘텀 (→ 트렌드 상승)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            원가 모멘텀 (↑ 도매가 하락 = 마진 확장)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(96)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            ① 즉시소싱 (마진 골든크로스)
          </text>
          <text x={xScale(75)} y={yScale(4) - 2} fontSize="10" fill="#f59e0b" textAnchor="middle">
            ② 마진압박 경계
          </text>
          <text x={xScale(25)} y={yScale(96)} fontSize="10" fill="#3b82f6" textAnchor="middle">
            ③ 관망
          </text>
          <text x={xScale(25)} y={yScale(4) - 2} fontSize="10" fill="#9ca3af" textAnchor="middle">
            ④ 폐기
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <circle
              key={r.id}
              cx={xScale(r.x)}
              cy={yScale(r.y)}
              r={rScale(r.size)}
              fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
              fillOpacity={selected?.id === r.id ? 0.85 : 0.5}
              stroke={r.quadrant === 1 ? '#065f46' : CATEGORY_COLORS[r.category] ?? '#6b7280'}
              strokeWidth={r.quadrant === 1 ? 1.5 : 1}
              strokeOpacity={0.9}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover(null)}
              onClick={() => setSelected(r)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {/* hover tooltip */}
        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs pointer-events-none">
            <div className="font-semibold">{hover.name}</div>
            <div>{QUADRANT_META[hover.quadrant].label}</div>
            <div>
              수요 Δ: {hover.demandDelta > 0 ? '+' : ''}{hover.demandDelta} · 원가:{' '}
              {hover.costDropPct > 0 ? `▼${hover.costDropPct}%` : hover.costDropPct < 0 ? `▲${-hover.costDropPct}%` : '0%'}
            </div>
            <div className="text-gray-300 mt-0.5">클릭 → 듀얼축 추이</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
      </div>

      {/* 드릴다운: 수요선 · 원가선 듀얼축 타임차트 */}
      {selected && (
        <div className="mt-6 border-t border-gray-200 pt-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">
              {selected.name}{' '}
              <span className="text-xs font-normal" style={{ color: QUADRANT_META[selected.quadrant].color }}>
                {QUADRANT_META[selected.quadrant].label}
              </span>
            </h3>
            <Link href={`/admin/trend-radar/products/${selected.id}`} className="text-xs text-gray-600 hover:text-black underline">
              상품 상세 →
            </Link>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-6">
            <MiniDualChart row={selected} />
            <div className="text-xs text-gray-600 space-y-1">
              <div><span className="inline-block w-3 h-0.5 bg-blue-600 align-middle mr-1" /> 수요(trend) Δ {selected.demandDelta > 0 ? '+' : ''}{selected.demandDelta}</div>
              <div><span className="inline-block w-3 h-0.5 bg-red-600 align-middle mr-1" /> 원가 {selected.costDropPct > 0 ? `▼ ${selected.costDropPct}% 하락` : selected.costDropPct < 0 ? `▲ ${-selected.costDropPct}% 상승` : '변동 없음'}</div>
              {selected.basePrice != null && selected.latestPrice != null && (
                <div className="text-gray-500">{selected.basePrice.toLocaleString()}원 → {selected.latestPrice.toLocaleString()}원</div>
              )}
              <div className="text-gray-400">시급도 {selected.urgency}</div>
            </div>
          </div>
        </div>
      )}

      {/* 소싱 큐: ① 즉시소싱 사분면, 시급도순 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          🎯 소싱 큐 — 즉시소싱 (수요↑·원가↓), 시급도순{' '}
          <span className="text-xs font-normal text-gray-500">지금 원가까지 빠지는 골든크로스</span>
        </h3>
        <div className="space-y-1 text-sm">
          {sourcingQueue.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r)}
              className="w-full text-left grid grid-cols-12 items-center px-2 py-1 rounded hover:bg-gray-50"
            >
              <span className="col-span-1 font-mono text-emerald-600 font-bold">{r.urgency}</span>
              <span className="col-span-7 truncate">{r.name}</span>
              <span className="col-span-2 text-right text-xs text-blue-600">수요 +{r.demandDelta}</span>
              <span className="col-span-2 text-right text-xs text-red-600">원가 ▼{r.costDropPct}%</span>
            </button>
          ))}
          {sourcingQueue.length === 0 && (
            <div className="text-gray-400 text-xs">
              아직 골든크로스 후보 없음. 점수·도매가 시계열이 2회 이상 누적되면 등장.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
