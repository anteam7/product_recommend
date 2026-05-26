'use client'

import { useMemo, useState, useTransition } from 'react'

export interface SeedYieldRow {
  seed_id: string
  source: string
  kind: string
  label: string
  config: Record<string, unknown> | null
  is_active: boolean
  display_order: number
  runs_30d: number
  inserted_30d: number
  fetched_30d: number
  errors_30d: number
  last_run_at: string | null
  runs_90d: number
  inserted_90d: number
  matched_keywords_30d: number
  pinned_30d: number
  pinned_90d: number
  inserted_per_pin_90d: number | null
  prune_candidate: boolean
}

type SortKey =
  | 'source'
  | 'label'
  | 'inserted_30d'
  | 'inserted_90d'
  | 'pinned_30d'
  | 'pinned_90d'
  | 'inserted_per_pin_90d'
  | 'matched_keywords_30d'
  | 'last_run_at'
  | 'display_order'

function ageStr(iso: string | null): string {
  if (!iso) return '—'
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export default function SeedsTable({ rows: initialRows }: { rows: SeedYieldRow[] }) {
  const [rows, setRows] = useState(initialRows)
  const [sortKey, setSortKey] = useState<SortKey>('inserted_30d')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive' | 'prune'>('all')
  const [isPending, startTransition] = useTransition()

  const sorted = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (filter === 'active') return r.is_active
      if (filter === 'inactive') return !r.is_active
      if (filter === 'prune') return r.prune_candidate
      return true
    })
    const factor = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor
      return String(av).localeCompare(String(bv)) * factor
    })
  }, [rows, sortKey, sortDir, filter])

  function clickSort(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(k)
      setSortDir('desc')
    }
  }

  async function toggleActive(row: SeedYieldRow) {
    const next = !row.is_active
    setRows((rs) => rs.map((r) => (r.seed_id === row.seed_id ? { ...r, is_active: next } : r)))
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/trends/seeds/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seed_id: row.seed_id, is_active: next }),
        })
        if (!res.ok) throw new Error(await res.text())
      } catch (e) {
        // 롤백
        setRows((rs) => rs.map((r) => (r.seed_id === row.seed_id ? { ...r, is_active: !next } : r)))
        alert(`토글 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  async function adjustOrder(row: SeedYieldRow, delta: number) {
    const next = row.display_order + delta
    setRows((rs) =>
      rs.map((r) => (r.seed_id === row.seed_id ? { ...r, display_order: next } : r)),
    )
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/trends/seeds/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seed_id: row.seed_id, display_order: next }),
        })
        if (!res.ok) throw new Error(await res.text())
      } catch (e) {
        setRows((rs) =>
          rs.map((r) => (r.seed_id === row.seed_id ? { ...r, display_order: row.display_order } : r)),
        )
        alert(`순서 변경 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  const headerCell = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => (
    <th
      key={key}
      onClick={() => clickSort(key)}
      className={`px-2 py-2 cursor-pointer select-none ${align === 'right' ? 'text-right' : 'text-left'} hover:bg-gray-100`}
      title="클릭하여 정렬"
    >
      {label}
      {sortKey === key && <span className="ml-1 text-gray-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="text-gray-500">필터:</span>
        {(['all', 'active', 'inactive', 'prune'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded border px-2 py-1 ${
              filter === f ? 'border-black bg-black text-white' : 'border-gray-300 hover:bg-gray-50'
            }`}
          >
            {f === 'all' && '전체'}
            {f === 'active' && '활성'}
            {f === 'inactive' && '비활성'}
            {f === 'prune' && `휴면 후보`}
          </button>
        ))}
        {isPending && <span className="text-gray-400 ml-2">저장 중…</span>}
      </div>

      <div className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {headerCell('source', 'source', 'left')}
              {headerCell('label', 'label', 'left')}
              <th className="px-2 py-2 text-left">kind</th>
              {headerCell('inserted_30d', 'ins 30d')}
              {headerCell('inserted_90d', 'ins 90d')}
              {headerCell('matched_keywords_30d', 'matched 30d')}
              {headerCell('pinned_30d', 'pin 30d')}
              {headerCell('pinned_90d', 'pin 90d')}
              {headerCell('inserted_per_pin_90d', 'ins/pin')}
              {headerCell('last_run_at', 'last run')}
              {headerCell('display_order', 'order')}
              <th className="px-2 py-2 text-left">active</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-4 text-center text-gray-400">
                  데이터 없음 — 마이그레이션(supabase/trends_v4_seed_yield.sql) 적용 후 cron 1회 이상 발화 필요.
                </td>
              </tr>
            )}
            {sorted.map((r) => {
              const danger = r.prune_candidate
              return (
                <tr key={r.seed_id} className={danger ? 'bg-red-50' : r.is_active ? '' : 'bg-gray-50 text-gray-400'}>
                  <td className="px-2 py-1 font-mono">{r.source}</td>
                  <td className="px-2 py-1">{r.label}</td>
                  <td className="px-2 py-1 text-gray-500">{r.kind}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.inserted_30d}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.inserted_90d}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.matched_keywords_30d}</td>
                  <td className="px-2 py-1 text-right tabular-nums font-semibold">{r.pinned_30d}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.pinned_90d}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {r.inserted_per_pin_90d == null ? '∞' : r.inserted_per_pin_90d.toFixed(1)}
                  </td>
                  <td className="px-2 py-1 text-right text-gray-500">{ageStr(r.last_run_at)}</td>
                  <td className="px-2 py-1 text-right">
                    <span className="tabular-nums">{r.display_order}</span>{' '}
                    <button
                      className="ml-1 text-gray-400 hover:text-black"
                      onClick={() => adjustOrder(r, -1)}
                      title="위로"
                    >
                      ▲
                    </button>
                    <button
                      className="ml-1 text-gray-400 hover:text-black"
                      onClick={() => adjustOrder(r, +1)}
                      title="아래로"
                    >
                      ▼
                    </button>
                  </td>
                  <td className="px-2 py-1">
                    <button
                      className={`rounded border px-2 py-0.5 text-xs ${
                        r.is_active
                          ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                          : 'border-gray-300 bg-white text-gray-500 hover:bg-gray-50'
                      }`}
                      onClick={() => toggleActive(r)}
                    >
                      {r.is_active ? '활성' : '휴면'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
