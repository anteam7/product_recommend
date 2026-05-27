'use client'
import { useMemo, useState, useEffect } from 'react'

interface LeadLagRow {
  lead_category: string
  lag_category: string
  best_lag: number
  best_r: number
  n_overlap: number
  lead_accel: number
  lead_latest: number
  lag_latest: number
}

interface OverlayRow {
  series_kind: 'lead_series' | 'lag_series' | 'lead_top_keyword'
  day: string | null
  category: string
  keyword: string | null
  value: number
  extra: { recent3?: number; prev7?: number; last_rank?: number } | null
}

function rColor(r: number) {
  if (r >= 0.7) return '#065f46'
  if (r >= 0.5) return '#10b981'
  if (r >= 0.3) return '#a7f3d0'
  if (r >= 0.1) return '#fef3c7'
  if (r >= -0.1) return '#f3f4f6'
  if (r >= -0.3) return '#fee2e2'
  return '#fca5a5'
}

export default function LeadLagBoard({ rows }: { rows: LeadLagRow[] }) {
  const cats = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      set.add(r.lead_category)
      set.add(r.lag_category)
    }
    return [...set].sort()
  }, [rows])

  const cellMap = useMemo(() => {
    const m = new Map<string, LeadLagRow>()
    for (const r of rows) m.set(`${r.lead_category}__${r.lag_category}`, r)
    return m
  }, [rows])

  const [selected, setSelected] = useState<{ lead: string; lag: string } | null>(null)
  const [overlay, setOverlay] = useState<OverlayRow[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!selected) return
    setLoading(true)
    setOverlay(null)
    fetch(
      `/api/admin/trend-radar/leadlag/overlay?lead=${encodeURIComponent(
        selected.lead,
      )}&lag=${encodeURIComponent(selected.lag)}`,
    )
      .then((res) => res.json())
      .then((j) => setOverlay(j.rows ?? []))
      .catch(() => setOverlay([]))
      .finally(() => setLoading(false))
  }, [selected])

  const selectedCell = selected
    ? cellMap.get(`${selected.lead}__${selected.lag}`)
    : undefined

  return (
    <div className="space-y-6">
      <section className="rounded border border-gray-200 p-4 overflow-x-auto">
        <div className="text-xs text-gray-500 mb-2">
          행 = 선행 카테고리 · 열 = 후행 카테고리 · 셀 = best lag (일) / r ·
          셀 클릭 → 시계열 + 선행 키워드
        </div>
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="border border-gray-200 p-1 bg-gray-50 sticky left-0 z-10">
                선행 ＼ 후행
              </th>
              {cats.map((c) => (
                <th
                  key={c}
                  className="border border-gray-200 p-1 bg-gray-50 font-medium whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map((leadCat) => (
              <tr key={leadCat}>
                <td className="border border-gray-200 p-1 bg-gray-50 font-medium whitespace-nowrap sticky left-0 z-10">
                  {leadCat}
                </td>
                {cats.map((lagCat) => {
                  if (leadCat === lagCat) {
                    return (
                      <td
                        key={lagCat}
                        className="border border-gray-200 p-1 text-center bg-gray-100 text-gray-300"
                      >
                        —
                      </td>
                    )
                  }
                  const row = cellMap.get(`${leadCat}__${lagCat}`)
                  if (!row) {
                    return (
                      <td
                        key={lagCat}
                        className="border border-gray-200 p-1 text-center text-gray-300"
                      >
                        ·
                      </td>
                    )
                  }
                  const r = Number(row.best_r ?? 0)
                  const isSel =
                    selected?.lead === leadCat && selected?.lag === lagCat
                  return (
                    <td
                      key={lagCat}
                      onClick={() => setSelected({ lead: leadCat, lag: lagCat })}
                      style={{ background: rColor(r) }}
                      className={`border p-1 text-center cursor-pointer hover:outline hover:outline-2 hover:outline-black ${
                        isSel ? 'outline outline-2 outline-black' : 'border-gray-200'
                      }`}
                      title={`r=${r.toFixed(3)} · lag=${row.best_lag}d · n=${row.n_overlap} · 가속=${Number(row.lead_accel).toFixed(2)}`}
                    >
                      <div className="font-mono font-semibold">
                        {Number(row.best_lag)}d
                      </div>
                      <div className="font-mono text-[10px] text-gray-700">
                        {r.toFixed(2)}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <Legend />
      </section>

      {selected && (
        <section className="rounded border border-gray-200 p-4">
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <div className="text-sm font-semibold">
              {selected.lead} → {selected.lag}
              {selectedCell ? (
                <span className="ml-3 text-xs text-gray-500 font-normal">
                  best lag={Number(selectedCell.best_lag)}일 · r=
                  {Number(selectedCell.best_r).toFixed(3)} · n=
                  {selectedCell.n_overlap} · 가속=
                  {Number(selectedCell.lead_accel).toFixed(2)}
                </span>
              ) : null}
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-xs text-gray-500 hover:text-black"
            >
              닫기 ✕
            </button>
          </div>
          {loading && <div className="text-sm text-gray-500">로딩…</div>}
          {!loading && overlay && (
            <OverlayChart overlay={overlay} lead={selected.lead} lag={selected.lag} />
          )}
        </section>
      )}
    </div>
  )
}

function Legend() {
  const stops = [
    { l: 'r ≥ 0.7', c: rColor(0.7) },
    { l: '≥ 0.5', c: rColor(0.5) },
    { l: '≥ 0.3', c: rColor(0.3) },
    { l: '≥ 0.1', c: rColor(0.1) },
    { l: '≈ 0', c: rColor(0) },
    { l: '< 0', c: rColor(-0.2) },
  ]
  return (
    <div className="flex items-center gap-3 mt-3 text-[10px] text-gray-600">
      범례:
      {stops.map((s) => (
        <span key={s.l} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 border border-gray-200"
            style={{ background: s.c }}
          />
          {s.l}
        </span>
      ))}
    </div>
  )
}

function OverlayChart({
  overlay,
  lead,
  lag,
}: {
  overlay: OverlayRow[]
  lead: string
  lag: string
}) {
  const leadSeries = overlay
    .filter((o) => o.series_kind === 'lead_series')
    .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''))
  const lagSeries = overlay
    .filter((o) => o.series_kind === 'lag_series')
    .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''))
  const keywords = overlay
    .filter((o) => o.series_kind === 'lead_top_keyword' && o.keyword)
    .sort((a, b) => Number(b.value) - Number(a.value))
    .slice(0, 10)

  const W = 720
  const H = 200
  const PAD = 30
  const allDays = [
    ...new Set(
      [...leadSeries, ...lagSeries].map((s) => s.day).filter(Boolean) as string[],
    ),
  ].sort()
  const allVals = [...leadSeries, ...lagSeries].map((s) => Number(s.value))
  const maxV = Math.max(1, ...allVals)
  const minV = Math.min(0, ...allVals)
  const xScale = (day: string) =>
    PAD +
    (allDays.indexOf(day) / Math.max(1, allDays.length - 1)) * (W - 2 * PAD)
  const yScale = (v: number) =>
    H - PAD - ((v - minV) / Math.max(0.001, maxV - minV)) * (H - 2 * PAD)

  const pathFrom = (rows: OverlayRow[], color: string) => {
    const d = rows
      .map((r, i) => `${i === 0 ? 'M' : 'L'} ${xScale(r.day!)} ${yScale(Number(r.value))}`)
      .join(' ')
    return <path d={d} fill="none" stroke={color} strokeWidth={2} />
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-4 text-xs mb-1">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-blue-600" /> {lead} (선행)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-red-500" /> {lag} (후행)
          </span>
        </div>
        <svg width={W} height={H} className="block">
          <line
            x1={PAD}
            y1={H - PAD}
            x2={W - PAD}
            y2={H - PAD}
            stroke="#e5e7eb"
          />
          <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#e5e7eb" />
          {pathFrom(leadSeries, '#2563eb')}
          {pathFrom(lagSeries, '#ef4444')}
          {allDays.length > 0 && (
            <>
              <text x={PAD} y={H - PAD + 14} fontSize="9" fill="#9ca3af">
                {allDays[0]}
              </text>
              <text
                x={W - PAD}
                y={H - PAD + 14}
                fontSize="9"
                fill="#9ca3af"
                textAnchor="end"
              >
                {allDays[allDays.length - 1]}
              </text>
            </>
          )}
        </svg>
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-700 mb-2">
          🔥 {lead} 최근 3일 급등 키워드 Top {keywords.length}
        </div>
        {keywords.length === 0 ? (
          <div className="text-xs text-gray-500">최근 3일 급등 키워드 없음</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
            {keywords.map((k, i) => (
              <div
                key={`${k.keyword}-${i}`}
                className="flex justify-between border-b border-gray-100 py-1"
              >
                <span>
                  <span className="font-mono text-gray-400 mr-2">{i + 1}.</span>
                  {k.keyword}
                </span>
                <span className="font-mono text-emerald-700">
                  +{Number(k.value).toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
