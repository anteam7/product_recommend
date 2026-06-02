'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface MomentumRow {
  id: string
  name: string
  category: string
  categoryMid: string | null
  txnShare: number // 거래의도 비중 (최근 7d) 0~100
  txnSharePrev: number // 직전 7d
  baseShare: number // 8~30d 베이스라인
  velocity: number // %p (최근 7d − 직전 7d)
  signals7d: number
  signalsTotal: number
  mix: {
    informational: number
    commercial: number
    transactional: number
    navigational: number
  }
  hasGgsan: boolean
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

// 의도 mix 스택바 색상
const MIX_COLORS = {
  informational: '#cbd5e1', // slate-300
  commercial: '#fbbf24', // amber-400
  transactional: '#10b981', // emerald-500
  navigational: '#a78bfa', // violet-400
}

function MixBar({ mix }: { mix: MomentumRow['mix'] }) {
  const segs: Array<[keyof typeof MIX_COLORS, number]> = [
    ['informational', mix.informational],
    ['commercial', mix.commercial],
    ['transactional', mix.transactional],
    ['navigational', mix.navigational],
  ]
  const total = segs.reduce((s, [, v]) => s + v, 0) || 1
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100" title="의도 mix (최근 7d)">
      {segs.map(([k, v]) => (
        <div
          key={k}
          style={{ width: `${(v / total) * 100}%`, background: MIX_COLORS[k] }}
          title={`${k}: ${v}%`}
        />
      ))}
    </div>
  )
}

export default function IntentMomentumBoard({ rows }: { rows: MomentumRow[] }) {
  const [hover, setHover] = useState<MomentumRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // x: 0~100 (거래의도 비중) / y: velocity, -50~+50 클램프해서 중앙 0
  const VMAX = 50
  const xScale = (v: number) => PAD + (Math.max(0, Math.min(100, v)) / 100) * (W - 2 * PAD)
  const yScale = (v: number) => {
    const c = Math.max(-VMAX, Math.min(VMAX, v))
    return H - PAD - ((c + VMAX) / (2 * VMAX)) * (H - 2 * PAD)
  }
  const rScale = (signals: number) => Math.max(4, Math.min(18, 4 + Math.sqrt(signals) * 2.2))

  // '막 거래단계 진입': base 낮고(<40) velocity 높음(>15)
  const breakouts = rows
    .filter((r) => r.baseShare < 40 && r.velocity > 15 && r.signals7d >= 2)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 12)

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우상단 사분면 배경 (높은 거래의도 + 가속) */}
          <rect
            x={xScale(50)}
            y={yScale(VMAX)}
            width={xScale(100) - xScale(50)}
            height={yScale(0) - yScale(VMAX)}
            fill="#f0fdf4"
          />

          {/* x grid */}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {/* y grid (velocity, -50~+50) */}
          {[-50, -25, 0, 25, 50].map((v) => (
            <g key={'gy' + v}>
              <line
                x1={PAD}
                y1={yScale(v)}
                x2={W - PAD}
                y2={yScale(v)}
                stroke={v === 0 ? '#9ca3af' : '#e5e7eb'}
                strokeDasharray={v === 0 ? '' : '2,3'}
              />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            거래의도 비중 % (→ transactional+commercial)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            전환가속도 %p (↑ 거래단계로 가속)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(75)} y={yScale(45)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🚀 지금 등록 (거래의도↑·가속↑)
          </text>

          {/* 점들 */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.txnShare)}
                cy={yScale(r.velocity)}
                r={rScale(r.signals7d)}
                fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                fillOpacity={r.hasGgsan ? 0.6 : 0.25}
                stroke={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                strokeOpacity={0.9}
                strokeWidth={r.hasGgsan ? 1.5 : 1}
                onMouseEnter={() => setHover(r)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'pointer' }}
              />
            </a>
          ))}
        </svg>

        {/* hover tooltip */}
        {hover && (
          <div className="absolute top-2 right-2 w-60 rounded bg-black/85 px-3 py-2 text-xs text-white">
            <div className="font-semibold">{hover.name}</div>
            <div className="mt-0.5 text-gray-300">
              {hover.category}
              {hover.categoryMid ? ` · ${hover.categoryMid}` : ''}
              {hover.hasGgsan ? ' · 🟢 소싱가능' : ' · ⚪ 미소싱'}
            </div>
            <div className="mt-1">
              거래의도 {hover.txnShare}% (직전 {hover.txnSharePrev}%) · 가속{' '}
              <span className={hover.velocity >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {hover.velocity >= 0 ? `+${hover.velocity}` : hover.velocity}%p
              </span>
            </div>
            <div className="text-gray-400">시그널 7d {hover.signals7d} / 14d {hover.signalsTotal}</div>
            <div className="mt-1.5">
              <MixBar mix={hover.mix} />
            </div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
        <span className="ml-2 text-gray-400">· 진한 채움 = 소싱가능(ggsan) · 점 크기 = 7d 시그널 수</span>
      </div>

      {/* 막 거래단계 진입 리스트 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold">🚀 막 거래단계 진입 (낮은 base &lt;40 → 급상승 velocity &gt;15)</h3>
        <div className="space-y-1.5 text-sm">
          {breakouts.map((r) => (
            <Link
              key={r.id}
              href={`/admin/trend-radar/products/${r.id}`}
              className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-gray-50"
            >
              <span className="w-14 shrink-0 font-mono text-emerald-600">+{r.velocity}%p</span>
              <span className="w-28 shrink-0 truncate">{r.name}</span>
              <span className="w-32 shrink-0">
                <MixBar mix={r.mix} />
              </span>
              <span className="shrink-0 text-xs text-gray-400">
                base {r.baseShare}% → {r.txnShare}%
              </span>
              <span className="ml-auto shrink-0 text-xs">
                {r.hasGgsan ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">소싱가능</span>
                ) : (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">미소싱</span>
                )}
              </span>
            </Link>
          ))}
          {breakouts.length === 0 && (
            <div className="text-xs text-gray-400">아직 변곡점 통과 상품 없음. 의도 시계열 누적 후 자연 등장.</div>
          )}
        </div>
      </div>
    </div>
  )
}
