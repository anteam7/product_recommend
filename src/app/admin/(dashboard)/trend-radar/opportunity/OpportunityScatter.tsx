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
  gift_share?: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

// gift_share 0~1 → 보라 그라데이션 (선물 인텐트 강할수록 진해짐)
function giftColor(share: number): string {
  const s = Math.max(0, Math.min(1, share))
  // light violet → deep violet
  // hsl(270, 80%, lightness)
  const lightness = Math.round(85 - 50 * s) // 85% → 35%
  return `hsl(270, 80%, ${lightness}%)`
}

export default function OpportunityScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const [colorBy, setColorBy] = useState<'category' | 'gift_share'>('category')
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.sqrt(v / Math.PI) * 1.2

  function fillFor(r: Row): string {
    if (colorBy === 'gift_share') return giftColor(r.gift_share ?? 0)
    return CATEGORY_COLORS[r.category] ?? '#6b7280'
  }

  return (
    <div className="rounded border border-gray-200 p-4">
      {/* color dimension toggle */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-gray-500">color:</span>
        <button
          type="button"
          onClick={() => setColorBy('category')}
          className={`px-2 py-1 rounded border ${
            colorBy === 'category' ? 'bg-black text-white border-black' : 'border-gray-300 text-gray-700'
          }`}
        >
          category
        </button>
        <button
          type="button"
          onClick={() => setColorBy('gift_share')}
          className={`px-2 py-1 rounded border ${
            colorBy === 'gift_share' ? 'bg-violet-600 text-white border-violet-600' : 'border-gray-300 text-gray-700'
          }`}
        >
          🎁 gift_share
        </button>
      </div>

      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          <rect x={xScale(50)} y={yScale(100)} width={xScale(100) - xScale(50)} height={yScale(50) - yScale(100)} fill="#f0fdf4" />

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
            competition (→ 경쟁 약함)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            trend (↑ 트렌드 강함)
          </text>

          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🎯 핀 후보 (트렌드↑·경쟁↓)
          </text>

          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.x)}
                cy={yScale(r.y)}
                r={rScale(r.size)}
                fill={fillFor(r)}
                fillOpacity={0.6}
                stroke={fillFor(r)}
                strokeOpacity={0.9}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            </a>
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>
              final: {hover.final} · trend: {hover.y} · competition: {hover.x} · supplier: {hover.supplier}
            </div>
            {hover.gift_share !== undefined && hover.gift_share > 0 && (
              <div className="text-violet-300">gift_share: {(hover.gift_share * 100).toFixed(0)}%</div>
            )}
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {colorBy === 'category'
          ? Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
              <span key={cat} className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
                {cat}
              </span>
            ))
          : [0, 0.25, 0.5, 0.75, 1].map((s) => (
              <span key={s} className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 rounded-full" style={{ background: giftColor(s), opacity: 0.7 }} />
                gift {(s * 100).toFixed(0)}%
              </span>
            ))}
      </div>

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
                {r.gift_share !== undefined && r.gift_share > 0 && (
                  <span className="ml-2 text-[10px] text-violet-600">🎁 {(r.gift_share * 100).toFixed(0)}%</span>
                )}
              </Link>
            ))}
          {rows.filter((r) => r.y >= 60 && r.x >= 60).length === 0 && (
            <div className="text-gray-400 text-xs">아직 우상단 후보 없음. 30일 누적 후 자연 등장.</div>
          )}
        </div>
      </div>
    </div>
  )
}
