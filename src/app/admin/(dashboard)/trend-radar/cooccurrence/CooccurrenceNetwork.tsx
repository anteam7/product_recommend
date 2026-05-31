'use client'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

export interface NetNode {
  id: string
  name: string
  category: string
  final: number
  sourced: boolean
}
export interface NetEdge {
  a: string
  b: string
  docCount: number
  breadth: number
  pmi: number
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
  x: number
  y: number
  vx: number
  vy: number
}

const W = 820
const H = 560

/** 결정적 force-directed 레이아웃 (고정 반복 후 정지 — 연속 애니메이션 X) */
function layout(nodes: NetNode[], edges: NetEdge[]): Map<string, Sim> {
  const sims = new Map<string, Sim>()
  const n = nodes.length
  // 시드 배치: 원형 (결정적)
  nodes.forEach((node, i) => {
    const angle = (i / Math.max(n, 1)) * Math.PI * 2
    const radius = 180 + (i % 5) * 22
    sims.set(node.id, {
      id: node.id,
      x: W / 2 + Math.cos(angle) * radius,
      y: H / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    })
  })

  const adj = edges.filter((e) => sims.has(e.a) && sims.has(e.b))
  const maxDoc = Math.max(1, ...edges.map((e) => e.docCount))

  const ITER = 220
  for (let it = 0; it < ITER; it++) {
    const k = 1 - it / ITER // cooling
    // 반발 (모든 쌍 — n 작다고 가정, cooccurrence 노드는 수백 이하)
    const arr = [...sims.values()]
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const p = arr[i]
        const q = arr[j]
        let dx = p.x - q.x
        let dy = p.y - q.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) d2 = 1
        const rep = 5200 / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * rep
        const fy = (dy / d) * rep
        p.vx += fx; p.vy += fy
        q.vx -= fx; q.vy -= fy
      }
    }
    // 인력 (엣지)
    for (const e of adj) {
      const p = sims.get(e.a)!
      const q = sims.get(e.b)!
      const dx = q.x - p.x
      const dy = q.y - p.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const strength = (e.docCount / maxDoc) * 0.06 + 0.008
      const fx = dx * strength
      const fy = dy * strength
      p.vx += fx; p.vy += fy
      q.vx -= fx; q.vy -= fy
    }
    // 중심 인력 + 적용
    for (const p of arr) {
      p.vx += (W / 2 - p.x) * 0.004
      p.vy += (H / 2 - p.y) * 0.004
      p.x += p.vx * 0.5 * k
      p.y += p.vy * 0.5 * k
      p.vx *= 0.85
      p.vy *= 0.85
      p.x = Math.max(30, Math.min(W - 30, p.x))
      p.y = Math.max(30, Math.min(H - 30, p.y))
    }
  }
  return sims
}

export default function CooccurrenceNetwork({ nodes, edges }: { nodes: NetNode[]; edges: NetEdge[] }) {
  const [hover, setHover] = useState<NetNode | null>(null)
  const [pos, setPos] = useState<Map<string, Sim> | null>(null)
  const computed = useRef(false)

  // 레이아웃은 마운트 후 1회만 (결정적이라 재계산 불필요)
  useEffect(() => {
    if (computed.current) return
    computed.current = true
    setPos(layout(nodes, edges))
  }, [nodes, edges])

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const maxDoc = useMemo(() => Math.max(1, ...edges.map((e) => e.docCount)), [edges])
  const rScale = (final: number) => 5 + Math.sqrt(Math.max(final, 1)) * 1.4

  // (2) 인접수요 신규 발굴 큐: sourced 상품과 강하게 연결됐지만 미소싱인 노드
  const adjacencyQueue = useMemo(() => {
    const score = new Map<string, { node: NetNode; strength: number; anchor: string }>()
    for (const e of edges) {
      const na = nodeById.get(e.a)
      const nb = nodeById.get(e.b)
      if (!na || !nb) continue
      const pairs: [NetNode, NetNode][] = [
        [na, nb],
        [nb, na],
      ]
      for (const [src, other] of pairs) {
        if (src.sourced && !other.sourced) {
          const prev = score.get(other.id)
          const strength = e.docCount * Math.max(1, e.pmi > 0 ? e.pmi : 0.5)
          if (!prev || strength > prev.strength) {
            score.set(other.id, { node: other, strength, anchor: src.name })
          }
        }
      }
    }
    return [...score.values()].sort((a, b) => b.strength - a.strength).slice(0, 12)
  }, [edges, nodeById])

  // (1) 번들 후보: 강하게 묶인 엣지 상위
  const bundleEdges = useMemo(
    () =>
      [...edges]
        .filter((e) => nodeById.has(e.a) && nodeById.has(e.b))
        .sort((a, b) => b.docCount - a.docCount || b.pmi - a.pmi)
        .slice(0, 12),
    [edges, nodeById],
  )

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto bg-gray-50/40 rounded" style={{ overflow: 'visible' }}>
          {/* 엣지 */}
          {pos &&
            edges.map((e, i) => {
              const p = pos.get(e.a)
              const q = pos.get(e.b)
              if (!p || !q) return null
              const w = 0.4 + (e.docCount / maxDoc) * 3.2
              const op = 0.15 + (e.docCount / maxDoc) * 0.45
              return (
                <line
                  key={i}
                  x1={p.x}
                  y1={p.y}
                  x2={q.x}
                  y2={q.y}
                  stroke="#94a3b8"
                  strokeWidth={w}
                  strokeOpacity={op}
                />
              )
            })}
          {/* 노드 */}
          {pos &&
            nodes.map((nd) => {
              const p = pos.get(nd.id)
              if (!p) return null
              const color = CATEGORY_COLORS[nd.category] ?? '#6b7280'
              return (
                <a key={nd.id} href={`/admin/trend-radar/products/${nd.id}`}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={rScale(nd.final)}
                    fill={color}
                    fillOpacity={nd.sourced ? 0.85 : 0.5}
                    stroke={nd.sourced ? '#111827' : color}
                    strokeWidth={nd.sourced ? 2 : 1}
                    strokeOpacity={0.9}
                    onMouseEnter={() => setHover(nd)}
                    onMouseLeave={() => setHover(null)}
                    style={{ cursor: 'pointer' }}
                  />
                </a>
              )
            })}
        </svg>

        {!pos && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
            네트워크 배치 계산 중…
          </div>
        )}

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>
              final: {hover.final} · {hover.sourced ? '소싱중 (ggsan 연결)' : '미소싱'}
            </div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
        <span className="flex items-center gap-1 ml-2">
          <span className="inline-block w-3 h-3 rounded-full bg-gray-400" style={{ border: '2px solid #111827' }} />
          소싱중(테두리 진함)
        </span>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 border-t border-gray-200 pt-4">
        {/* (1) 번들 구성 후보 */}
        <div>
          <h3 className="text-sm font-semibold mb-2">🧷 번들 구성 후보 (강하게 묶인 쌍)</h3>
          <div className="space-y-1 text-sm">
            {bundleEdges.map((e, i) => {
              const na = nodeById.get(e.a)!
              const nb = nodeById.get(e.b)!
              return (
                <div key={i} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50">
                  <span className="font-mono text-gray-400 w-8 shrink-0">{e.docCount}</span>
                  <Link href={`/admin/trend-radar/products/${e.a}`} className="hover:underline">
                    {na.name}
                  </Link>
                  <span className="text-gray-400">+</span>
                  <Link href={`/admin/trend-radar/products/${e.b}`} className="hover:underline">
                    {nb.name}
                  </Link>
                  <span className="ml-auto text-[11px] text-gray-400 shrink-0">
                    pmi {e.pmi} · {e.breadth}ch
                  </span>
                </div>
              )
            })}
            {bundleEdges.length === 0 && (
              <div className="text-gray-400 text-xs">아직 묶인 쌍 없음.</div>
            )}
          </div>
        </div>

        {/* (2) 인접수요 신규 발굴 큐 */}
        <div>
          <h3 className="text-sm font-semibold mb-2">🛰️ 인접수요 신규 발굴 큐 (소싱상품과 강결합·미소싱)</h3>
          <div className="space-y-1 text-sm">
            {adjacencyQueue.map((q) => (
              <Link
                key={q.node.id}
                href={`/admin/trend-radar/products/${q.node.id}`}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="font-mono text-gray-400 w-10 shrink-0">{Math.round(q.strength)}</span>
                <span className="font-medium">{q.node.name}</span>
                <span className="ml-auto text-[11px] text-gray-400 shrink-0">← {q.anchor}</span>
              </Link>
            ))}
            {adjacencyQueue.length === 0 && (
              <div className="text-gray-400 text-xs">
                소싱(supplier) 연결 상품이 아직 없거나, 미소싱 인접 노드가 없음.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
