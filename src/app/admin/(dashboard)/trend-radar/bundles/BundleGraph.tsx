'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

export interface Pair {
  a: string
  b: string
  lift: number
  joint: number
  aGgsan: boolean
  bGgsan: boolean
}

interface Node {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  ggsan: boolean
  degree: number
}

interface Edge {
  source: string
  target: string
  lift: number
  joint: number
}

const W = 720
const H = 480
const ITERATIONS = 220
const LINK_DIST = 110
const REPULSION = 1500
const CENTER_PULL = 0.012

function layout(pairs: Pair[]): { nodes: Node[]; edges: Edge[] } {
  const nodeMap = new Map<string, Node>()
  const edges: Edge[] = []

  for (const p of pairs) {
    if (!nodeMap.has(p.a)) {
      nodeMap.set(p.a, {
        id: p.a,
        x: W / 2 + (Math.random() - 0.5) * 200,
        y: H / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        ggsan: p.aGgsan,
        degree: 0,
      })
    } else if (p.aGgsan) {
      nodeMap.get(p.a)!.ggsan = true
    }
    if (!nodeMap.has(p.b)) {
      nodeMap.set(p.b, {
        id: p.b,
        x: W / 2 + (Math.random() - 0.5) * 200,
        y: H / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        ggsan: p.bGgsan,
        degree: 0,
      })
    } else if (p.bGgsan) {
      nodeMap.get(p.b)!.ggsan = true
    }
    nodeMap.get(p.a)!.degree += 1
    nodeMap.get(p.b)!.degree += 1
    edges.push({ source: p.a, target: p.b, lift: p.lift, joint: p.joint })
  }

  const nodes = Array.from(nodeMap.values())

  // Simple force simulation
  for (let it = 0; it < ITERATIONS; it++) {
    const damping = 0.85
    // repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist2 = dx * dx + dy * dy
        if (dist2 < 1) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          dist2 = 1
        }
        const force = REPULSION / dist2
        const dist = Math.sqrt(dist2)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
    }
    // springs
    for (const e of edges) {
      const a = nodeMap.get(e.source)!
      const b = nodeMap.get(e.target)!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const targetDist = LINK_DIST / Math.max(1, Math.log2(e.lift + 1))
      const diff = dist - targetDist
      const k = 0.04
      const fx = (dx / dist) * diff * k
      const fy = (dy / dist) * diff * k
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
    // center gravity + integrate
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * CENTER_PULL
      n.vy += (H / 2 - n.y) * CENTER_PULL
      n.vx *= damping
      n.vy *= damping
      n.x += n.vx
      n.y += n.vy
      // clamp
      n.x = Math.max(30, Math.min(W - 30, n.x))
      n.y = Math.max(30, Math.min(H - 30, n.y))
    }
  }

  return { nodes, edges }
}

export default function BundleGraph({ pairs }: { pairs: Pair[] }) {
  const { nodes, edges } = useMemo(() => layout(pairs), [pairs])
  const [hover, setHover] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const maxLift = Math.max(...edges.map((e) => e.lift), 1)
  const maxDeg = Math.max(...nodes.map((n) => n.degree), 1)

  const highlightSet = useMemo(() => {
    if (!hover) return new Set<string>()
    const s = new Set<string>([hover])
    for (const e of edges) {
      if (e.source === hover) s.add(e.target)
      if (e.target === hover) s.add(e.source)
    }
    return s
  }, [hover, edges])

  return (
    <div className="relative">
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
        {/* edges */}
        {edges.map((e, i) => {
          const a = nodes.find((n) => n.id === e.source)
          const b = nodes.find((n) => n.id === e.target)
          if (!a || !b) return null
          const isHL = hover ? highlightSet.has(e.source) && highlightSet.has(e.target) : false
          const dimmed = hover && !isHL
          const w = 0.6 + (e.lift / maxLift) * 3.5
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={isHL ? '#0ea5e9' : '#94a3b8'}
              strokeOpacity={dimmed ? 0.1 : isHL ? 0.85 : 0.45}
              strokeWidth={w}
            />
          )
        })}
        {/* nodes */}
        {nodes.map((n) => {
          const r = 8 + (n.degree / maxDeg) * 14
          const isHL = hover ? highlightSet.has(n.id) : false
          const dimmed = hover && !isHL
          const fill = n.ggsan ? '#10b981' : '#64748b'
          return (
            <g
              key={n.id}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={fill}
                fillOpacity={dimmed ? 0.2 : 0.85}
                stroke={isHL ? '#0f172a' : '#fff'}
                strokeWidth={isHL ? 2 : 1.5}
              />
              <text
                x={n.x}
                y={n.y + r + 12}
                textAnchor="middle"
                fontSize="11"
                fill={dimmed ? '#cbd5e1' : '#0f172a'}
                fontWeight={isHL ? 'bold' : 'normal'}
              >
                {n.id.length > 14 ? n.id.slice(0, 13) + '…' : n.id}
              </text>
            </g>
          )
        })}
      </svg>
      {hover && (
        <div className="absolute right-2 top-2 max-w-xs rounded border border-gray-200 bg-white p-2 text-xs shadow">
          <div className="font-semibold">{hover}</div>
          <div className="text-gray-500">
            연결 {nodes.find((n) => n.id === hover)?.degree ?? 0}개 ·
            {nodes.find((n) => n.id === hover)?.ggsan ? ' ggsan 매칭' : ' ggsan 매칭 없음'}
          </div>
        </div>
      )}
    </div>
  )
}
