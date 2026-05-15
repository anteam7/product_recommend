'use client'
import Link from 'next/link'
import { useState } from 'react'

interface Row {
  id: string
  name: string
  category: string
  x: number
  y: number
  size: number
  final: number
  supplier: number
  tHalf: number | null
  ciLow: number | null
  ciHigh: number | null
  hlConfidence: 'high' | 'mid' | 'low' | null
  hlAnalogCount: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

type SortMode = 'final' | 'tHalfAsc' | 'tHalfDesc'
type HalflifeFilter = 'all' | 'safe' | 'risk'

export default function OpportunityScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const [sort, setSort] = useState<SortMode>('final')
  const [hlFilter, setHlFilter] = useState<HalflifeFilter>('all')
  const W = 720
  const H = 480
  const PAD = 50

  // x, y 0-100 → SVG 좌표
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.sqrt(v / Math.PI) * 1.2

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경 */}
          <rect x={xScale(50)} y={yScale(100)} width={xScale(100) - xScale(50)} height={yScale(50) - yScale(100)} fill="#f0fdf4" />

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

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 핀 후보 (트렌드↑·경쟁↓)
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.x)}
                cy={yScale(r.y)}
                r={rScale(r.size)}
                fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                fillOpacity={0.55}
                stroke={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
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
            <div>category: {hover.category}</div>
            <div>final: {hover.final} · trend: {hover.y} · competition: {hover.x} · supplier: {hover.supplier}</div>
            <div className="mt-1 pt-1 border-t border-white/20">
              T½: {hover.tHalf != null ? `${Number(hover.tHalf).toFixed(1)}주` : '—'}
              {hover.hlConfidence && (
                <span className="ml-1 text-[10px] uppercase opacity-70">({hover.hlConfidence})</span>
              )}
            </div>
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

      {/* 우상단 sub-list */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">핀 후보 (trend≥60 + competition≥60)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => r.y >= 60 && r.x >= 60)
            .sort((a, b) => b.final - a.final)
            .slice(0, 10)
            .map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="block px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="font-mono text-gray-500 mr-2">{r.final}</span>
                {r.name}
              </Link>
            ))}
          {rows.filter((r) => r.y >= 60 && r.x >= 60).length === 0 && (
            <div className="text-gray-400 text-xs">아직 우상단 후보 없음. 30일 누적 후 자연 등장.</div>
          )}
        </div>
      </div>

      {/* T½ 안전구간 보드 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h3 className="text-sm font-semibold">⏳ 반감기(T½) 안전구간 보드</h3>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-gray-500 mr-1">정렬:</span>
            <button
              onClick={() => setSort('final')}
              className={`px-2 py-0.5 rounded ${sort === 'final' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
            >
              final↓
            </button>
            <button
              onClick={() => setSort('tHalfDesc')}
              className={`px-2 py-0.5 rounded ${sort === 'tHalfDesc' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
            >
              T½↓ (안전)
            </button>
            <button
              onClick={() => setSort('tHalfAsc')}
              className={`px-2 py-0.5 rounded ${sort === 'tHalfAsc' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
            >
              T½↑ (식어가는)
            </button>
            <span className="text-gray-500 ml-3 mr-1">필터:</span>
            <button
              onClick={() => setHlFilter('all')}
              className={`px-2 py-0.5 rounded ${hlFilter === 'all' ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체
            </button>
            <button
              onClick={() => setHlFilter('safe')}
              className={`px-2 py-0.5 rounded ${hlFilter === 'safe' ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              안전 (T½&gt;6주)
            </button>
            <button
              onClick={() => setHlFilter('risk')}
              className={`px-2 py-0.5 rounded ${hlFilter === 'risk' ? 'bg-red-100 text-red-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              위험 (T½≤3주)
            </button>
          </div>
        </div>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-right">final</th>
                <th className="px-3 py-2 text-right">T½ (주)</th>
                <th className="px-3 py-2 text-right">80% CI</th>
                <th className="px-3 py-2 text-center">신뢰도</th>
                <th className="px-3 py-2 text-right">analog</th>
                <th className="px-3 py-2 text-center">권고</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {[...rows]
                .filter((r) => {
                  if (hlFilter === 'safe') return r.tHalf != null && r.tHalf > 6
                  if (hlFilter === 'risk') return r.tHalf != null && r.tHalf <= 3
                  return true
                })
                .sort((a, b) => {
                  if (sort === 'final') return b.final - a.final
                  // null T½ 는 항상 끝으로
                  const av = a.tHalf == null ? (sort === 'tHalfAsc' ? Infinity : -Infinity) : Number(a.tHalf)
                  const bv = b.tHalf == null ? (sort === 'tHalfAsc' ? Infinity : -Infinity) : Number(b.tHalf)
                  return sort === 'tHalfAsc' ? av - bv : bv - av
                })
                .slice(0, 30)
                .map((r) => {
                  const t = r.tHalf
                  const verdict =
                    t == null
                      ? { label: '예측 없음', cls: 'text-gray-400' }
                      : t <= 3
                        ? { label: '⚠ 진입 비권장', cls: 'text-red-700 font-semibold' }
                        : t <= 6
                          ? { label: '소량 진입', cls: 'text-amber-700' }
                          : { label: '정상 진입', cls: 'text-emerald-700' }
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-1">
                        <Link href={`/admin/trend-radar/products/${r.id}`} className="hover:underline">
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-3 py-1 text-right font-mono">{r.final}</td>
                      <td className="px-3 py-1 text-right font-mono font-bold">
                        {t != null ? Number(t).toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-1 text-right font-mono text-gray-500">
                        {r.ciLow != null && r.ciHigh != null
                          ? `${Number(r.ciLow).toFixed(1)}~${Number(r.ciHigh).toFixed(1)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-1 text-center text-[10px] uppercase">
                        {r.hlConfidence ?? '—'}
                      </td>
                      <td className="px-3 py-1 text-right font-mono text-gray-500">{r.hlAnalogCount}</td>
                      <td className={`px-3 py-1 text-center text-xs ${verdict.cls}`}>{verdict.label}</td>
                    </tr>
                  )
                })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                    데이터 없음.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-gray-500 mt-2">
          method=cosine_analog_v1 · 초기 4주 final_score 벡터 vs 종료 트렌드 풀 cosine≥0.85 매칭 · T½ = analog 분포 중앙값 · CI = 10·90 백분위
        </p>
      </div>
    </div>
  )
}
