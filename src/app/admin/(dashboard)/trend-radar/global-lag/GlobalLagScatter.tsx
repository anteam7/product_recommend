'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface LagRow {
  id: string
  name: string
  category: string
  globalLead: number      // X (→ 해외 선행 강함)
  competition: number     // Y (↑ 국내 경쟁 약함 = 미포화)
  trend: number           // 버블 크기 (트렌드 상승)
  overseasRatio: number
  firstSource: string | null
  firstSourceOverseas: boolean
  ggsanSourceable: boolean
  final: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function GlobalLagScatter({ rows }: { rows: LagRow[] }) {
  const [hover, setHover] = useState<LagRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.max(4, Math.sqrt(Math.max(50, v * 4) / Math.PI) * 1.2)

  // 시차 차익 후보: 글로벌 선행 강함 + 국내 경쟁 약함
  const lagPicks = rows
    .filter((r) => r.globalLead >= 50 && r.competition >= 60)
    .sort((a, b) => b.globalLead + b.competition - (a.globalLead + a.competition))

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 시차 차익 사분면 배경 (우상단) */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(50) - yScale(100)}
            fill="#eff6ff"
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

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            global lead (→ 해외 선행 강함)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            competition (↑ 국내 경쟁 약함 = 미포화)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#2563eb" fontWeight="bold" textAnchor="middle">
            🌐 시차 차익 (해외검증·국내선점)
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.globalLead)}
                cy={yScale(r.competition)}
                r={rScale(r.trend)}
                fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                fillOpacity={0.55}
                stroke={r.ggsanSourceable ? '#111827' : CATEGORY_COLORS[r.category] ?? '#6b7280'}
                strokeWidth={r.ggsanSourceable ? 2 : 1}
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
            <div>
              global lead: {hover.globalLead} · competition: {hover.competition} · trend: {hover.trend}
            </div>
            <div>
              해외비율: {hover.overseasRatio}% · 최초출현: {hover.firstSource ?? '—'}
              {hover.firstSourceOverseas ? ' 🌐' : ''}
            </div>
            <div>{hover.ggsanSourceable ? '✅ ggsan 소싱 가능' : '— ggsan 미연결'}</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs items-center">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
        <span className="flex items-center gap-1 ml-2">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-gray-900" />
          ggsan 소싱 가능
        </span>
        <span className="text-gray-400">· 버블 크기 = trend</span>
      </div>

      {/* 시차 차익 sub-list */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          시차 차익 후보 (global lead≥50 + competition≥60)
        </h3>
        <div className="space-y-1 text-sm">
          {lagPicks.slice(0, 15).map((r) => (
            <Link
              key={r.id}
              href={`/admin/trend-radar/products/${r.id}`}
              className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50"
            >
              <span className="font-mono text-xs text-blue-600 w-8 text-right">{r.globalLead}</span>
              <span className="flex-1">{r.name}</span>
              <span className="text-xs text-gray-400">해외 {r.overseasRatio}%</span>
              {r.ggsanSourceable && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-900 text-white">ggsan</span>
              )}
            </Link>
          ))}
          {lagPicks.length === 0 && (
            <div className="text-gray-400 text-xs">
              아직 우상단 시차 차익 후보 없음. 해외 베스트 수집 누적 후 자연 등장.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
