'use client'
import { useMemo, useState } from 'react'

export type Grade = 'paid_ok' | 'organic_only' | 'no_go' | 'no_data'

export interface HeadroomRow {
  keyword: string
  source: string
  notes: string | null
  margin: number
  defaultCvr: number
  matrix: { cvr: number; beCpc: number }[]
  beCpc: number
  marketCpc: number | null
  headroomPct: number | null
  monthlyQc: number
  competitionIdx: string | null
  fetchedAt: string | null
  grade: Grade
  recommendedBid: number | null
}

const GRADE_META: Record<Grade, { color: string; bg: string; border: string; label: string }> = {
  paid_ok: { color: '#10b981', bg: 'bg-emerald-50', border: 'border-emerald-300', label: '🟢 광고 진입 가능' },
  organic_only: { color: '#f59e0b', bg: 'bg-amber-50', border: 'border-amber-300', label: '🟡 자연유입만' },
  no_go: { color: '#ef4444', bg: 'bg-red-50', border: 'border-red-300', label: '🔴 진입 불가' },
  no_data: { color: '#9ca3af', bg: 'bg-gray-50', border: 'border-gray-200', label: '⚪ 데이터 없음' },
}

export default function AdHeadroomBoard({
  rows,
  defaultMargin,
  defaultCvr,
}: {
  rows: HeadroomRow[]
  defaultMargin: number
  defaultCvr: number
}) {
  const [filter, setFilter] = useState<Grade | 'all'>('all')
  const [hover, setHover] = useState<HeadroomRow | null>(null)

  const filtered = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.grade === filter)),
    [rows, filter],
  )

  // Scatter: x = log(monthlyQc), y = headroomPct (clamped -200..200)
  const W = 720
  const H = 360
  const PAD_L = 60
  const PAD_R = 30
  const PAD_T = 30
  const PAD_B = 50

  const maxQc = Math.max(1000, ...rows.map((r) => r.monthlyQc || 0))
  const logMax = Math.log10(Math.max(10, maxQc))
  const xScale = (qc: number) => {
    const l = Math.log10(Math.max(10, qc || 10))
    return PAD_L + (l / logMax) * (W - PAD_L - PAD_R)
  }
  const yScale = (pct: number) => {
    const clamped = Math.max(-200, Math.min(200, pct))
    return PAD_T + ((200 - clamped) / 400) * (H - PAD_T - PAD_B)
  }

  return (
    <div className="space-y-6">
      {/* 필터 */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['all', 'paid_ok', 'organic_only', 'no_go', 'no_data'] as const).map((g) => (
          <button
            key={g}
            onClick={() => setFilter(g)}
            className={`px-3 py-1 rounded border ${
              filter === g
                ? 'bg-black text-white border-black font-semibold'
                : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
            }`}
          >
            {g === 'all' ? `전체 (${rows.length})` : `${GRADE_META[g].label} (${rows.filter((r) => r.grade === g).length})`}
          </button>
        ))}
      </div>

      {/* 산점도 */}
      <div className="rounded border border-gray-200 p-4">
        <div className="text-sm font-semibold mb-2">검색량 × ROAS Headroom</div>
        <div className="relative">
          <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
            {/* y=0 (break-even) line */}
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yScale(0)}
              y2={yScale(0)}
              stroke="#9ca3af"
              strokeWidth={1.5}
              strokeDasharray="4,3"
            />
            <text x={W - PAD_R - 4} y={yScale(0) - 4} fontSize="10" fill="#6b7280" textAnchor="end">
              break-even (headroom 0%)
            </text>

            {/* grid lines */}
            {[-100, -50, 50, 100, 200].map((v) => (
              <g key={'gy' + v}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={yScale(v)}
                  y2={yScale(v)}
                  stroke="#f3f4f6"
                />
                <text x={PAD_L - 6} y={yScale(v) + 4} fontSize="9" fill="#9ca3af" textAnchor="end">
                  {v}%
                </text>
              </g>
            ))}
            {[100, 1000, 10000, 100000].filter((v) => v <= maxQc * 1.2).map((v) => (
              <g key={'gx' + v}>
                <line x1={xScale(v)} x2={xScale(v)} y1={PAD_T} y2={H - PAD_B} stroke="#f3f4f6" />
                <text x={xScale(v)} y={H - PAD_B + 14} fontSize="9" fill="#9ca3af" textAnchor="middle">
                  {v.toLocaleString()}
                </text>
              </g>
            ))}

            <text x={W / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">
              monthly search volume (log)
            </text>
            <text
              x={16}
              y={H / 2}
              fontSize="11"
              fill="#6b7280"
              textAnchor="middle"
              transform={`rotate(-90 16 ${H / 2})`}
            >
              ROAS headroom (BE-CPC vs market CPC, %)
            </text>

            {filtered
              .filter((r) => r.headroomPct != null && r.monthlyQc > 0)
              .map((r) => (
                <circle
                  key={r.keyword}
                  cx={xScale(r.monthlyQc)}
                  cy={yScale(r.headroomPct!)}
                  r={6}
                  fill={GRADE_META[r.grade].color}
                  fillOpacity={0.65}
                  stroke={GRADE_META[r.grade].color}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              ))}
          </svg>

          {hover && (
            <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
              <div className="font-semibold">{hover.keyword}</div>
              <div>headroom: {hover.headroomPct}% · qc: {hover.monthlyQc.toLocaleString()}</div>
              <div>BE-CPC {hover.beCpc.toLocaleString()} / market {hover.marketCpc?.toLocaleString() ?? '?'}</div>
            </div>
          )}
        </div>

        <div className="mt-3 text-xs text-gray-500">
          가정: margin = <code>{defaultMargin.toLocaleString()}원</code> · CVR = <code>{defaultCvr}%</code>.
          핀 메모 <code>margin=XXXX</code> 가 있으면 우선 적용.
        </div>
      </div>

      {/* 카드 리스트 */}
      <div className="space-y-2">
        {filtered.map((r) => {
          const meta = GRADE_META[r.grade]
          return (
            <div
              key={r.keyword}
              className={`rounded border ${meta.border} ${meta.bg} p-3 flex items-start gap-3`}
            >
              <div
                className="w-1 rounded-full self-stretch"
                style={{ background: meta.color, minWidth: 4 }}
              />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-baseline gap-2">
                  <div className="text-sm font-semibold">{r.keyword}</div>
                  <div className="text-[10px] text-gray-500">{r.source}</div>
                </div>
                <div className="text-xs text-gray-600 flex flex-wrap gap-x-3 gap-y-1">
                  <span>
                    margin <code>{r.margin.toLocaleString()}</code>
                  </span>
                  <span>
                    BE-CPC (
                    {r.matrix.map((m) => `${m.cvr}%: ${m.beCpc.toLocaleString()}`).join(' · ')})
                  </span>
                </div>
                {r.notes && (
                  <div className="text-[11px] text-gray-500 italic line-clamp-1" title={r.notes}>
                    {r.notes}
                  </div>
                )}
              </div>

              <div className="text-right flex-shrink-0 space-y-1 min-w-[220px]">
                <div className="text-[11px] uppercase tracking-wide" style={{ color: meta.color }}>
                  {meta.label}
                </div>
                <div className="text-xs text-gray-700">
                  market CPC{' '}
                  <span className="font-mono">
                    {r.marketCpc != null ? `${r.marketCpc.toLocaleString()}원` : '—'}
                  </span>
                </div>
                <HeadroomBar pct={r.headroomPct} />
                <div className="text-[11px] text-gray-500 font-mono">
                  qc {r.monthlyQc.toLocaleString()} · {r.competitionIdx ?? '?'}
                  {r.recommendedBid != null && (
                    <>
                      <br />권장 입찰 ≤ {r.recommendedBid.toLocaleString()}
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HeadroomBar({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <div className="text-[11px] text-gray-400">광고 데이터 대기</div>
  }
  const clamped = Math.max(-100, Math.min(200, pct))
  // -100..200 → 0..100 width
  const widthPct = ((clamped + 100) / 300) * 100
  const color = pct >= 30 ? '#10b981' : pct >= -30 ? '#f59e0b' : '#ef4444'
  return (
    <div className="space-y-0.5">
      <div className="h-2 bg-gray-200 rounded overflow-hidden relative">
        <div
          className="h-full"
          style={{ width: `${widthPct}%`, background: color, transition: 'width .2s' }}
        />
        <div
          className="absolute top-0 bottom-0 w-px bg-gray-500"
          style={{ left: `${(100 / 300) * 100}%` }}
          title="break-even"
        />
      </div>
      <div className="text-[11px] font-mono" style={{ color }}>
        headroom {pct > 0 ? '+' : ''}
        {pct}%
      </div>
    </div>
  )
}
