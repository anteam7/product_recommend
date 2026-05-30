'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

export interface TNode {
  id: string
  name: string
  value: number // 수요 규모 (자식 합)
  opp: number // 평균 기회도 0~100
  isLeaf: boolean
  children?: TNode[]
}

export interface CoverageEntry {
  top: string
  total: number
  covered: number
  value: number
}

interface Tile extends TNode {
  x: number
  y: number
  w: number
  h: number
}

// ── 기회도(0~100) → 연녹 → 진녹 색상
function oppColor(opp: number): string {
  const t = Math.max(0, Math.min(1, opp / 100))
  // light #dcfce7 (220,252,231) → deep #166534 (22,101,52)
  const r = Math.round(220 + (22 - 220) * t)
  const g = Math.round(252 + (101 - 252) * t)
  const b = Math.round(231 + (52 - 231) * t)
  return `rgb(${r},${g},${b})`
}

// ── squarified treemap (Bruls et al. 간략판)
function squarify(items: TNode[], x: number, y: number, w: number, h: number): Tile[] {
  const total = items.reduce((s, it) => s + Math.max(it.value, 0.0001), 0)
  if (total <= 0 || items.length === 0) return []
  const scale = (w * h) / total
  const nodes = items.map((it) => ({ node: it, area: Math.max(it.value, 0.0001) * scale }))

  const tiles: Tile[] = []
  let rx = x
  let ry = y
  let rw = w
  let rh = h
  let i = 0

  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0)
    const max = Math.max(...row)
    const min = Math.min(...row)
    const s2 = side * side
    const sum2 = sum * sum
    return Math.max((s2 * max) / sum2, sum2 / (s2 * min))
  }

  while (i < nodes.length) {
    const side = Math.min(rw, rh)
    const row: number[] = []
    let j = i
    while (j < nodes.length) {
      const next = [...row, nodes[j].area]
      if (row.length > 0 && worst(next, side) > worst(row, side)) break
      row.push(nodes[j].area)
      j++
    }
    const rowSum = row.reduce((a, b) => a + b, 0)
    const horizontal = rw >= rh
    const thickness = rowSum / side
    let off = 0
    for (let k = i; k < j; k++) {
      const len = nodes[k].area / thickness
      if (horizontal) {
        tiles.push({ ...nodes[k].node, x: rx, y: ry + off, w: thickness, h: len })
      } else {
        tiles.push({ ...nodes[k].node, x: rx + off, y: ry, w: len, h: thickness })
      }
      off += len
    }
    if (horizontal) {
      rx += thickness
      rw -= thickness
    } else {
      ry += thickness
      rh -= thickness
    }
    i = j
  }
  return tiles
}

export default function OpportunityTreemap({
  roots,
  coverage,
}: {
  roots: TNode[]
  coverage: CoverageEntry[]
}) {
  // 드릴다운 경로 (node 들). 빈 배열 = 최상위(category_top)
  const [path, setPath] = useState<TNode[]>([])
  const [hover, setHover] = useState<Tile | null>(null)

  const current = path.length === 0 ? roots : path[path.length - 1].children ?? []

  const W = 880
  const H = 520
  const tiles = useMemo(() => squarify(current, 0, 0, W, H), [current])

  const gaps = coverage
    .filter((c) => c.covered === 0 && c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)

  const onTileClick = (t: Tile) => {
    if (t.isLeaf) return // 라우팅은 <a> 가 담당
    if (t.children && t.children.length > 0) setPath([...path, t])
  }

  return (
    <div className="rounded border border-gray-200 p-4">
      {/* breadcrumb */}
      <div className="mb-3 flex items-center gap-1 text-sm">
        <button
          onClick={() => setPath([])}
          className={`px-2 py-0.5 rounded hover:bg-gray-100 ${path.length === 0 ? 'font-semibold' : 'text-gray-500'}`}
        >
          전체
        </button>
        {path.map((n, idx) => (
          <span key={n.id} className="flex items-center gap-1">
            <span className="text-gray-300">/</span>
            <button
              onClick={() => setPath(path.slice(0, idx + 1))}
              className={`px-2 py-0.5 rounded hover:bg-gray-100 ${idx === path.length - 1 ? 'font-semibold' : 'text-gray-500'}`}
            >
              {n.name}
            </button>
          </span>
        ))}
        <span className="ml-auto text-xs text-gray-400">
          면적 = 수요 규모 · 색 = 기회도(진녹↑) · 타일 클릭 = 드릴다운
        </span>
      </div>

      <div className="relative">
        <svg width={W} height={H} className="block mx-auto rounded bg-gray-50" style={{ maxWidth: '100%' }}>
          {tiles.map((t) => {
            const fill = oppColor(t.opp)
            const labelFits = t.w > 46 && t.h > 22
            const dark = t.opp > 55
            const body = (
              <g
                onMouseEnter={() => setHover(t)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onTileClick(t)}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  x={t.x + 1}
                  y={t.y + 1}
                  width={Math.max(0, t.w - 2)}
                  height={Math.max(0, t.h - 2)}
                  fill={fill}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  rx={3}
                />
                {labelFits && (
                  <text
                    x={t.x + 7}
                    y={t.y + 16}
                    fontSize="11"
                    fill={dark ? '#f0fdf4' : '#14532d'}
                    fontWeight={t.isLeaf ? 400 : 600}
                  >
                    {t.name.length > Math.floor(t.w / 7) ? t.name.slice(0, Math.floor(t.w / 7)) + '…' : t.name}
                  </text>
                )}
                {labelFits && t.h > 36 && (
                  <text x={t.x + 7} y={t.y + 31} fontSize="9.5" fill={dark ? '#bbf7d0' : '#16a34a'}>
                    수요 {Math.round(t.value)} · 기회 {Math.round(t.opp)}
                  </text>
                )}
              </g>
            )
            return t.isLeaf ? (
              <a key={t.id} href={`/admin/trend-radar/products/${t.id}`}>
                {body}
              </a>
            ) : (
              <g key={t.id}>{body}</g>
            )
          })}
        </svg>

        {/* 커버리지 0% 배지 (우상단 오버레이) */}
        {path.length === 0 && gaps.length > 0 && (
          <div className="absolute top-2 right-2 w-60 rounded-lg bg-white/95 shadow-md border border-amber-200 p-3 text-xs">
            <div className="font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
              ⚠️ 미진입 (커버리지 0%)
            </div>
            <div className="space-y-1">
              {gaps.map((g) => (
                <div key={g.top} className="flex items-center justify-between gap-2">
                  <span className="truncate text-gray-700">{g.top}</span>
                  <span className="font-mono text-amber-600 shrink-0">수요 {Math.round(g.value)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[10px] text-gray-400 leading-snug">
              내 쿠팡 카탈로그에 해당 상품명이 없는 카테고리. 수요는 큰데 미진입.
            </div>
          </div>
        )}

        {/* hover tooltip */}
        {hover && (
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>
              수요 {Math.round(hover.value)} · 기회도 {Math.round(hover.opp)}
              {hover.isLeaf ? ' · 클릭→상세' : ` · 하위 ${hover.children?.length ?? 0}개`}
            </div>
          </div>
        )}
      </div>

      {/* 색상 범례 */}
      <div className="mt-4 flex items-center gap-3 text-xs text-gray-500">
        <span>기회도 낮음</span>
        <span
          className="inline-block h-3 w-40 rounded"
          style={{ background: 'linear-gradient(90deg, rgb(220,252,231), rgb(22,101,52))' }}
        />
        <span>높음</span>
        <Link href="/admin/trend-radar/opportunity" className="ml-auto underline hover:text-black">
          → 산점도(Opportunity Matrix)
        </Link>
      </div>
    </div>
  )
}
