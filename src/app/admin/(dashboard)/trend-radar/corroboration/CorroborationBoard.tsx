'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

export interface Modality {
  key: string
  label: string
  icon: string
  hint: string
}

// SQL jimscanner_trends_modality() · page.tsx SOURCE_TO_MODALITY 와 동기화
export const MODALITIES: Modality[] = [
  { key: 'search', label: '검색수요', icon: '🔍', hint: 'naver_search_trend · shopping_insight · google_suggest' },
  { key: 'shopping', label: '쇼핑베스트', icon: '🛍', hint: 'naver_shopping_hot · musinsa · aliex · domeggook' },
  { key: 'community', label: '커뮤니티', icon: '💬', hint: '82cook · natepan · ppomppu · dcinside · clien' },
  { key: 'tv', label: 'TV홈쇼핑', icon: '📺', hint: 'naver_tvtime' },
  { key: 'news', label: '뉴스', icon: '📰', hint: 'daum · naver · kca' },
]

export interface BoardRow {
  product_id: string
  name: string
  category: string
  cells: Record<string, number> // modality key → alias count
  breadth: number
  total_aliases: number
  independence: number
  final_score: number | null
  trend_score: number | null
  source_consensus: number | null
}

type Filter = 'all' | 'vulnerable' | 'durable'

function heatColor(count: number, max: number): string {
  if (count === 0) return 'bg-gray-50 text-gray-300'
  const ratio = max > 0 ? count / max : 0
  if (ratio > 0.66) return 'bg-emerald-600 text-white'
  if (ratio > 0.33) return 'bg-emerald-400 text-white'
  return 'bg-emerald-100 text-emerald-800'
}

function breadthBadge(b: number): string {
  if (b >= 4) return 'bg-emerald-100 text-emerald-700'
  if (b === 3) return 'bg-lime-100 text-lime-700'
  if (b === 2) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

export default function CorroborationBoard({ rows }: { rows: BoardRow[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')

  const maxCell = useMemo(() => {
    let m = 1
    for (const r of rows) for (const k of Object.keys(r.cells)) m = Math.max(m, r.cells[k])
    return m
  }, [rows])

  const stats = useMemo(() => {
    const vulnerable = rows.filter((r) => r.breadth <= 1).length
    const durable = rows.filter((r) => r.breadth >= 3).length
    const avg = rows.length ? rows.reduce((a, r) => a + r.breadth, 0) / rows.length : 0
    return { total: rows.length, vulnerable, durable, avg }
  }, [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'vulnerable' && r.breadth > 1) return false
      if (filter === 'durable' && r.breadth < 3) return false
      if (needle && !r.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [rows, filter, q])

  return (
    <div className="space-y-4">
      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="분류 상품" value={stats.total} />
        <Stat label="평균 breadth" value={stats.avg.toFixed(2)} />
        <Stat label="durable (≥3 모달리티)" value={stats.durable} tone="emerald" />
        <Stat label="단일소스 취약 (≤1)" value={stats.vulnerable} tone="red" />
      </div>

      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded border border-gray-200 overflow-hidden text-sm">
          {([
            ['all', `전체 (${stats.total})`],
            ['durable', `durable (${stats.durable})`],
            ['vulnerable', `취약 스파이크 (${stats.vulnerable})`],
          ] as [Filter, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 ${
                filter === key ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="상품명 검색…"
          className="border border-gray-200 rounded px-3 py-1.5 text-sm flex-1 min-w-[160px]"
        />
      </div>

      <p className="text-xs text-gray-500">
        모달리티 범례:{' '}
        {MODALITIES.map((m) => (
          <span key={m.key} className="mr-3" title={m.hint}>
            {m.icon} {m.label}
          </span>
        ))}
      </p>

      {/* 히트맵 + 랭킹 테이블 */}
      <div className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="px-3 py-2 text-left sticky left-0 bg-gray-50">상품</th>
              {MODALITIES.map((m) => (
                <th key={m.key} className="px-2 py-2 text-center" title={m.hint}>
                  {m.icon}
                  <div className="font-normal">{m.label}</div>
                </th>
              ))}
              <th className="px-2 py-2 text-center">breadth</th>
              <th className="px-2 py-2 text-right">독립성</th>
              <th className="px-2 py-2 text-right">consensus</th>
              <th className="px-2 py-2 text-right">final</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((r) => (
              <tr key={r.product_id} className="hover:bg-gray-50">
                <td className="px-3 py-1.5 sticky left-0 bg-white">
                  <Link
                    href={`/admin/trend-radar/products/${r.product_id}`}
                    className="text-gray-900 hover:underline"
                  >
                    {r.name}
                  </Link>
                  <span className="ml-2 text-[10px] text-gray-400">{r.category}</span>
                </td>
                {MODALITIES.map((m) => {
                  const c = r.cells[m.key] ?? 0
                  return (
                    <td key={m.key} className="px-1 py-1 text-center">
                      <span
                        className={`inline-block min-w-[28px] rounded px-1.5 py-0.5 text-xs font-mono ${heatColor(
                          c,
                          maxCell,
                        )}`}
                      >
                        {c || '·'}
                      </span>
                    </td>
                  )
                })}
                <td className="px-2 py-1 text-center">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${breadthBadge(r.breadth)}`}>
                    {r.breadth}/5
                  </span>
                </td>
                <td className="px-2 py-1 text-right font-mono text-xs text-gray-600">
                  {r.independence.toFixed(2)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-xs text-gray-500">
                  {r.source_consensus != null ? r.source_consensus : '—'}
                </td>
                <td className="px-2 py-1 text-right font-bold">{r.final_score ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
          조건에 맞는 상품 없음.
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'emerald' | 'red' }) {
  const color = tone === 'emerald' ? 'text-emerald-600' : tone === 'red' ? 'text-red-600' : 'text-gray-900'
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )
}
