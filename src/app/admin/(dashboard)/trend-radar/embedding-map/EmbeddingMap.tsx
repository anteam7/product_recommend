'use client'
import { useMemo, useState } from 'react'

export interface EmbPoint {
  id: string
  name: string
  category: string
  cluster_id: number
  cluster_label: string
  cluster_momentum: number
  final: number
  vec_x: number
  vec_y: number
  vec_prev_x: number | null
  vec_prev_y: number | null
}

const W = 820
const H = 560
const PAD = 40

// 톤다운된 카테고리컬 팔레트 — cluster_id 별 색. -1(noise) 는 회색.
const CLUSTER_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#a78bfa',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1',
  '#06b6d4', '#eab308', '#22c55e', '#0ea5e9', '#d946ef',
]
const NOISE_COLOR = '#cbd5e1'

function colorFor(clusterId: number) {
  if (clusterId < 0) return NOISE_COLOR
  return CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length]
}

export default function EmbeddingMap({ points }: { points: EmbPoint[] }) {
  const [hover, setHover] = useState<EmbPoint | null>(null)
  const [hideNoise, setHideNoise] = useState(false)
  const [highlight, setHighlight] = useState<number | null>(null)

  const bounds = useMemo(() => {
    if (points.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of points) {
      minX = Math.min(minX, p.vec_x, p.vec_prev_x ?? p.vec_x)
      maxX = Math.max(maxX, p.vec_x, p.vec_prev_x ?? p.vec_x)
      minY = Math.min(minY, p.vec_y, p.vec_prev_y ?? p.vec_y)
      maxY = Math.max(maxY, p.vec_y, p.vec_prev_y ?? p.vec_y)
    }
    if (minX === maxX) { minX -= 1; maxX += 1 }
    if (minY === maxY) { minY -= 1; maxY += 1 }
    return { minX, maxX, minY, maxY }
  }, [points])

  const xScale = (v: number) => PAD + ((v - bounds.minX) / (bounds.maxX - bounds.minX)) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - ((v - bounds.minY) / (bounds.maxY - bounds.minY)) * (H - 2 * PAD)
  const rScale = (final: number) => Math.max(3, Math.min(18, 3 + Math.sqrt(Math.max(0, final)) * 1.4))

  // cluster 단위 요약
  const clusters = useMemo(() => {
    const map = new Map<number, { id: number; label: string; size: number; momentum: number; avgFinal: number }>()
    for (const p of points) {
      const cur = map.get(p.cluster_id)
      if (cur) {
        cur.size++
        cur.avgFinal += p.final
      } else {
        map.set(p.cluster_id, { id: p.cluster_id, label: p.cluster_label || (p.cluster_id < 0 ? '(noise)' : `cluster ${p.cluster_id}`), size: 1, momentum: p.cluster_momentum, avgFinal: p.final })
      }
    }
    return [...map.values()]
      .map((c) => ({ ...c, avgFinal: c.size > 0 ? Math.round(c.avgFinal / c.size) : 0 }))
      .sort((a, b) => b.momentum - a.momentum || b.size - a.size)
  }, [points])

  const visiblePoints = hideNoise ? points.filter((p) => p.cluster_id >= 0) : points

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} />
          noise(-1) 숨김
        </label>
        <span className="text-gray-400">·</span>
        <span>점 크기 = final_score · 화살표 = 7일 전 → 현재 (모멘텀)</span>
        {highlight !== null && (
          <button
            onClick={() => setHighlight(null)}
            className="ml-auto text-xs text-gray-500 underline hover:text-black"
          >
            클러스터 강조 해제
          </button>
        )}
      </div>

      <div className="flex gap-6 items-start">
        <div className="rounded border border-gray-200 p-3 bg-white relative">
          <svg width={W} height={H} style={{ overflow: 'visible' }}>
            <defs>
              <marker id="emb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>

            <rect x={PAD} y={PAD} width={W - 2 * PAD} height={H - 2 * PAD} fill="#fafafa" stroke="#e5e7eb" />

            {/* trail (화살표) */}
            {visiblePoints.map((p) => {
              if (p.vec_prev_x == null || p.vec_prev_y == null) return null
              const dim = highlight !== null && p.cluster_id !== highlight
              const col = colorFor(p.cluster_id)
              return (
                <line
                  key={`l-${p.id}`}
                  x1={xScale(p.vec_prev_x)}
                  y1={yScale(p.vec_prev_y)}
                  x2={xScale(p.vec_x)}
                  y2={yScale(p.vec_y)}
                  stroke={col}
                  strokeOpacity={dim ? 0.08 : 0.45}
                  strokeWidth={1.2}
                  markerEnd="url(#emb-arrow)"
                  style={{ color: col }}
                />
              )
            })}

            {/* 점 */}
            {visiblePoints.map((p) => {
              const dim = highlight !== null && p.cluster_id !== highlight
              const col = colorFor(p.cluster_id)
              return (
                <a key={p.id} href={`/admin/trend-radar/products/${p.id}`}>
                  <circle
                    cx={xScale(p.vec_x)}
                    cy={yScale(p.vec_y)}
                    r={rScale(p.final)}
                    fill={col}
                    fillOpacity={dim ? 0.08 : 0.72}
                    stroke={col}
                    strokeOpacity={dim ? 0.15 : 0.9}
                    onMouseEnter={() => setHover(p)}
                    onMouseLeave={() => setHover(null)}
                    style={{ cursor: 'pointer' }}
                  />
                </a>
              )
            })}
          </svg>

          {hover && (
            <div className="absolute top-3 right-3 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs pointer-events-none">
              <div className="font-semibold">{hover.name}</div>
              <div className="text-gray-300">{hover.category} · cluster {hover.cluster_id}</div>
              <div className="mt-1">final {hover.final} · cluster Δ {hover.cluster_momentum.toFixed(1)}</div>
              {hover.cluster_label && <div className="mt-1 text-gray-300 italic">{hover.cluster_label}</div>}
            </div>
          )}
        </div>

        {/* 클러스터 모멘텀 보드 */}
        <div className="flex-1 min-w-[280px]">
          <h3 className="text-sm font-semibold mb-2">클러스터 모멘텀 보드</h3>
          <p className="text-xs text-gray-500 mb-3">
            모멘텀 = 구성 SKU final_score 7일 Δ 평균. 양수 = 묶음 단위 상승세.
          </p>
          <div className="space-y-1">
            {clusters.length === 0 && (
              <div className="text-xs text-gray-400">아직 클러스터 없음.</div>
            )}
            {clusters.map((c) => {
              const active = highlight === c.id
              return (
                <button
                  key={c.id}
                  onClick={() => setHighlight(active ? null : c.id)}
                  className={`w-full text-left rounded border px-2 py-1.5 transition-colors ${
                    active ? 'border-black bg-black/5' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: colorFor(c.id) }}
                    />
                    <span className="text-xs font-mono text-gray-400 w-6 flex-shrink-0">
                      {c.id < 0 ? 'n/a' : `#${c.id}`}
                    </span>
                    <span className="text-sm truncate flex-1">{c.label}</span>
                    <span
                      className={`text-xs font-mono flex-shrink-0 ${
                        c.momentum > 1 ? 'text-emerald-600 font-bold' :
                        c.momentum < -1 ? 'text-red-500' : 'text-gray-500'
                      }`}
                    >
                      {c.momentum > 0 ? '+' : ''}{c.momentum.toFixed(1)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 flex gap-2">
                    <span>{c.size} SKU</span>
                    <span>·</span>
                    <span>avg final {c.avgFinal}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
