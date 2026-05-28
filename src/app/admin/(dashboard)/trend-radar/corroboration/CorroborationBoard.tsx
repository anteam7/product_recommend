'use client'

import { useMemo, useState } from 'react'

export const AXIS_ORDER = [
  'naver_search_trend',
  'naver_shopping_insight',
  'naver_tvtime',
  'naver_news',
  'naver_blog',
  'google_suggest',
  'quasarzone_sale',
  'clien_park',
] as const
export type AxisKey = (typeof AXIS_ORDER)[number]

const AXIS_LABEL: Record<AxisKey, string> = {
  naver_search_trend: '검색트렌드',
  naver_shopping_insight: '쇼핑인사이트',
  naver_tvtime: 'TV편성',
  naver_news: '뉴스',
  naver_blog: '블로그',
  google_suggest: '구글자동완성',
  quasarzone_sale: '핫딜(퀘이사)',
  clien_park: '커뮤니티(클리언)',
}

export interface CorroborationRow {
  keyword: string
  keyword_norm: string
  source_count: number
  diversity_index: number
  score: number
  axes: Record<AxisKey, { norm: number; raw: number }>
}

type SortKey = 'score' | 'diversity' | 'source_count'

function polygonPoints(norms: number[], size: number) {
  // norms.length = 8 axes, equally spaced around center.
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 2
  const n = norms.length
  return norms
    .map((v, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
      const radius = Math.max(0, Math.min(1, v)) * r
      const x = cx + Math.cos(angle) * radius
      const y = cy + Math.sin(angle) * radius
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function gridPolygon(size: number, fraction: number) {
  const cx = size / 2
  const cy = size / 2
  const r = (size / 2 - 2) * fraction
  const n = 8
  return Array.from({ length: n }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    return `${(cx + Math.cos(angle) * r).toFixed(1)},${(cy + Math.sin(angle) * r).toFixed(1)}`
  }).join(' ')
}

function MiniRadar({ row, size = 40 }: { row: CorroborationRow; size?: number }) {
  const norms = AXIS_ORDER.map((k) => row.axes[k]?.norm ?? 0)
  const fill = row.diversity_index > 0.6 ? '#10b981' : row.diversity_index > 0.3 ? '#f59e0b' : '#ef4444'
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="inline-block">
      <polygon points={gridPolygon(size, 1)} fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
      <polygon points={gridPolygon(size, 0.5)} fill="none" stroke="#f3f4f6" strokeWidth="0.5" />
      <polygon points={polygonPoints(norms, size)} fill={fill} fillOpacity={0.35} stroke={fill} strokeWidth="1" />
    </svg>
  )
}

function BigRadar({ row, size = 280 }: { row: CorroborationRow; size?: number }) {
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 30
  const n = AXIS_ORDER.length
  const norms = AXIS_ORDER.map((k) => row.axes[k]?.norm ?? 0)
  const fill = row.diversity_index > 0.6 ? '#10b981' : row.diversity_index > 0.3 ? '#f59e0b' : '#ef4444'

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon
          key={f}
          points={Array.from({ length: n }, (_, i) => {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
            return `${(cx + Math.cos(a) * r * f).toFixed(1)},${(cy + Math.sin(a) * r * f).toFixed(1)}`
          }).join(' ')}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth="0.5"
        />
      ))}
      {AXIS_ORDER.map((_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + Math.cos(a) * r}
            y2={cy + Math.sin(a) * r}
            stroke="#e5e7eb"
            strokeWidth="0.5"
          />
        )
      })}
      <polygon
        points={norms
          .map((v, i) => {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
            const rad = Math.max(0, Math.min(1, v)) * r
            return `${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`
          })
          .join(' ')}
        fill={fill}
        fillOpacity={0.35}
        stroke={fill}
        strokeWidth="1.5"
      />
      {AXIS_ORDER.map((k, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
        const lx = cx + Math.cos(a) * (r + 14)
        const ly = cy + Math.sin(a) * (r + 14)
        return (
          <text
            key={k}
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="9"
            fill="#4b5563"
          >
            {AXIS_LABEL[k]}
          </text>
        )
      })}
    </svg>
  )
}

export default function CorroborationBoard({ rows }: { rows: CorroborationRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [excludeSingleSource, setExcludeSingleSource] = useState(false)
  const [selected, setSelected] = useState<CorroborationRow | null>(rows[0] ?? null)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let r = rows
    if (excludeSingleSource) r = r.filter((x) => x.source_count >= 2)
    if (q) r = r.filter((x) => x.keyword_norm.includes(q))
    const sortFn: Record<SortKey, (a: CorroborationRow, b: CorroborationRow) => number> = {
      score: (a, b) => b.score - a.score,
      diversity: (a, b) => b.diversity_index - a.diversity_index,
      source_count: (a, b) => b.source_count - a.source_count || b.score - a.score,
    }
    return [...r].sort(sortFn[sortKey])
  }, [rows, sortKey, excludeSingleSource, query])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex rounded border border-gray-200 overflow-hidden text-sm">
            {(['score', 'diversity', 'source_count'] as SortKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setSortKey(k)}
                className={`px-3 py-1 ${
                  sortKey === k ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {k === 'score' ? '점수' : k === 'diversity' ? '다양성' : '소스수'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={excludeSingleSource}
              onChange={(e) => setExcludeSingleSource(e.target.checked)}
            />
            단일소스 스파이크 제외 (≥2 소스만)
          </label>
          <input
            type="text"
            placeholder="키워드 검색…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="ml-auto px-2 py-1 border border-gray-200 rounded text-sm w-48"
          />
        </div>

        <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
          <div className="col-span-1">#</div>
          <div className="col-span-1">레이더</div>
          <div className="col-span-5">키워드</div>
          <div className="col-span-2 text-right">점수</div>
          <div className="col-span-1 text-right">소스</div>
          <div className="col-span-2 text-right">다양성</div>
        </div>

        <div className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
          {filtered.slice(0, 200).map((r, i) => {
            const active = selected?.keyword_norm === r.keyword_norm
            return (
              <button
                key={r.keyword_norm}
                onClick={() => setSelected(r)}
                className={`w-full grid grid-cols-12 px-3 py-2 text-left transition-colors items-center ${
                  active ? 'bg-amber-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="col-span-1 text-gray-400 font-mono text-xs">{i + 1}</div>
                <div className="col-span-1">
                  <MiniRadar row={r} />
                </div>
                <div className="col-span-5 truncate">
                  <div className="font-medium text-sm">{r.keyword}</div>
                  <div className="text-xs text-gray-400 truncate">{r.keyword_norm}</div>
                </div>
                <div className="col-span-2 text-right font-mono font-bold">{r.score.toFixed(2)}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{r.source_count}/8</div>
                <div className="col-span-2 text-right font-mono text-gray-600">
                  {(r.diversity_index * 100).toFixed(0)}%
                </div>
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-gray-500">조건에 맞는 키워드 없음.</div>
          )}
        </div>
      </div>

      <aside className="rounded border border-gray-200 p-4 h-fit sticky top-4">
        {selected ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-gray-500">선택된 키워드</div>
              <div className="text-base font-bold">{selected.keyword}</div>
            </div>

            <div className="flex justify-center">
              <BigRadar row={selected} />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded bg-gray-50 p-2">
                <div className="text-xs text-gray-500">score</div>
                <div className="font-bold">{selected.score.toFixed(2)}</div>
              </div>
              <div className="rounded bg-gray-50 p-2">
                <div className="text-xs text-gray-500">소스</div>
                <div className="font-bold">{selected.source_count}/8</div>
              </div>
              <div className="rounded bg-gray-50 p-2">
                <div className="text-xs text-gray-500">다양성</div>
                <div className="font-bold">{(selected.diversity_index * 100).toFixed(0)}%</div>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1">소스별 raw / norm</div>
              <div className="space-y-1">
                {AXIS_ORDER.map((k) => {
                  const v = selected.axes[k]
                  return (
                    <div key={k} className="flex items-center gap-2 text-xs">
                      <div className="w-28 text-gray-500">{AXIS_LABEL[k]}</div>
                      <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden">
                        <div
                          className="h-full bg-gray-700"
                          style={{ width: `${Math.min(100, v.norm * 100)}%` }}
                        />
                      </div>
                      <div className="w-10 text-right font-mono text-gray-600">{v.raw}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-500">행을 선택하세요.</div>
        )}
      </aside>
    </div>
  )
}
