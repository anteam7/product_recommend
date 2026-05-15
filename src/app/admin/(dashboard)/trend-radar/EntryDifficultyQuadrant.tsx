'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface DifficultyRow {
  id: string
  name: string
  category: string
  ad: number       // 0~100 ad_difficulty
  seo: number      // 0~100 seo_barrier
  runway: number   // 0~100 organic_runway
  cpc: number      // 원
  final: number
}

const W = 720
const H = 480
const PAD = 50

function runwayColor(v: number) {
  // 낮음(빨강) → 높음(녹색)
  const ratio = Math.max(0, Math.min(100, v)) / 100
  const r = Math.round(239 - (239 - 16) * ratio)
  const g = Math.round(68 + (185 - 68) * ratio)
  const b = Math.round(68 + (129 - 68) * ratio)
  return `rgb(${r},${g},${b})`
}

export default function EntryDifficultyQuadrant({ rows }: { rows: DifficultyRow[] }) {
  const [hover, setHover] = useState<DifficultyRow | null>(null)

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

  // Pareto front (No-Budget): ad↓ AND seo↓ AND runway↑.
  // ad·seo 모두 작거나 같고, runway 가 같거나 큰 다른 점이 없으면 Pareto.
  const pareto = rows.filter((r) => {
    return !rows.some(
      (o) =>
        o !== r &&
        o.ad <= r.ad &&
        o.seo <= r.seo &&
        o.runway >= r.runway &&
        (o.ad < r.ad || o.seo < r.seo || o.runway > r.runway),
    )
  })

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-800">
          📐 진입난이도 매트릭스{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            X = 광고비 · Y = SEO 진입장벽 · 색상 = 무광고 잠재 트래픽
          </span>
        </h2>
        <span className="text-xs text-gray-500">총 {rows.length}개</span>
      </div>

      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* No-Budget 사분면 배경 (좌하단) */}
          <rect
            x={xScale(0)}
            y={yScale(50)}
            width={xScale(50) - xScale(0)}
            height={yScale(0) - yScale(50)}
            fill="#f0fdf4"
          />

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

          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            ad_difficulty (→ 광고비 비쌈)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            seo_barrier (↑ SERP 진입 어려움)
          </text>

          <text x={xScale(25)} y={yScale(45)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            💸 No-Budget 영역 (광고↓·SEO↓)
          </text>

          {rows.map((r) => {
            const isPareto = pareto.includes(r)
            return (
              <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
                <circle
                  cx={xScale(r.ad)}
                  cy={yScale(r.seo)}
                  r={isPareto ? 8 : 5}
                  fill={runwayColor(r.runway)}
                  fillOpacity={isPareto ? 0.95 : 0.55}
                  stroke={isPareto ? '#111827' : runwayColor(r.runway)}
                  strokeWidth={isPareto ? 2 : 1}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>
              ad: {hover.ad} (≈{hover.cpc.toLocaleString()}원/click) · seo: {hover.seo} · runway: {hover.runway}
            </div>
            <div>final_score: {hover.final}</div>
          </div>
        )}
      </div>

      {/* runway 컬러 범례 */}
      <div className="mt-4 flex items-center gap-3 text-xs text-gray-600">
        <span>organic_runway</span>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: runwayColor(0) }} />
          <span>0</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: runwayColor(50) }} />
          <span>50</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: runwayColor(100) }} />
          <span>100</span>
        </div>
        <span className="ml-auto text-gray-400">Pareto front = 굵은 테두리</span>
      </div>

      {/* No-Budget Pareto 리스트 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          💸 No-Budget Pareto front{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">
            (광고비/SEO 진입장벽 대비 무광고 트래픽이 우세한 상품)
          </span>
        </h3>
        <div className="space-y-1 text-sm">
          {pareto.length === 0 && (
            <div className="text-gray-400 text-xs">아직 Pareto 후보 없음. 누적 후 다시 방문.</div>
          )}
          {pareto
            .slice()
            .sort((a, b) => b.runway - a.runway || a.ad - b.ad)
            .slice(0, 15)
            .map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="grid grid-cols-12 px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="col-span-6 truncate">{r.name}</span>
                <span className="col-span-2 text-right font-mono text-gray-600">
                  {r.cpc.toLocaleString()}원
                </span>
                <span className="col-span-1 text-right font-mono text-gray-500">{r.ad}</span>
                <span className="col-span-1 text-right font-mono text-gray-500">{r.seo}</span>
                <span className="col-span-2 text-right font-mono font-bold" style={{ color: runwayColor(r.runway) }}>
                  ↑ {r.runway}
                </span>
              </Link>
            ))}
        </div>
        <div className="mt-2 grid grid-cols-12 px-2 text-[10px] text-gray-400 uppercase">
          <span className="col-span-6">상품</span>
          <span className="col-span-2 text-right">est. CPC</span>
          <span className="col-span-1 text-right">ad</span>
          <span className="col-span-1 text-right">seo</span>
          <span className="col-span-2 text-right">runway</span>
        </div>
      </div>
    </div>
  )
}
