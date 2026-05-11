'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

const SOURCES = [
  'google_suggest',
  'naver_news',
  'naver_blog',
  'clien_park',
  'quasarzone_sale',
  'kca_press',
] as const
type Source = (typeof SOURCES)[number]

const SOURCE_META: Record<Source, { label: string; icon: string; color: string }> = {
  google_suggest:   { label: 'Google 자동완성', icon: '🔎', color: 'bg-amber-100 text-amber-800' },
  naver_news:       { label: '네이버 뉴스',     icon: '📰', color: 'bg-emerald-100 text-emerald-800' },
  naver_blog:       { label: '네이버 블로그',   icon: '📓', color: 'bg-green-100 text-green-800' },
  clien_park:       { label: '클리앙',           icon: '🌳', color: 'bg-lime-100 text-lime-800' },
  quasarzone_sale:  { label: '퀘이사존 핫딜',   icon: '⚡', color: 'bg-fuchsia-100 text-fuchsia-800' },
  kca_press:        { label: '소비자원',         icon: '🛡️', color: 'bg-rose-100 text-rose-800' },
}

type Stat = {
  source: Source
  total: number
  last7d: number
  last24h: number
  last1h: number
}

type TrendDay = { day: string; counts: Record<string, number>; total: number }

type GovItem = {
  source: string
  title: string | null
  url: string | null
  query: string | null
  captured_at: string
  pubDate: string | null
}

type QueryItem = { query: string; count: number }
type DealItem = {
  title: string | null
  url: string | null
  site_label: string | null
  captured_at: string
}
type BlogItem = {
  title: string | null
  url: string | null
  query: string | null
  bloggername: string | null
  captured_at: string
}

export type Overview = {
  stats: Stat[]
  trend: TrendDay[]
  gov_recent: GovItem[]
  top_queries: QueryItem[]
  recent_deals: DealItem[]
  recent_blogs: BlogItem[]
  generated_at: string
}

type ListItem = {
  id: string
  source: Source
  title: string | null
  source_url: string | null
  query: string | null
  metadata: Record<string, unknown> | null
  captured_at: string
}

type ListResponse = {
  items: ListItem[]
  total: number
  page: number
  limit: number
  has_more: boolean
}

export default function MarketSignalsDashboard({ initial }: { initial: Overview }) {
  return (
    <div className="space-y-6">
      <StatsGrid stats={initial.stats} />
      <SuggestSeedPanel />
      <TrendChart trend={initial.trend} />
      <div className="grid lg:grid-cols-2 gap-4">
        <GovPanel items={initial.gov_recent} />
        <TopQueriesPanel items={initial.top_queries} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <DealsPanel items={initial.recent_deals} />
        <BlogsPanel items={initial.recent_blogs} />
      </div>
      <ExplorerPanel />
      <p className="text-[10px] text-gray-400 text-right">
        업데이트 {new Date(initial.generated_at).toLocaleString('ko-KR')}
      </p>
    </div>
  )
}

// ─── 시그널 기반 글감 추천 ───
type Suggestion = { keyword: string; category: string; angle: string; reason: string }
type SuggestResponse = {
  suggestions: Suggestion[]
  recommendedCategory: string
  signal_meta?: { counts?: Record<string, number> }
}

function SuggestSeedPanel() {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<SuggestResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/blog/suggest-keywords', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '추천 실패')
      setData(json as SuggestResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="bg-gradient-to-br from-indigo-50 to-white border border-indigo-200 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">🎯 시그널 기반 글감 추천</h2>
          <p className="text-xs text-gray-600 mt-0.5">
            현재 누적된 시그널(정부 공지·자동완성·핫딜·후기)을 컨텍스트로 Gemini 가 5개 키워드를 제안합니다.
          </p>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 shrink-0"
        >
          {loading ? '제안 생성 중… (15~30초)' : data ? '다시 받기' : '추천 받기'}
        </button>
      </div>
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      {data && (
        <>
          {data.signal_meta?.counts && (
            <div className="text-[11px] text-gray-500">
              근거 시그널 — 정부 {data.signal_meta.counts.gov ?? 0}건 · 자동완성 시드{' '}
              {data.signal_meta.counts.suggest_queries ?? 0}개 · 핫딜 {data.signal_meta.counts.deals ?? 0}건
            </div>
          )}
          <ul className="space-y-2">
            {data.suggestions.map((s, i) => {
              const params = new URLSearchParams({
                suggest_keyword: s.keyword,
                suggest_category: s.category,
                suggest_angle: s.angle ?? '',
              })
              return (
                <li
                  key={i}
                  className="bg-white border rounded-md p-3 hover:border-indigo-300 transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                        <span>{s.keyword}</span>
                        <span className="text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">
                          {s.category}
                        </span>
                      </div>
                      {s.angle && (
                        <div className="text-xs text-gray-700 mt-0.5">앵글: {s.angle}</div>
                      )}
                      {s.reason && (
                        <div className="text-[11px] text-gray-500 mt-0.5">💡 {s.reason}</div>
                      )}
                    </div>
                    <Link
                      href={`/admin/blog?${params.toString()}`}
                      className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 shrink-0 whitespace-nowrap"
                    >
                      이 키워드로 →
                    </Link>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

// ─── Stats grid ───
function StatsGrid({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map((s) => {
        const meta = SOURCE_META[s.source]
        return (
          <div key={s.source} className="bg-white border rounded-lg p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
              <span>{meta.icon}</span>
              <span className="truncate">{meta.label}</span>
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-gray-900">
              {s.total.toLocaleString()}
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500">
              <span>7d <span className="text-gray-700 font-medium">{s.last7d}</span></span>
              <span>24h <span className="text-gray-700 font-medium">{s.last24h}</span></span>
              <span>1h <span className="text-gray-700 font-medium">{s.last1h}</span></span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── 7일 추이 SVG 막대 그래프 ───
function TrendChart({ trend }: { trend: TrendDay[] }) {
  const max = Math.max(1, ...trend.map((d) => d.total))
  const colW = 70
  const chartH = 120
  const padding = { top: 16, bottom: 24, left: 8 }
  const totalH = chartH + padding.top + padding.bottom
  const totalW = trend.length * colW + padding.left * 2

  return (
    <section className="bg-white border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-gray-900">📈 최근 7일 적재 추이</h2>
        <div className="text-xs text-gray-500">일별 총합</div>
      </div>
      <div className="overflow-x-auto">
        <svg width={totalW} height={totalH} className="text-gray-700">
          {trend.map((d, i) => {
            const bh = (d.total / max) * chartH
            const x = padding.left + i * colW + 8
            const y = padding.top + (chartH - bh)
            const dayLabel = d.day.slice(5)
            return (
              <g key={d.day}>
                <rect
                  x={x}
                  y={y}
                  width={colW - 16}
                  height={bh}
                  rx={3}
                  className="fill-indigo-500"
                />
                <text
                  x={x + (colW - 16) / 2}
                  y={y - 4}
                  textAnchor="middle"
                  className="fill-gray-700 text-[11px] font-mono"
                >
                  {d.total}
                </text>
                <text
                  x={x + (colW - 16) / 2}
                  y={padding.top + chartH + 16}
                  textAnchor="middle"
                  className="fill-gray-500 text-[10px]"
                >
                  {dayLabel}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}

// ─── 정부 공지 패널 ───
function GovPanel({ items }: { items: GovItem[] }) {
  return (
    <section className="bg-white border rounded-lg p-4">
      <h2 className="text-sm font-bold text-gray-900 mb-3">🏛️ 정부 공지·보도 (최신)</h2>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500">아직 수집된 항목 없음</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => {
            const m = SOURCE_META[it.source as Source]
            return (
              <li key={i} className="text-xs border-b last:border-b-0 pb-2 last:pb-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${m?.color ?? 'bg-gray-100'}`}>
                    {m?.icon} {m?.label ?? it.source}
                  </span>
                  {it.query && <span className="text-[10px] text-gray-500">「{it.query}」</span>}
                </div>
                {it.url ? (
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-900 hover:text-blue-600 hover:underline line-clamp-2"
                  >
                    {it.title}
                  </a>
                ) : (
                  <span className="text-gray-900 line-clamp-2">{it.title}</span>
                )}
                <div className="text-[10px] text-gray-400 mt-0.5">
                  {new Date(it.captured_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ─── 인기 자동완성 query 패널 ───
function TopQueriesPanel({ items }: { items: QueryItem[] }) {
  const max = Math.max(1, ...items.map((q) => q.count))
  return (
    <section className="bg-white border rounded-lg p-4">
      <h2 className="text-sm font-bold text-gray-900 mb-3">🔎 자동완성이 풍부한 시드 query (TOP 12)</h2>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500">아직 수집된 항목 없음</p>
      ) : (
        <ul className="space-y-1">
          {items.map((q, i) => {
            const w = (q.count / max) * 100
            return (
              <li key={i} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-900 truncate">{q.query}</span>
                  <span className="font-mono text-gray-500 shrink-0">×{q.count}</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded overflow-hidden mt-0.5">
                  <div className="h-full bg-amber-400" style={{ width: `${w}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ─── 최근 핫딜 ───
function DealsPanel({ items }: { items: DealItem[] }) {
  return (
    <section className="bg-white border rounded-lg p-4">
      <h2 className="text-sm font-bold text-gray-900 mb-3">⚡ 최근 핫딜 (퀘이사존)</h2>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500">아직 수집된 항목 없음</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((d, i) => (
            <li key={i} className="text-xs flex items-start gap-2">
              {d.site_label && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 shrink-0">
                  {d.site_label}
                </span>
              )}
              {d.url ? (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-900 hover:text-blue-600 hover:underline line-clamp-1"
                >
                  {d.title}
                </a>
              ) : (
                <span className="text-gray-900 line-clamp-1">{d.title}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── 최근 블로그 후기 ───
function BlogsPanel({ items }: { items: BlogItem[] }) {
  return (
    <section className="bg-white border rounded-lg p-4">
      <h2 className="text-sm font-bold text-gray-900 mb-3">📓 최근 직구 후기 (네이버 블로그)</h2>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500">아직 수집된 항목 없음</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((b, i) => (
            <li key={i} className="text-xs">
              {b.url ? (
                <a
                  href={b.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-900 hover:text-blue-600 hover:underline line-clamp-1"
                >
                  {b.title}
                </a>
              ) : (
                <span className="text-gray-900 line-clamp-1">{b.title}</span>
              )}
              <div className="text-[10px] text-gray-500 mt-0.5">
                {b.query && <span>「{b.query}」 · </span>}
                {b.bloggername && <span>{b.bloggername}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ─── 탐색기 (필터·검색·페이지네이션) ───
function ExplorerPanel() {
  const [source, setSource] = useState<'' | Source>('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [limit] = useState(50)
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (source) params.set('source', source)
        if (q.trim()) params.set('q', q.trim())
        params.set('page', String(page))
        params.set('limit', String(limit))
        const res = await fetch(`/api/admin/market-signals/list?${params.toString()}`)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? '조회 실패')
        if (!cancelled) setData(json as ListResponse)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '오류')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [source, q, page, limit])

  function changeSource(next: '' | Source) {
    setPage(1)
    setSource(next)
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setPage(1)
    // q 변경은 상태로만 이미 트리거됨 — 그냥 reset page
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <section className="bg-white border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-bold text-gray-900">🗂️ 전체 데이터 탐색</h2>
        <span className="text-xs text-gray-500">
          {data && `${data.total.toLocaleString()}건 / 페이지 ${data.page} / ${totalPages}`}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => changeSource('')}
          className={`text-xs px-2.5 py-1 rounded border ${
            source === ''
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
              : 'border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          전체
        </button>
        {SOURCES.map((s) => (
          <button
            key={s}
            onClick={() => changeSource(s)}
            className={`text-xs px-2.5 py-1 rounded border ${
              source === s
                ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {SOURCE_META[s].icon} {SOURCE_META[s].label}
          </button>
        ))}
      </div>

      <form onSubmit={submitSearch} className="flex gap-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="제목으로 검색 (예: 아이폰 직구)"
          className="flex-1 border rounded-md px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50"
        >
          검색
        </button>
      </form>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      <div className="border rounded-md overflow-x-auto">
        <table className="w-full text-xs min-w-[760px]">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">소스</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">제목</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">query</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600 whitespace-nowrap">수집</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-500">불러오는 중…</td></tr>
            ) : !data || data.items.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-500">결과 없음</td></tr>
            ) : (
              data.items.map((it) => {
                const m = SOURCE_META[it.source]
                return (
                  <tr key={it.id} className="border-b last:border-b-0 hover:bg-gray-50/50 align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${m?.color ?? 'bg-gray-100'}`}>
                        {m?.icon} {m?.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {it.source_url ? (
                        <a
                          href={it.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-900 hover:text-blue-600 hover:underline line-clamp-2"
                        >
                          {it.title || '(제목 없음)'}
                        </a>
                      ) : (
                        <span className="text-gray-900 line-clamp-2">{it.title || '(제목 없음)'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600 max-w-[160px] truncate">
                      {it.query || '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {new Date(it.captured_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > data.limit && (
        <div className="flex items-center justify-between text-xs">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
            className="px-3 py-1 rounded border border-gray-300 disabled:opacity-50 hover:bg-gray-50"
          >
            ← 이전
          </button>
          <span className="text-gray-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!data.has_more || loading}
            className="px-3 py-1 rounded border border-gray-300 disabled:opacity-50 hover:bg-gray-50"
          >
            다음 →
          </button>
        </div>
      )}
    </section>
  )
}
