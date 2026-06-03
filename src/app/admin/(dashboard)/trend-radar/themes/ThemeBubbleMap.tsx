'use client'
import Link from 'next/link'
import { useState } from 'react'
import type { ThemeView } from './page'

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

// 군집 대표색 = 구성원 카테고리 최빈값
function themeColor(t: ThemeView): string {
  const counts: Record<string, number> = {}
  for (const m of t.members) counts[m.category] = (counts[m.category] ?? 0) + 1
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'all'
  return CATEGORY_COLORS[top] ?? '#6b7280'
}

export default function ThemeBubbleMap({ themes }: { themes: ThemeView[] }) {
  const [active, setActive] = useState<ThemeView | null>(themes[0] ?? null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  // cohesion(0~100) → 반지름 (동조도 높을수록 큰 버블)
  const rScale = (v: number) => 8 + (v / 100) * 26

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[auto_1fr]">
      {/* ── 버블맵 ── */}
      <div className="rounded border border-gray-200 p-4">
        <svg width={W} height={H} className="block" style={{ overflow: 'visible' }}>
          {/* 우상단 = 넓고 강하게 동반상승 (메가테마 후보) */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(50) - yScale(100)}
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
            breadth (→ 폭 넓음 · 다품목/다카테고리)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            momentum (↑ 상승 추진력)
          </text>
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🚀 메가테마 후보 (넓게·강하게 동반상승)
          </text>

          {themes.map((t) => {
            const color = themeColor(t)
            const isActive = active?.id === t.id
            return (
              <g key={t.id} style={{ cursor: 'pointer' }} onClick={() => setActive(t)}>
                <circle
                  cx={xScale(t.breadth)}
                  cy={yScale(t.aggregate_momentum)}
                  r={rScale(t.cohesion)}
                  fill={color}
                  fillOpacity={isActive ? 0.7 : 0.4}
                  stroke={color}
                  strokeWidth={isActive ? 3 : 1}
                  strokeOpacity={0.95}
                />
                <text
                  x={xScale(t.breadth)}
                  y={yScale(t.aggregate_momentum) + 3}
                  fontSize="9"
                  fill="#111827"
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {t.member_count}
                </text>
              </g>
            )
          })}
        </svg>

        <div className="mt-4 flex flex-wrap gap-3 text-xs">
          {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
            <span key={cat} className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
              {cat}
            </span>
          ))}
        </div>
      </div>

      {/* ── 드릴다운: 선택 테마 구성 SKU ── */}
      <div className="rounded border border-gray-200 p-4">
        {active ? (
          <div>
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">{active.label ?? active.theme_id}</h2>
              <span className="font-mono text-xs text-gray-400">{active.theme_id}</span>
            </div>
            <div className="mt-1 flex gap-4 text-xs text-gray-500">
              <span>momentum <b className="text-gray-900">{active.aggregate_momentum}</b></span>
              <span>breadth <b className="text-gray-900">{active.breadth}</b></span>
              <span>cohesion <b className="text-gray-900">{active.cohesion}</b></span>
              <span>{active.member_count}개 SKU · {active.category_spread}개 카테고리</span>
            </div>

            <div className="mt-4 border-t border-gray-100 pt-3">
              <h3 className="text-xs font-semibold text-gray-500 mb-2">구성 SKU (테마 단위 동시 소싱 베팅)</h3>
              <div className="space-y-1">
                {active.members
                  .slice()
                  .sort((a, b) => b.final - a.final)
                  .map((m) => (
                    <Link
                      key={m.id}
                      href={`/admin/trend-radar/products/${m.id}`}
                      className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50"
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: CATEGORY_COLORS[m.category] ?? '#6b7280' }}
                      />
                      <span className="font-mono text-xs text-gray-500 w-8">{m.final}</span>
                      <span className="flex-1 truncate">{m.name}</span>
                      <span
                        className={`text-xs ${m.supplier > 0 ? 'text-emerald-600' : 'text-gray-300'}`}
                        title="supplier score (ggsan 소싱 가능성)"
                      >
                        {m.supplier > 0 ? `소싱 ${m.supplier}` : '소싱?'}
                      </span>
                    </Link>
                  ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-400">버블을 클릭해 테마 구성 SKU 를 확인.</div>
        )}
      </div>
    </div>
  )
}
