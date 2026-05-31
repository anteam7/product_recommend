'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { FrontierNode } from './pareto'
import { frontier2D } from './pareto'

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function ParetoFrontier({ nodes }: { nodes: FrontierNode[] }) {
  const [hover, setHover] = useState<FrontierNode | null>(null)
  const [cat, setCat] = useState<string>('all')

  const categories = useMemo(() => {
    const set = new Set<string>()
    nodes.forEach((n) => set.add(n.category))
    return ['all', ...Array.from(set).sort()]
  }, [nodes])

  const view = useMemo(
    () => (cat === 'all' ? nodes : nodes.filter((n) => n.category === cat)),
    [nodes, cat],
  )

  const frontierPts = useMemo(() => frontier2D(view), [view])

  const W = 720
  const H = 480
  const PAD = 50
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.max(3, Math.sqrt(Math.max(50, v * 4) / Math.PI) * 1.2)

  // 프론티어 라인 polyline 좌표 (x 오름차순 staircase)
  const linePoints = frontierPts.map((p) => `${xScale(p.x)},${yScale(p.y)}`).join(' ')

  const layer1 = view.filter((n) => n.layer === 1).sort((a, b) => b.final - a.final)
  const dominated = view.filter((n) => n.layer > 1).sort((a, b) => b.dominatedByCount - a.dominatedByCount)

  return (
    <div className="rounded border border-gray-200 p-4">
      {/* 카테고리 토글 */}
      <div className="mb-3 flex flex-wrap gap-1 text-xs">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`px-2 py-1 rounded border ${
              cat === c
                ? 'bg-black text-white border-black'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            competition (→ 경쟁 약함)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            trend (↑ 트렌드 강함)
          </text>

          {/* 프론티어 라인 (2D 투영 상단-우측 경계) */}
          {frontierPts.length >= 2 && (
            <polyline points={linePoints} fill="none" stroke="#0ea5e9" strokeWidth={2} strokeDasharray="4,3" opacity={0.8} />
          )}

          {/* dominated 후보 먼저 (회색, 뒤) */}
          {view
            .filter((n) => n.layer > 1)
            .map((n) => (
              <a key={n.id} href={`/admin/trend-radar/products/${n.id}`}>
                <circle
                  cx={xScale(n.competition)}
                  cy={yScale(n.trend)}
                  r={rScale(n.commerce)}
                  fill="#9ca3af"
                  fillOpacity={n.layer === 2 ? 0.28 : 0.16}
                  stroke="#9ca3af"
                  strokeOpacity={0.4}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            ))}

          {/* 비지배(프론티어) 후보 (컬러, 앞) */}
          {view
            .filter((n) => n.layer === 1)
            .map((n) => (
              <a key={n.id} href={`/admin/trend-radar/products/${n.id}`}>
                <circle
                  cx={xScale(n.competition)}
                  cy={yScale(n.trend)}
                  r={rScale(n.commerce)}
                  fill={CATEGORY_COLORS[n.category] ?? '#6b7280'}
                  fillOpacity={0.7}
                  stroke="#0ea5e9"
                  strokeWidth={1.5}
                  strokeOpacity={0.95}
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            ))}
        </svg>

        {/* hover tooltip */}
        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>
              {hover.layer === 1 ? (
                <span className="text-sky-300">★ 비지배 프론티어 (레이어 1)</span>
              ) : (
                <span className="text-gray-300">레이어 {hover.layer} · {hover.dominatedByCount}개 후보에 밀림</span>
              )}
            </div>
            <div className="mt-1">
              trend {hover.trend} · commerce {hover.commerce} · supplier {hover.supplier} · comp {hover.competition}
            </div>
            {hover.dominator && (
              <div className="mt-1 text-amber-300">
                지배자: {hover.dominator.name} (final {hover.dominator.final})
              </div>
            )}
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs items-center">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-sky-500" style={{ background: '#10b981' }} />
          비지배(레이어 1) — 작업 큐 후보
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full bg-gray-400 opacity-40" />
          dominated — 더 나은 대안 존재
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-6 border-t-2 border-dashed border-sky-500" />
          프론티어 라인
        </span>
      </div>

      {/* 비지배 집합 리스트 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          비지배 프론티어 (레이어 1) — {layer1.length}개
        </h3>
        <p className="text-xs text-gray-500 mb-2">
          어느 후보에도 전 축에서 밀리지 않는 집합. 한정된 등록 슬롯은 여기서 고른다.
        </p>
        <div className="space-y-1 text-sm">
          {layer1.map((n) => (
            <Link
              key={n.id}
              href={`/admin/trend-radar/products/${n.id}`}
              className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50"
            >
              <span className="font-mono text-gray-500 w-8 text-right">{n.final}</span>
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: CATEGORY_COLORS[n.category] ?? '#6b7280' }}
              />
              <span>{n.name}</span>
            </Link>
          ))}
          {layer1.length === 0 && <div className="text-gray-400 text-xs">후보 없음.</div>}
        </div>
      </div>

      {/* dominated 리스트 + 지배자 링크 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          탈락(dominated) — {dominated.length}개
        </h3>
        <p className="text-xs text-gray-500 mb-2">
          전 축에서 더 나은 대안이 명백히 존재. 쫓을 이유 없음 → 작업 큐 제외.
        </p>
        <div className="space-y-1 text-sm max-h-80 overflow-y-auto">
          {dominated.map((n) => (
            <div key={n.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 text-gray-500">
              <span className="font-mono w-8 text-right">{n.final}</span>
              <Link href={`/admin/trend-radar/products/${n.id}`} className="line-through hover:no-underline">
                {n.name}
              </Link>
              {n.dominator && (
                <span className="text-xs text-gray-400">
                  →{' '}
                  <Link
                    href={`/admin/trend-radar/products/${n.dominator.id}`}
                    className="text-amber-600 hover:underline"
                  >
                    {n.dominator.name}
                  </Link>
                  {' '}에게 모든 면에서 밀림
                </span>
              )}
            </div>
          ))}
          {dominated.length === 0 && <div className="text-gray-400 text-xs">탈락 후보 없음.</div>}
        </div>
      </div>
    </div>
  )
}
