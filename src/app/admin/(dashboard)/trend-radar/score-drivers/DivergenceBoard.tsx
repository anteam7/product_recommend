'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface SubDelta {
  key: string // "trend.velocity" 형태
  group: ComponentKey
  delta: number
}

export type ComponentKey = 'trend' | 'commerce' | 'supplier' | 'competition'

export interface DriverRow {
  id: string
  name: string
  category: string
  prevAt: string
  currAt: string
  finalPrev: number
  finalCurr: number
  finalDelta: number
  deltas: Record<ComponentKey, number>
  subDeltas: SubDelta[]
  quality: 'durable' | 'fragile' | 'mixed' | 'flat'
  demandShare: number // 0~1, 상승 중 수요(trend+commerce) 비중
}

const COMPONENT_META: Record<ComponentKey, { label: string; color: string; demand: boolean }> = {
  trend: { label: '트렌드', color: '#10b981', demand: true },
  commerce: { label: '커머스', color: '#3b82f6', demand: true },
  supplier: { label: '공급', color: '#f59e0b', demand: false },
  competition: { label: '경쟁', color: '#a78bfa', demand: false },
}

const QUALITY_META: Record<DriverRow['quality'], { label: string; cls: string; hint: string }> = {
  durable: {
    label: '수요견인',
    cls: 'bg-emerald-100 text-emerald-700',
    hint: '트렌드·커머스가 상승을 주도 — 추격 가치 높음(durable)',
  },
  fragile: {
    label: '일시요인',
    cls: 'bg-amber-100 text-amber-700',
    hint: '공급가 변동·경쟁 노이즈가 주도 — 헛다리 위험(fragile)',
  },
  mixed: {
    label: '혼재',
    cls: 'bg-gray-100 text-gray-600',
    hint: '수요·공급 요인이 비등 — 추가 관찰 필요',
  },
  flat: {
    label: '변동없음',
    cls: 'bg-gray-50 text-gray-400',
    hint: 'final_score 변동 미미',
  },
}

function fmt(d: number) {
  const r = Math.round(d * 10) / 10
  return r > 0 ? `+${r}` : `${r}`
}

// 발산 바: 0 을 가운데 두고 4 컴포넌트 Δ 를 좌(-)/우(+) 로
function DivergenceBars({ deltas, scale }: { deltas: Record<ComponentKey, number>; scale: number }) {
  const mid = 50 // % 기준선
  return (
    <div className="space-y-1">
      {(Object.keys(COMPONENT_META) as ComponentKey[]).map((k) => {
        const v = deltas[k] ?? 0
        const meta = COMPONENT_META[k]
        const widthPct = Math.min(48, (Math.abs(v) / scale) * 48)
        return (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className="w-12 shrink-0 text-right text-gray-500">{meta.label}</span>
            <div className="relative h-3 flex-1 rounded bg-gray-100">
              <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
              {v !== 0 && (
                <div
                  className="absolute inset-y-0 rounded"
                  style={{
                    background: meta.color,
                    opacity: meta.demand ? 0.85 : 0.5,
                    left: v >= 0 ? `${mid}%` : `${mid - widthPct}%`,
                    width: `${widthPct}%`,
                  }}
                />
              )}
            </div>
            <span
              className="w-10 shrink-0 font-mono"
              style={{ color: v > 0 ? '#059669' : v < 0 ? '#dc2626' : '#9ca3af' }}
            >
              {fmt(v)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function DivergenceBoard({ rows }: { rows: DriverRow[] }) {
  const [filter, setFilter] = useState<'all' | DriverRow['quality']>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  // 발산 바 폭 정규화용: 컴포넌트 Δ 절댓값 최댓값
  const scale = Math.max(
    5,
    ...rows.flatMap((r) => Object.values(r.deltas).map((v) => Math.abs(v))),
  )

  const watch = rows
    .filter((r) => r.finalDelta > 0)
    .sort((a, b) => b.finalDelta - a.finalDelta)
    .slice(0, 15)

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.quality === filter)

  const counts = {
    durable: rows.filter((r) => r.quality === 'durable' && r.finalDelta > 0).length,
    fragile: rows.filter((r) => r.quality === 'fragile' && r.finalDelta > 0).length,
    mixed: rows.filter((r) => r.quality === 'mixed' && r.finalDelta > 0).length,
  }

  return (
    <div className="space-y-8">
      {/* 상승 품질 요약 */}
      <section className="grid grid-cols-3 gap-3">
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-xs text-emerald-700">수요견인 상승</div>
          <div className="mt-1 text-2xl font-bold text-emerald-700">{counts.durable}</div>
          <div className="text-[11px] text-emerald-600">트렌드·커머스 주도 (durable)</div>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs text-amber-700">일시요인 상승</div>
          <div className="mt-1 text-2xl font-bold text-amber-700">{counts.fragile}</div>
          <div className="text-[11px] text-amber-600">공급·경쟁 주도 (fragile)</div>
        </div>
        <div className="rounded border border-gray-200 bg-gray-50 p-3">
          <div className="text-xs text-gray-600">혼재 상승</div>
          <div className="mt-1 text-2xl font-bold text-gray-600">{counts.mixed}</div>
          <div className="text-[11px] text-gray-500">요인 비등 — 관찰</div>
        </div>
      </section>

      {/* 상승폭 워치리스트 */}
      <section>
        <h2 className="mb-2 text-sm font-semibold">📈 상승폭 워치리스트 (Δfinal &gt; 0, 상위 {watch.length})</h2>
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-right">Δfinal</th>
                <th className="px-3 py-2 text-center">상승의 질</th>
                <th className="px-3 py-2 text-left">주요 동인</th>
                <th className="px-3 py-2 text-right">final</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {watch.map((r) => {
                const top = [...r.subDeltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0]
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${r.id}`}
                        className="font-medium hover:underline"
                      >
                        {r.name}
                      </Link>
                      <span className="ml-1 text-[10px] text-gray-400">{r.category}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-emerald-600">
                      {fmt(r.finalDelta)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${QUALITY_META[r.quality].cls}`}
                        title={QUALITY_META[r.quality].hint}
                      >
                        {QUALITY_META[r.quality].label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {top ? (
                        <span className="font-mono">
                          {top.key} {fmt(top.delta)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500">
                      {r.finalPrev}→{r.finalCurr}
                    </td>
                  </tr>
                )
              })}
              {watch.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-gray-400">
                    아직 두 스냅샷 사이 상승한 상품 없음. recompute 누적 후 등장.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 컴포넌트 발산 보드 */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">🔬 컴포넌트 기여도 분해 (직전 vs 최신)</h2>
          <div className="flex gap-1 text-xs">
            {(['all', 'durable', 'fragile', 'mixed'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-0.5 ${
                  filter === f ? 'bg-black text-white' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {f === 'all' ? '전체' : QUALITY_META[f].label}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-3 text-xs text-gray-500">
          가운데 = 0. 오른쪽(녹/청) = 점수를 민 컴포넌트, 왼쪽(빨강 수치) = 끌어내린 컴포넌트.
          <span className="text-emerald-600"> 트렌드·커머스</span>가 밀면 durable,
          <span className="text-amber-600"> 공급·경쟁</span>이 밀면 fragile.
        </p>
        <div className="space-y-2">
          {filtered
            .sort((a, b) => b.finalDelta - a.finalDelta)
            .slice(0, 60)
            .map((r) => (
              <div key={r.id} className="rounded border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/trend-radar/products/${r.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${QUALITY_META[r.quality].cls}`}
                      title={QUALITY_META[r.quality].hint}
                    >
                      {QUALITY_META[r.quality].label}
                    </span>
                    <span className="text-[10px] text-gray-400">{r.category}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="font-mono text-sm font-bold"
                      style={{ color: r.finalDelta > 0 ? '#059669' : r.finalDelta < 0 ? '#dc2626' : '#9ca3af' }}
                    >
                      Δ{fmt(r.finalDelta)}
                    </span>
                    {r.subDeltas.length > 0 && (
                      <button
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                        className="text-[11px] text-gray-400 hover:text-black"
                      >
                        {expanded === r.id ? '하위 ▲' : '하위 ▼'}
                      </button>
                    )}
                  </div>
                </div>
                <DivergenceBars deltas={r.deltas} scale={scale} />
                {expanded === r.id && r.subDeltas.length > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-gray-100 pt-2 text-[11px] md:grid-cols-3">
                    {[...r.subDeltas]
                      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                      .map((s) => (
                        <div key={s.key} className="flex justify-between font-mono">
                          <span className="text-gray-500" style={{ color: COMPONENT_META[s.group].color }}>
                            {s.key}
                          </span>
                          <span style={{ color: s.delta > 0 ? '#059669' : s.delta < 0 ? '#dc2626' : '#9ca3af' }}>
                            {fmt(s.delta)}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-gray-400">
                  {r.prevAt} → {r.currAt}
                </div>
              </div>
            ))}
          {filtered.length === 0 && (
            <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">
              해당 라벨의 상품 없음.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
