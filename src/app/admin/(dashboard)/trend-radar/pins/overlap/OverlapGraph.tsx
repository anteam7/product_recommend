'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'

export interface OverlapNode {
  id: string
  label: string
  category: string
}
export interface OverlapPair {
  a: string
  b: string
  score: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

interface Sim {
  id: string
  label: string
  category: string
  x: number
  y: number
  vx: number
  vy: number
}

function edgeColor(score: number): string {
  if (score >= 0.8) return '#dc2626'
  if (score >= 0.7) return '#ea580c'
  return '#ca8a04'
}

export default function OverlapGraph({
  nodes,
  pairs,
  threshold,
}: {
  nodes: OverlapNode[]
  pairs: OverlapPair[]
  threshold: number
}) {
  const W = 720
  const H = 460
  const containerRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [sim, setSim] = useState<Sim[]>(() => seed(nodes, W, H))

  const adjacency = useMemo(() => {
    const m = new Map<string, OverlapPair[]>()
    for (const p of pairs) {
      if (!m.has(p.a)) m.set(p.a, [])
      if (!m.has(p.b)) m.set(p.b, [])
      m.get(p.a)!.push(p)
      m.get(p.b)!.push(p)
    }
    return m
  }, [pairs])

  // Simple force-directed simulation — 120 iterations on mount.
  useEffect(() => {
    let cancelled = false
    const next = seed(nodes, W, H)
    const idIdx = new Map(next.map((n, i) => [n.id, i] as const))

    let frame = 0
    const tick = () => {
      if (cancelled) return
      // Repulsion (Coulomb-like)
      for (let i = 0; i < next.length; i++) {
        for (let j = i + 1; j < next.length; j++) {
          const a = next[i]
          const b = next[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist2 = dx * dx + dy * dy + 0.01
          const force = 2200 / dist2
          const dist = Math.sqrt(dist2)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx += fx
          a.vy += fy
          b.vx -= fx
          b.vy -= fy
        }
      }
      // Edge spring (attractive) — only risk pairs pull
      for (const p of pairs) {
        const ai = idIdx.get(p.a)
        const bi = idIdx.get(p.b)
        if (ai === undefined || bi === undefined) continue
        const a = next[ai]
        const b = next[bi]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
        const target = 110 - 60 * (p.score - threshold) / Math.max(0.4, 1 - threshold)
        const k = 0.04
        const force = (dist - target) * k
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
      // Center gravity
      for (const n of next) {
        n.vx += (W / 2 - n.x) * 0.005
        n.vy += (H / 2 - n.y) * 0.005
      }
      // Integrate + damping + bounds
      for (const n of next) {
        n.vx *= 0.82
        n.vy *= 0.82
        n.x += n.vx
        n.y += n.vy
        if (n.x < 20) n.x = 20
        if (n.x > W - 20) n.x = W - 20
        if (n.y < 20) n.y = 20
        if (n.y > H - 20) n.y = H - 20
      }
      frame++
      if (frame < 120) {
        if (frame % 6 === 0) setSim(next.map((n) => ({ ...n })))
        requestAnimationFrame(tick)
      } else {
        setSim(next.map((n) => ({ ...n })))
      }
    }
    requestAnimationFrame(tick)
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, pairs.length, threshold])

  const posById = useMemo(() => new Map(sim.map((n) => [n.id, n] as const)), [sim])

  return (
    <div ref={containerRef} className="relative" style={{ width: W, maxWidth: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="bg-gray-50 rounded">
        {pairs.map((p) => {
          const a = posById.get(p.a)
          const b = posById.get(p.b)
          if (!a || !b) return null
          const isHover = hover && (hover === p.a || hover === p.b)
          return (
            <line
              key={`${p.a}-${p.b}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={edgeColor(p.score)}
              strokeWidth={1 + (p.score - threshold) * 10}
              strokeOpacity={isHover ? 0.95 : 0.55}
            />
          )
        })}
        {sim.map((n) => {
          const fill = CATEGORY_COLORS[n.category] ?? CATEGORY_COLORS.all
          const risk = (adjacency.get(n.id)?.length ?? 0) > 0
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                r={risk ? 8 : 5}
                fill={fill}
                stroke={risk ? '#dc2626' : '#fff'}
                strokeWidth={risk ? 2 : 1}
              />
              {(hover === n.id || risk) && (
                <text
                  x={10}
                  y={4}
                  fontSize="10"
                  fill="#1f2937"
                  style={{ pointerEvents: 'none' }}
                >
                  {n.label.slice(0, 24)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover && (
        <div className="absolute top-2 right-2 rounded bg-white border border-gray-200 px-2 py-1 text-xs shadow">
          <Link
            href={`/admin/trend-radar/products/${hover}`}
            className="text-blue-700 hover:underline"
          >
            상세 보기 →
          </Link>
        </div>
      )}
    </div>
  )
}

function seed(nodes: OverlapNode[], W: number, H: number): Sim[] {
  const cx = W / 2
  const cy = H / 2
  const r = Math.min(W, H) * 0.35
  return nodes.map((n, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2
    return {
      id: n.id,
      label: n.label,
      category: n.category,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    }
  })
}
