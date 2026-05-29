'use client'

import { useMemo, useState } from 'react'

export type TrendItem = {
  keyword: string
  source: string
  category: string | null
  categoryTop: string | null
  volume: number | null
  estimatedMonthlyVolume: number | null
  anchorMonthlyTotal: number | null
  lastAt: string
  sparkline: number[]
  velocity: number | null
  pinned: boolean
  notes: string
  sampleCount: number
}

export type RunRow = {
  source: string
  status: string
  fetched: number
  inserted: number
  durationMs: number | null
  error: string | null
  startedAt: string
  triggeredBy: string | null
}

const SOURCE_LABELS: Record<string, string> = {
  naver_search_trend: '네이버 검색어',
  naver_shopping_insight: '네이버 쇼핑',
}

function formatVolume(n: number | null): string {
  if (n === null || n === undefined) return '—'
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}천`
  return String(n)
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '방금'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}분 전`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}시간 전`
  return `${Math.floor(diff / 86400_000)}일 전`
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length === 0) return <span className="text-xs text-gray-300">—</span>
  const max = Math.max(...data, 1)
  return (
    <div className="flex items-end gap-0.5 h-6">
      {data.map((v, i) => (
        <div
          key={i}
          className="w-1.5 bg-blue-400 rounded-sm"
          style={{ height: `${Math.max(2, (v / max) * 24)}px` }}
          title={String(v)}
        />
      ))}
    </div>
  )
}

function VelocityBadge({ v }: { v: number | null }) {
  if (v === null) return <span className="text-xs text-gray-300">—</span>
  const pct = v * 100
  const color = pct > 30 ? 'bg-rose-100 text-rose-700' : pct > 5 ? 'bg-amber-100 text-amber-700' : pct < -10 ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-700'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {pct > 0 ? '+' : ''}
      {pct.toFixed(0)}%
    </span>
  )
}

export default function TrendsPanel({ items: initialItems, runs }: { items: TrendItem[]; runs: RunRow[] }) {
  const [items, setItems] = useState<TrendItem[]>(initialItems)
  const [filterSource, setFilterSource] = useState<string>('all')
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [showPinnedOnly, setShowPinnedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [collecting, setCollecting] = useState<string | null>(null)
  const [collectMsg, setCollectMsg] = useState<string | null>(null)

  const categories = useMemo(() => {
    const s = new Set<string>()
    for (const it of items) {
      if (it.categoryTop) s.add(it.categoryTop)
    }
    return Array.from(s).sort()
  }, [items])

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (filterSource !== 'all' && it.source !== filterSource) return false
      if (filterCategory !== 'all' && it.categoryTop !== filterCategory) return false
      if (showPinnedOnly && !it.pinned) return false
      if (search && !it.keyword.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [items, filterSource, filterCategory, showPinnedOnly, search])

  async function togglePin(item: TrendItem) {
    const next = !item.pinned
    setItems((prev) =>
      prev.map((it) =>
        it.keyword === item.keyword && it.source === item.source ? { ...it, pinned: next } : it,
      ),
    )
    try {
      const res = await fetch('/api/admin/trends/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: item.keyword, source: item.source, pinned: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      // rollback
      setItems((prev) =>
        prev.map((it) =>
          it.keyword === item.keyword && it.source === item.source ? { ...it, pinned: !next } : it,
        ),
      )
      const msg = e instanceof Error ? e.message : String(e)
      setCollectMsg(`핀 변경 실패: ${msg}`)
    }
  }

  async function collect(source: string) {
    setCollecting(source)
    setCollectMsg(null)
    try {
      const res = await fetch('/api/admin/trends/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCollectMsg(`실패: ${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      const summary = (data.results as Array<{ source: string; fetched: number; inserted: number; status: string; error?: string }>)
        .map((r) => `${SOURCE_LABELS[r.source] ?? r.source}: ${r.status} fetched=${r.fetched} inserted=${r.inserted}${r.error ? ` (${r.error})` : ''}`)
        .join(' | ')
      setCollectMsg(`완료 — ${summary}. 페이지를 새로고침하면 최신 결과가 보입니다.`)
    } catch (e) {
      setCollectMsg(`실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCollecting(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* 수집 트리거 */}
      <div className="bg-white border rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-gray-900 mr-2">데이터 수집</h2>
          <button
            onClick={() => collect('naver_search_trend')}
            disabled={!!collecting}
            className="px-3 py-1.5 rounded-md border text-sm hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400"
          >
            {collecting === 'naver_search_trend' ? '수집 중…' : '검색어 트렌드'}
          </button>
          <button
            onClick={() => collect('naver_shopping_insight')}
            disabled={!!collecting}
            className="px-3 py-1.5 rounded-md border text-sm hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400"
          >
            {collecting === 'naver_shopping_insight' ? '수집 중…' : '쇼핑 카테고리'}
          </button>
          <button
            onClick={() => collect('all')}
            disabled={!!collecting}
            className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300"
          >
            {collecting === 'all' ? '수집 중…' : '전체'}
          </button>
        </div>
        {collectMsg && (
          <div className="mt-3 px-3 py-2 rounded bg-gray-50 text-xs text-gray-700">{collectMsg}</div>
        )}
      </div>

      {/* 필터 */}
      <div className="bg-white border rounded-lg p-4 flex flex-wrap items-center gap-3">
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          className="px-2 py-1 border rounded text-sm"
        >
          <option value="all">모든 소스</option>
          <option value="naver_search_trend">네이버 검색어</option>
          <option value="naver_shopping_insight">네이버 쇼핑</option>
        </select>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-2 py-1 border rounded text-sm"
        >
          <option value="all">모든 카테고리</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="키워드 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-2 py-1 border rounded text-sm flex-1 min-w-40"
        />
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input type="checkbox" checked={showPinnedOnly} onChange={(e) => setShowPinnedOnly(e.target.checked)} />
          핀만 보기
        </label>
        <span className="text-xs text-gray-500 ml-auto">{filtered.length} / {items.length} 표시</span>
      </div>

      {/* 키워드 테이블 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-8"></th>
              <th className="text-left px-3 py-2 font-medium">키워드</th>
              <th className="text-left px-3 py-2 font-medium">소스</th>
              <th className="text-left px-3 py-2 font-medium">카테고리</th>
              <th className="text-right px-3 py-2 font-medium">최근 ratio</th>
              <th className="text-right px-3 py-2 font-medium" title="검색광고 월간검색수 앵커 × ratio/100 — 그룹간 비교 가능한 실수요 추정치">추정 월검색수</th>
              <th className="text-right px-3 py-2 font-medium">7일 변동</th>
              <th className="text-left px-3 py-2 font-medium">7일 추이</th>
              <th className="text-left px-3 py-2 font-medium">갱신</th>
              <th className="text-right px-3 py-2 font-medium">액션</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-gray-400">
                  표시할 키워드가 없습니다. 상단 "수집" 버튼을 눌러 데이터를 가져오세요.
                </td>
              </tr>
            )}
            {filtered.map((it) => (
              <tr key={`${it.keyword}|${it.source}`} className={it.pinned ? 'bg-amber-50/40' : ''}>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => togglePin(it)}
                    aria-label="핀 토글"
                    className="text-base hover:scale-110 transition-transform"
                    title={it.pinned ? '핀 해제' : '글감 후보로 핀'}
                  >
                    {it.pinned ? '📌' : '📍'}
                  </button>
                </td>
                <td className="px-3 py-2 font-medium text-gray-900">{it.keyword}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{SOURCE_LABELS[it.source] ?? it.source}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{it.categoryTop ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{it.volume?.toFixed(1) ?? '—'}</td>
                <td
                  className="px-3 py-2 text-right tabular-nums font-medium text-gray-900"
                  title={it.anchorMonthlyTotal != null ? `그룹 앵커 ${it.anchorMonthlyTotal.toLocaleString()}/월` : '검색광고 앵커 없음 — collect-searchad-volume 수집 필요'}
                >
                  {formatVolume(it.estimatedMonthlyVolume)}
                </td>
                <td className="px-3 py-2 text-right"><VelocityBadge v={it.velocity} /></td>
                <td className="px-3 py-2"><Sparkline data={it.sparkline} /></td>
                <td className="px-3 py-2 text-xs text-gray-500">{formatTime(it.lastAt)}</td>
                <td className="px-3 py-2 text-right">
                  <span className="text-xs text-gray-400">{it.sampleCount}건</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 최근 run */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b">
          <h2 className="font-semibold text-gray-900">최근 수집 로그</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="text-left px-3 py-2 font-medium">시각</th>
              <th className="text-left px-3 py-2 font-medium">소스</th>
              <th className="text-left px-3 py-2 font-medium">트리거</th>
              <th className="text-left px-3 py-2 font-medium">상태</th>
              <th className="text-right px-3 py-2 font-medium">fetched</th>
              <th className="text-right px-3 py-2 font-medium">inserted</th>
              <th className="text-right px-3 py-2 font-medium">ms</th>
              <th className="text-left px-3 py-2 font-medium">에러</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-xs text-gray-400">아직 수집 이력 없음</td></tr>
            )}
            {runs.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 text-xs text-gray-600">{formatTime(r.startedAt)}</td>
                <td className="px-3 py-2 text-xs">{SOURCE_LABELS[r.source] ?? r.source}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{r.triggeredBy ?? '—'}</td>
                <td className="px-3 py-2 text-xs">
                  <span className={`inline-block px-1.5 py-0.5 rounded ${r.status === 'ok' ? 'bg-green-100 text-green-700' : r.status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-right">{r.fetched}</td>
                <td className="px-3 py-2 text-xs text-right">{r.inserted}</td>
                <td className="px-3 py-2 text-xs text-right">{r.durationMs ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-rose-600">{r.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
