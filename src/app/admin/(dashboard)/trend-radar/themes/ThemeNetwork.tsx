'use client'

interface Edge {
  a: string
  b: string
  w: number // 동조 강도 0~1 (corr) 또는 정규화된 co-occurrence
}

/**
 * 테마 구성 키워드의 동조 강도 네트워크 그래프.
 * 의존성 없이 SVG 원형 레이아웃 + 엣지 굵기 = 상관 강도.
 */
export default function ThemeNetwork({
  nodes,
  edges,
  size = 240,
}: {
  nodes: string[]
  edges: Edge[]
  size?: number
}) {
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 36
  const n = Math.max(nodes.length, 1)

  // 원형 배치 좌표
  const pos = new Map<string, { x: number; y: number }>()
  nodes.forEach((kw, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    pos.set(kw, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
  })

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
      {/* 엣지 */}
      {edges.map((e, i) => {
        const pa = pos.get(e.a)
        const pb = pos.get(e.b)
        if (!pa || !pb) return null
        const strength = Math.max(0, Math.min(1, e.w))
        return (
          <line
            key={i}
            x1={pa.x}
            y1={pa.y}
            x2={pb.x}
            y2={pb.y}
            stroke="#34d399"
            strokeOpacity={0.25 + strength * 0.6}
            strokeWidth={0.5 + strength * 3}
          />
        )
      })}
      {/* 노드 */}
      {nodes.map((kw) => {
        const p = pos.get(kw)!
        return (
          <g key={kw}>
            <circle cx={p.x} cy={p.y} r={5} fill="#059669" />
            <text
              x={p.x}
              y={p.y - 9}
              textAnchor="middle"
              className="fill-gray-700"
              style={{ fontSize: 10 }}
            >
              {kw.length > 8 ? kw.slice(0, 8) + '…' : kw}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
