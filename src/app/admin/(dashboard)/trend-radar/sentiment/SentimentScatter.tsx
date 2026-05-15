'use client'
import Link from 'next/link'
import { useState } from 'react'

interface Row {
  id: string
  name: string
  category: string
  mention: number
  x: number
  y: number
  neg: number
  claim: number
  claimKeywords: string[]
  windowEnd: string
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
  other: '#6b7280',
}

function riskColor(row: Row): string {
  // 좌상단(언급↑·긍정↓) = 빨강 (클레임 위험)
  // 우상단(언급↑·긍정↑) = 초록 (안전 후보)
  if (row.x >= 50 && row.y < 40) return '#ef4444'        // claim risk
  if (row.x >= 50 && row.y >= 60) return '#10b981'       // safe
  if (row.claim >= 20) return '#f97316'                  // claim 키워드 비중 높음
  return '#9ca3af'
}

export default function SentimentScatter({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<Row | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (mention: number) => Math.max(4, Math.min(28, Math.sqrt(Math.max(1, mention)) * 1.6))

  const danger = rows.filter((r) => r.x >= 50 && r.y < 40).sort((a, b) => a.y - b.y || b.mention - a.mention)
  const safe = rows.filter((r) => r.x >= 50 && r.y >= 60).sort((a, b) => b.y - a.y || b.mention - a.mention)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 좌상단 = 클레임 위험 (빨강) */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(40) - yScale(100)}
            fill="#fef2f2"
            opacity={0.6}
          />
          {/* 우상단 = 안전 후보 (초록) */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(60) - yScale(100)}
            fill="#f0fdf4"
            opacity={0.6}
          />

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

          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            언급량 (log scale, →)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            긍정 비율 (↑)
          </text>

          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            ✅ 안전 위탁 후보
          </text>
          <text x={xScale(75)} y={yScale(20)} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            ⚠ 클레임 위험 — 회피
          </text>

          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.x)}
                cy={yScale(r.y)}
                r={rScale(r.mention)}
                fill={riskColor(r)}
                fillOpacity={0.55}
                stroke={riskColor(r)}
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
              mention: {hover.mention} · pos: {hover.y}% · neg: {hover.neg}% · claim: {hover.claim}%
            </div>
            {hover.claimKeywords.length > 0 && (
              <div className="mt-1 text-amber-300">claim: {hover.claimKeywords.slice(0, 5).join(', ')}</div>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#ef4444', opacity: 0.6 }} />
          클레임 위험 (언급↑·긍정↓)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#10b981', opacity: 0.6 }} />
          안전 위탁 후보
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#f97316', opacity: 0.6 }} />
          claim 키워드 비중↑
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: '#9ca3af', opacity: 0.6 }} />
          중립/저언급
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-6 border-t border-gray-200 pt-4">
        <div>
          <h3 className="text-sm font-semibold mb-2 text-red-700">⚠ 회피 리스트 (claim 위험 TOP 10)</h3>
          <div className="space-y-1 text-sm">
            {danger.slice(0, 10).map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="block px-2 py-1 rounded hover:bg-red-50"
              >
                <span className="font-mono text-red-500 mr-2">{r.y}%</span>
                {r.name}
                <span className="ml-2 text-xs text-gray-500">언급 {r.mention} · claim {r.claim}%</span>
              </Link>
            ))}
            {danger.length === 0 && (
              <div className="text-gray-400 text-xs">현재 위험 후보 없음 (좋은 신호).</div>
            )}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2 text-emerald-700">✅ 안전 후보 TOP 10</h3>
          <div className="space-y-1 text-sm">
            {safe.slice(0, 10).map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="block px-2 py-1 rounded hover:bg-emerald-50"
              >
                <span className="font-mono text-emerald-600 mr-2">{r.y}%</span>
                {r.name}
                <span className="ml-2 text-xs text-gray-500">언급 {r.mention}</span>
              </Link>
            ))}
            {safe.length === 0 && (
              <div className="text-gray-400 text-xs">아직 안전 후보 미발견. 누적 더 필요.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
