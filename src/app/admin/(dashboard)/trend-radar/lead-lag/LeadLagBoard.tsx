'use client'

import { useMemo, useState } from 'react'

export interface EdgeRow {
  src: string
  dst: string
  srcCategory: string | null
  dstCategory: string | null
  lagDays: number
  corr: number
  pValue: number | null
  sampleN: number
  srcLastAt: string | null
  dstLastAt: string | null
}

export interface DailyPoint {
  day: string
  value: number
}

interface NodePos {
  id: string
  category: string | null
  x: number
  y: number
}

const CATEGORY_COLORS: Record<string, string> = {
  쇼핑: '#3b82f6',
  엔터: '#a78bfa',
  푸드: '#f59e0b',
  라이프: '#10b981',
  정치: '#ef4444',
  기술: '#06b6d4',
  unknown: '#94a3b8',
}

function colorOf(cat: string | null): string {
  if (!cat) return CATEGORY_COLORS.unknown
  for (const k of Object.keys(CATEGORY_COLORS)) {
    if (cat.includes(k)) return CATEGORY_COLORS[k]
  }
  return CATEGORY_COLORS.unknown
}

// 단순 force-like 레이아웃: ring 으로 키워드를 배치하고, edge 의 코드 진폭으로 r 미세 조정.
function layoutNodes(ids: string[], idCategory: Map<string, string | null>): NodePos[] {
  const W = 960
  const H = 600
  const cx = W / 2
  const cy = H / 2
  const r = Math.min(W, H) * 0.42
  const nodes: NodePos[] = []
  // 카테고리별로 그룹화 (같은 카테고리는 인접)
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const c = idCategory.get(id) ?? 'unknown'
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c)!.push(id)
  }
  const ordered: { id: string; cat: string | null }[] = []
  for (const [c, arr] of groups) {
    for (const id of arr) ordered.push({ id, cat: c === 'unknown' ? null : c })
  }
  const total = ordered.length || 1
  for (let i = 0; i < ordered.length; i++) {
    const a = (i / total) * Math.PI * 2 - Math.PI / 2
    nodes.push({
      id: ordered[i].id,
      category: ordered[i].cat,
      x: cx + Math.cos(a) * r,
      y: cy + Math.sin(a) * r,
    })
  }
  return nodes
}

export default function LeadLagBoard({
  rows,
  series,
}: {
  rows: EdgeRow[]
  series: Record<string, DailyPoint[]>
}) {
  const [minLag, setMinLag] = useState(1)
  const [maxLag, setMaxLag] = useState(21)
  const [minCorr, setMinCorr] = useState(0.55)
  const [activeOnly, setActiveOnly] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const now = Date.now()
  const ACTIVE_MS = 30 * 86_400_000

  const filtered = useMemo(() => {
    return rows.filter((e) => {
      if (e.lagDays < minLag || e.lagDays > maxLag) return false
      if (Math.abs(e.corr) < minCorr) return false
      if (activeOnly) {
        const ts = Math.max(
          e.srcLastAt ? new Date(e.srcLastAt).getTime() : 0,
          e.dstLastAt ? new Date(e.dstLastAt).getTime() : 0,
        )
        if (!ts || now - ts > ACTIVE_MS) return false
      }
      if (categoryFilter !== 'all') {
        const sc = e.srcCategory ?? ''
        const dc = e.dstCategory ?? ''
        if (!sc.includes(categoryFilter) && !dc.includes(categoryFilter)) return false
      }
      return true
    })
  }, [rows, minLag, maxLag, minCorr, activeOnly, categoryFilter, now])

  // edge → node 셋
  const { nodes, nodeMap } = useMemo(() => {
    const ids = new Set<string>()
    const cat = new Map<string, string | null>()
    for (const e of filtered) {
      ids.add(e.src)
      ids.add(e.dst)
      if (!cat.has(e.src)) cat.set(e.src, e.srcCategory)
      if (!cat.has(e.dst)) cat.set(e.dst, e.dstCategory)
    }
    const arr = Array.from(ids)
    const nodes = layoutNodes(arr, cat)
    const nodeMap = new Map<string, NodePos>()
    for (const n of nodes) nodeMap.set(n.id, n)
    return { nodes, nodeMap }
  }, [filtered])

  const selected = selectedIdx != null ? filtered[selectedIdx] : null

  const categories = useMemo(() => {
    const s = new Set<string>()
    for (const e of rows) {
      if (e.srcCategory) s.add(e.srcCategory)
      if (e.dstCategory) s.add(e.dstCategory)
    }
    return Array.from(s).sort()
  }, [rows])

  return (
    <div className="space-y-4">
      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 p-3 text-sm">
        <label className="flex items-center gap-2">
          최소 lag
          <input
            type="number"
            min={1}
            max={21}
            value={minLag}
            onChange={(e) => setMinLag(Math.max(1, Math.min(21, Number(e.target.value) || 1)))}
            className="w-16 rounded border px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          최대 lag
          <input
            type="number"
            min={1}
            max={21}
            value={maxLag}
            onChange={(e) => setMaxLag(Math.max(1, Math.min(21, Number(e.target.value) || 21)))}
            className="w-16 rounded border px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          최소 |corr|
          <input
            type="number"
            step={0.05}
            min={0.5}
            max={1}
            value={minCorr}
            onChange={(e) => setMinCorr(Math.max(0.5, Math.min(1, Number(e.target.value) || 0.55)))}
            className="w-20 rounded border px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          카테고리
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded border px-2 py-1"
          >
            <option value="all">전체</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
          />
          최근 30일 활성 edge 만
        </label>
        <span className="ml-auto text-xs text-gray-500">
          {filtered.length} edges / {nodes.length} keywords
        </span>
      </div>

      {/* 그래프 */}
      <div className="rounded border border-gray-200 p-3">
        <svg width="100%" viewBox="0 0 960 600" className="block">
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
            </marker>
            <marker
              id="arrow-hl"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#0ea5e9" />
            </marker>
          </defs>

          {/* edges */}
          {filtered.map((e, i) => {
            const a = nodeMap.get(e.src)
            const b = nodeMap.get(e.dst)
            if (!a || !b) return null
            const isSel = selectedIdx === i
            const stroke = isSel ? '#0ea5e9' : e.corr >= 0 ? '#94a3b8' : '#fda4af'
            const w = isSel ? 2.5 : 0.5 + (Math.abs(e.corr) - 0.5) * 4
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeWidth={w}
                strokeOpacity={isSel ? 0.95 : 0.4}
                markerEnd={isSel ? 'url(#arrow-hl)' : 'url(#arrow)'}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedIdx(i)}
              />
            )
          })}

          {/* nodes */}
          {nodes.map((n) => {
            const isTouched =
              selected && (selected.src === n.id || selected.dst === n.id)
            return (
              <g key={n.id}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={isTouched ? 8 : 5}
                  fill={colorOf(n.category)}
                  stroke={isTouched ? '#0ea5e9' : '#fff'}
                  strokeWidth={isTouched ? 2 : 1}
                />
                <text
                  x={n.x}
                  y={n.y - 10}
                  fontSize="10"
                  fill="#1f2937"
                  textAnchor="middle"
                  style={{ pointerEvents: 'none' }}
                >
                  {n.id.length > 12 ? n.id.slice(0, 12) + '…' : n.id}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* 선택된 edge 상세 */}
      {selected && (
        <SelectedEdgePanel edge={selected} series={series} />
      )}

      {/* 전체 edge 리스트 */}
      <div className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">src (선행)</th>
              <th className="px-3 py-2 text-left">→ dst (후행)</th>
              <th className="px-3 py-2 text-right">lag (일)</th>
              <th className="px-3 py-2 text-right">corr</th>
              <th className="px-3 py-2 text-right">n</th>
              <th className="px-3 py-2 text-right">p</th>
              <th className="px-3 py-2 text-left">src cat</th>
              <th className="px-3 py-2 text-left">dst cat</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.slice(0, 200).map((e, i) => (
              <tr
                key={i}
                onClick={() => setSelectedIdx(i)}
                className={`cursor-pointer hover:bg-gray-50 ${
                  selectedIdx === i ? 'bg-sky-50' : ''
                }`}
              >
                <td className="px-3 py-1 font-mono">{e.src}</td>
                <td className="px-3 py-1 font-mono">{e.dst}</td>
                <td className="px-3 py-1 text-right">{e.lagDays}</td>
                <td
                  className={`px-3 py-1 text-right font-mono ${
                    e.corr >= 0 ? 'text-green-700' : 'text-rose-700'
                  }`}
                >
                  {e.corr.toFixed(3)}
                </td>
                <td className="px-3 py-1 text-right">{e.sampleN}</td>
                <td className="px-3 py-1 text-right text-gray-500">
                  {e.pValue != null ? e.pValue.toExponential(1) : '—'}
                </td>
                <td className="px-3 py-1 text-gray-500">{e.srcCategory ?? '—'}</td>
                <td className="px-3 py-1 text-gray-500">{e.dstCategory ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 200 && (
          <div className="px-3 py-2 text-xs text-gray-500">
            상위 200건만 표시 — 필터로 좁혀라.
          </div>
        )}
      </div>
    </div>
  )
}

function SelectedEdgePanel({
  edge,
  series,
}: {
  edge: EdgeRow
  series: Record<string, DailyPoint[]>
}) {
  const srcSeries = series[edge.src] ?? []
  const dstSeries = series[edge.dst] ?? []

  // dst 를 lag 만큼 앞으로 당겨서 오버레이.
  // x축: src 날짜 기준 0..89. dst 의 day 는 src day + lag 으로 매칭.
  const srcByDay = new Map<string, number>()
  for (const p of srcSeries) srcByDay.set(p.day, p.value)
  const dstByDay = new Map<string, number>()
  for (const p of dstSeries) dstByDay.set(p.day, p.value)

  const days = Array.from(new Set([...srcByDay.keys(), ...dstByDay.keys()])).sort()
  const lastDays = days.slice(-90)

  // SVG chart
  const W = 720
  const H = 220
  const PAD_L = 40
  const PAD_R = 20
  const PAD_T = 20
  const PAD_B = 30
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  // 정규화: 0~100 (volume_relative 자체가 0~100)
  const xs = (i: number) => PAD_L + (i / Math.max(1, lastDays.length - 1)) * innerW
  const ys = (v: number) => PAD_T + (1 - v / 100) * innerH

  // shift dst by lag (즉 dst 의 day=src.day+lag 값을 src.day 위치에 그림)
  const lagMs = edge.lagDays * 86_400_000

  const srcPath = lastDays
    .map((d, i) => {
      const v = srcByDay.get(d)
      if (v == null) return null
      return `${i === 0 ? 'M' : 'L'} ${xs(i)} ${ys(v)}`
    })
    .filter(Boolean)
    .join(' ')

  const dstPath = lastDays
    .map((d, i) => {
      const shifted = new Date(new Date(d).getTime() + lagMs).toISOString().slice(0, 10)
      const v = dstByDay.get(shifted)
      if (v == null) return null
      return `${i === 0 ? 'M' : 'L'} ${xs(i)} ${ys(v)}`
    })
    .filter(Boolean)
    .join(' ')

  return (
    <div className="rounded border border-sky-200 bg-sky-50/40 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="text-base font-semibold">
          <span className="font-mono">{edge.src}</span>
          {' 가 '}
          <span className="font-mono">{edge.dst}</span>
          {' 를 평균 '}
          <span className="text-sky-700">{edge.lagDays}일</span>
          {' 선행'}
        </div>
        <div className="ml-auto text-sm text-gray-600">
          corr <span className="font-mono">{edge.corr.toFixed(3)}</span> · n {edge.sampleN}
          {edge.pValue != null && (
            <>
              {' '}
              · p <span className="font-mono">{edge.pValue.toExponential(1)}</span>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 rounded border bg-white">
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line
                x1={PAD_L}
                y1={ys(v)}
                x2={W - PAD_R}
                y2={ys(v)}
                stroke="#e5e7eb"
                strokeDasharray={v % 50 === 0 ? '' : '2,3'}
              />
              <text x={PAD_L - 6} y={ys(v) + 4} fontSize="9" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {/* x ticks: 처음/중간/끝 */}
          {[0, Math.floor(lastDays.length / 2), lastDays.length - 1].map((i) =>
            lastDays[i] ? (
              <text
                key={i}
                x={xs(i)}
                y={H - PAD_B + 14}
                fontSize="9"
                fill="#9ca3af"
                textAnchor="middle"
              >
                {lastDays[i].slice(5)}
              </text>
            ) : null,
          )}

          {srcPath && (
            <path
              d={srcPath}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={1.8}
              strokeLinejoin="round"
            />
          )}
          {dstPath && (
            <path
              d={dstPath}
              fill="none"
              stroke="#f97316"
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeDasharray="4,3"
            />
          )}
        </svg>
      </div>

      <div className="mt-2 flex gap-4 text-xs">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-sky-500"></span>
          {edge.src} (src, 원본)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-orange-500"></span>
          {edge.dst} (dst, {edge.lagDays}일 앞당김)
        </span>
      </div>
    </div>
  )
}
