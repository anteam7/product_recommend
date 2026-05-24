'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'

export interface SnapshotRow {
  id: string
  keyword: string
  collectedAt: string
  nListings: number
  mean: number | null
  median: number | null
  p25: number | null
  p75: number | null
  min: number | null
  max: number | null
  stddev: number | null
  cv: number | null
  iqrRatio: number | null
  minmaxGap: number | null
  productId: string | null
  categoryTop: string | null
  prices: number[]
}

type SortKey = 'cv' | 'iqr' | 'gap' | 'median' | 'n' | 'date'

const fmtKRW = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : `₩${Math.round(v).toLocaleString()}`

const fmtPct = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`

function classifyCV(cv: number | null): { tag: string; color: string; signal: number } {
  if (cv == null) return { tag: '—', color: '#9ca3af', signal: 0 }
  if (cv < 0.1) return { tag: 'commodity', color: '#dc2626', signal: -10 } // low CV: 진입 위험
  if (cv < 0.2) return { tag: 'tight', color: '#f97316', signal: -3 }
  if (cv < 0.35) return { tag: 'normal', color: '#6b7280', signal: 0 }
  if (cv < 0.6) return { tag: 'loose', color: '#10b981', signal: +6 }
  return { tag: 'wild', color: '#3b82f6', signal: +10 } // very high CV: pricing power
}

export default function PriceDispersionBoard({ rows }: { rows: SnapshotRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('cv')
  const [filter, setFilter] = useState('')

  const sorted = useMemo(() => {
    const list = rows.filter((r) =>
      filter ? r.keyword.toLowerCase().includes(filter.toLowerCase()) : true,
    )
    const cmp: Record<SortKey, (a: SnapshotRow, b: SnapshotRow) => number> = {
      cv: (a, b) => (b.cv ?? -1) - (a.cv ?? -1),
      iqr: (a, b) => (b.iqrRatio ?? -1) - (a.iqrRatio ?? -1),
      gap: (a, b) => (b.minmaxGap ?? -1) - (a.minmaxGap ?? -1),
      median: (a, b) => (b.median ?? -1) - (a.median ?? -1),
      n: (a, b) => b.nListings - a.nListings,
      date: (a, b) => (b.collectedAt > a.collectedAt ? 1 : -1),
    }
    return [...list].sort(cmp[sortKey])
  }, [rows, sortKey, filter])

  // CV 히스토그램 (10 buckets, 0~1.0)
  const histo = useMemo(() => {
    const buckets = new Array(10).fill(0) as number[]
    for (const r of rows) {
      if (r.cv == null) continue
      const idx = Math.min(9, Math.max(0, Math.floor(r.cv * 10)))
      buckets[idx]++
    }
    const max = Math.max(1, ...buckets)
    return buckets.map((b) => ({ count: b, pct: b / max }))
  }, [rows])

  return (
    <div className="space-y-6">
      {/* 상단 컨트롤 */}
      <div className="rounded border border-gray-200 p-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">정렬</span>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            <option value="cv">CV ↓ (분산 큰 순)</option>
            <option value="iqr">IQR/median ↓</option>
            <option value="gap">min~max gap ↓</option>
            <option value="median">median 가격 ↓</option>
            <option value="n">listing 수 ↓</option>
            <option value="date">최근 수집 순</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">검색</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="keyword..."
            className="text-sm border border-gray-300 rounded px-2 py-1 w-48"
          />
        </div>
        <div className="ml-auto text-xs text-gray-500">
          전체 {rows.length}건 · 표시 {sorted.length}건
        </div>
      </div>

      {/* CV 히스토그램 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-3">CV 분포 히스토그램</h2>
        <div className="flex items-end gap-1 h-32 mb-1">
          {histo.map((b, i) => (
            <div
              key={i}
              className="flex-1 flex flex-col items-center justify-end"
              title={`CV ${(i / 10).toFixed(1)}~${((i + 1) / 10).toFixed(1)} : ${b.count}건`}
            >
              <div
                className="w-full rounded-t"
                style={{
                  height: `${b.pct * 100}%`,
                  background:
                    i < 1
                      ? '#dc2626'
                      : i < 2
                        ? '#f97316'
                        : i < 3
                          ? '#6b7280'
                          : i < 6
                            ? '#10b981'
                            : '#3b82f6',
                  opacity: 0.7,
                }}
              />
              <div className="text-[10px] text-gray-400 mt-1">{b.count}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-gray-500">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex-1 text-center">
              {(i / 10).toFixed(1)}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[11px]">
          <Legend color="#dc2626" label="<10% — commodity (원가싸움, −penalty)" />
          <Legend color="#f97316" label="10–20% — tight" />
          <Legend color="#6b7280" label="20–35% — normal" />
          <Legend color="#10b981" label="35–60% — loose (+bonus)" />
          <Legend color="#3b82f6" label="≥60% — wild (앵커링 미형성)" />
        </div>
      </section>

      {/* 키워드별 violin/dot */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-3">
          키워드별 가격 분포 (median 기준 normalized · 점 = listing)
        </h2>
        <div className="space-y-3">
          {sorted.slice(0, 30).map((r) => (
            <DotStrip key={r.id} row={r} />
          ))}
        </div>
      </section>

      {/* 테이블 */}
      <section className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">keyword</th>
              <th className="px-3 py-2 text-right">n</th>
              <th className="px-3 py-2 text-right">median</th>
              <th className="px-3 py-2 text-right">p25 ~ p75</th>
              <th className="px-3 py-2 text-right">min ~ max</th>
              <th className="px-3 py-2 text-right">CV</th>
              <th className="px-3 py-2 text-right">IQR/med</th>
              <th className="px-3 py-2 text-right">gap</th>
              <th className="px-3 py-2 text-left">signal</th>
              <th className="px-3 py-2 text-left">수집</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((r) => {
              const sig = classifyCV(r.cv)
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-medium">
                    {r.productId ? (
                      <Link
                        href={`/admin/trend-radar/products/${r.productId}`}
                        className="hover:underline"
                      >
                        {r.keyword}
                      </Link>
                    ) : (
                      r.keyword
                    )}
                    {r.categoryTop && (
                      <span className="ml-2 text-[10px] text-gray-400">{r.categoryTop}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{r.nListings}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{fmtKRW(r.median)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                    {fmtKRW(r.p25)} ~ {fmtKRW(r.p75)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-400">
                    {fmtKRW(r.min)} ~ {fmtKRW(r.max)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold">
                    {fmtPct(r.cv, 1)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{fmtPct(r.iqrRatio, 1)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{fmtPct(r.minmaxGap, 0)}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{ background: sig.color, color: 'white' }}
                    >
                      {sig.tag} {sig.signal > 0 ? `+${sig.signal}` : sig.signal === 0 ? '0' : sig.signal}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-gray-400">
                    {r.collectedAt.slice(5, 16).replace('T', ' ')}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-3 h-3 rounded" style={{ background: color, opacity: 0.7 }} />
      <span className="text-gray-600">{label}</span>
    </span>
  )
}

function DotStrip({ row }: { row: SnapshotRow }) {
  const sig = classifyCV(row.cv)
  const median = row.median ?? 0
  if (!row.prices.length || median <= 0) {
    return (
      <div className="text-xs text-gray-400 font-mono">
        {row.keyword} — no listings
      </div>
    )
  }
  // ratio = price / median 으로 normalize. clip to 0.3 ~ 2.0
  const ratios = row.prices.map((p) => Math.max(0.3, Math.min(2.0, p / median)))
  const W = 600
  const xScale = (r: number) => ((r - 0.3) / (2.0 - 0.3)) * W

  const p25R = row.p25 != null ? row.p25 / median : null
  const p75R = row.p75 != null ? row.p75 / median : null
  const minR = row.min != null ? Math.max(0.3, row.min / median) : null
  const maxR = row.max != null ? Math.min(2.0, row.max / median) : null

  return (
    <div className="flex items-center gap-3">
      <div className="w-44 truncate text-xs">
        {row.productId ? (
          <Link
            href={`/admin/trend-radar/products/${row.productId}`}
            className="font-medium hover:underline"
          >
            {row.keyword}
          </Link>
        ) : (
          <span className="font-medium">{row.keyword}</span>
        )}
        <div className="text-[10px] text-gray-400 font-mono">
          n={row.nListings} · CV {fmtPct(row.cv, 1)}
        </div>
      </div>
      <div className="relative flex-1" style={{ height: 36 }}>
        <svg width={W} height={36} className="block">
          {/* min~max range */}
          {minR != null && maxR != null && (
            <line
              x1={xScale(minR)}
              x2={xScale(maxR)}
              y1={18}
              y2={18}
              stroke="#e5e7eb"
              strokeWidth={2}
            />
          )}
          {/* p25~p75 band (진입 권장 구간) */}
          {p25R != null && p75R != null && (
            <rect
              x={xScale(Math.max(0.3, p25R))}
              y={10}
              width={xScale(Math.min(2.0, p75R)) - xScale(Math.max(0.3, p25R))}
              height={16}
              fill={sig.color}
              fillOpacity={0.15}
              stroke={sig.color}
              strokeOpacity={0.4}
              strokeWidth={1}
            />
          )}
          {/* median line */}
          <line x1={xScale(1.0)} x2={xScale(1.0)} y1={6} y2={30} stroke="#000" strokeWidth={1} />
          {/* dots */}
          {ratios.map((r, i) => (
            <circle
              key={i}
              cx={xScale(r)}
              cy={18 + ((i % 5) - 2) * 2}
              r={2.5}
              fill={sig.color}
              fillOpacity={0.7}
            />
          ))}
        </svg>
      </div>
      <div className="w-28 text-right text-[10px] font-mono text-gray-500">
        {fmtKRW(row.median)}
      </div>
    </div>
  )
}
