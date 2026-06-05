'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

interface AxisDelta {
  now: number
  vel: number
  acc: number
}

export interface MomentumRow {
  id: string
  name: string
  category: string
  points: number
  finalNow: number
  finalVel: number
  finalAcc: number
  rising: number
  sparkline: number[]
  axes: {
    trend: AxisDelta
    commerce: AxisDelta
    supplier: AxisDelta
    competition: AxisDelta
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

const AXIS_LABEL: Record<keyof MomentumRow['axes'], string> = {
  trend: '트렌드',
  commerce: '커머스',
  supplier: '공급',
  competition: '경쟁',
}

type SortKey = 'rising' | 'finalVel' | 'finalNow'

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 96
  const H = 28
  const PAD = 2
  if (values.length < 2) return <div style={{ width: W, height: H }} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const stepX = (W - 2 * PAD) / (values.length - 1)
  const pts = values.map((v, i) => {
    const x = PAD + i * stepX
    const y = H - PAD - ((v - min) / span) * (H - 2 * PAD)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const lastX = PAD + (values.length - 1) * stepX
  const lastY = H - PAD - ((values[values.length - 1] - min) / span) * (H - 2 * PAD)
  return (
    <svg width={W} height={H} className="block">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2.2} fill={color} />
    </svg>
  )
}

// 변화량 → ▲/▼ 칩
function DeltaChip({ label, d }: { label: string; d: AxisDelta }) {
  const up = d.vel > 0.05
  const down = d.vel < -0.05
  const arrow = up ? '▲' : down ? '▼' : '—'
  const accMark = d.acc > 0.05 ? '⁺' : d.acc < -0.05 ? '⁻' : ''
  const color = up ? '#059669' : down ? '#dc2626' : '#9ca3af'
  const bg = up ? '#ecfdf5' : down ? '#fef2f2' : '#f9fafb'
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
      style={{ background: bg, color }}
      title={`${label}: now ${d.now} · 속도 ${d.vel} · 가속 ${d.acc}`}
    >
      <span className="text-gray-500">{label}</span>
      <span>
        {arrow}
        {accMark} {d.vel > 0 ? '+' : ''}
        {d.vel}
      </span>
    </span>
  )
}

export default function MomentumBoard({ rows }: { rows: MomentumRow[] }) {
  const [sort, setSort] = useState<SortKey>('rising')

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => b[sort] - a[sort])
    return arr
  }, [rows, sort])

  // 가속 상승 후보 = 속도>0 & 가속≥0 & 아직 절대값 중하위
  const rising = sorted.filter((r) => r.finalVel > 0.05 && r.finalAcc >= -0.05 && r.finalNow < 70)
  // 냉각 = 고점에서 하락 전환 (속도<0, 절대값 높음)
  const cooling = [...rows].filter((r) => r.finalVel < -0.05 && r.finalNow >= 55).sort((a, b) => a.finalVel - b.finalVel)

  return (
    <div className="space-y-6">
      {/* 가속 상승 선점 큐 */}
      <section className="rounded border border-emerald-200 bg-emerald-50/40 p-4">
        <h2 className="mb-1 text-sm font-semibold text-emerald-800">🚀 가속 상승 — 정점 전 선점 큐</h2>
        <p className="mb-3 text-xs text-emerald-700/80">
          절대점수는 낮아도(&lt;70) 속도·가속이 양(+)인 후보. 후행 랭킹이 못 잡는 “뜨는 중”.
        </p>
        {rising.length === 0 ? (
          <div className="text-xs text-emerald-700/60">아직 가속 상승 후보 없음. 스냅샷 누적 후 등장.</div>
        ) : (
          <Table rows={rising.slice(0, 15)} />
        )}
      </section>

      {/* 정렬 컨트롤 + 전체 */}
      <section className="rounded border border-gray-200 p-4">
        <div className="mb-3 flex items-center gap-2 text-xs">
          <span className="text-gray-500">정렬:</span>
          {(
            [
              ['rising', '가속상승 점수'],
              ['finalVel', '속도'],
              ['finalNow', '현재점수'],
            ] as [SortKey, string][]
          ).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className={`rounded px-2 py-1 ${sort === k ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {lbl}
            </button>
          ))}
          <span className="ml-auto text-gray-400">{rows.length}개 상품 · 시계열 보유분만</span>
        </div>
        <Table rows={sorted} />
      </section>

      {/* 냉각 중 */}
      {cooling.length > 0 && (
        <section className="rounded border border-gray-200 p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-600">❄️ 냉각 중 — 고점 하락 전환 (강등)</h2>
          <Table rows={cooling.slice(0, 10)} muted />
        </section>
      )}
    </div>
  )
}

function Table({ rows, muted }: { rows: MomentumRow[]; muted?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-400">
            <th className="py-1.5 pr-2 font-medium">상품</th>
            <th className="px-2 py-1.5 font-medium">궤적 (final)</th>
            <th className="px-2 py-1.5 text-right font-medium">현재</th>
            <th className="px-2 py-1.5 text-right font-medium">속도/가속</th>
            <th className="px-2 py-1.5 font-medium">축별 Δ (속도)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = CATEGORY_COLORS[r.category] ?? '#6b7280'
            return (
              <tr key={r.id} className={`border-b border-gray-100 ${muted ? 'opacity-70' : ''}`}>
                <td className="max-w-[220px] truncate py-2 pr-2">
                  <Link href={`/admin/trend-radar/products/${r.id}`} className="hover:underline">
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: color }} />
                    {r.name}
                  </Link>
                  <span className="ml-1 text-[10px] text-gray-400">{r.points}pt</span>
                </td>
                <td className="px-2 py-2">
                  <Sparkline values={r.sparkline} color={color} />
                </td>
                <td className="px-2 py-2 text-right font-mono">{r.finalNow}</td>
                <td className="px-2 py-2 text-right font-mono">
                  <span className={r.finalVel > 0 ? 'text-emerald-600' : r.finalVel < 0 ? 'text-red-600' : 'text-gray-400'}>
                    {r.finalVel > 0 ? '+' : ''}
                    {r.finalVel}
                  </span>
                  <span className="text-gray-400">
                    {' / '}
                    {r.finalAcc > 0 ? '+' : ''}
                    {r.finalAcc}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(['trend', 'commerce', 'supplier', 'competition'] as const).map((ax) => (
                      <DeltaChip key={ax} label={AXIS_LABEL[ax]} d={r.axes[ax]} />
                    ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
