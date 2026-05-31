'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { formatKrwShort, type Band } from '@/lib/trends/market-size'

export interface MarketRow {
  id: string
  name: string
  category: string
  finalScore: number
  trendScore: number
  competitionScore: number
  searchSource: 'anchor' | 'estimated'
  priceSource: 'market' | 'wholesale_markup' | 'none'
  avgPrice: number
  monthlySearches: number
  estimatedSellers: number
  myRank: number
  gmv: Record<Band, number>
  sam: Record<Band, number>
  sortKey: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

const BAND_LABEL: Record<Band, string> = {
  conservative: '보수',
  base: '기본',
  optimistic: '낙관',
}

const METRIC_LABEL = {
  gmv: '예상 월 거래액 (GMV · 시장 전체)',
  sam: '획득가능 월 매출 (SAM · 내 몫)',
} as const

export default function MarketSizeBoard({ rows }: { rows: MarketRow[] }) {
  const [band, setBand] = useState<Band>('base')
  const [metric, setMetric] = useState<'gmv' | 'sam'>('gmv')

  const sorted = useMemo(
    () => [...rows].sort((a, b) => b[metric][band] - a[metric][band]),
    [rows, metric, band],
  )

  // 카테고리 합계 막대
  const byCategory = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + r[metric][band])
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows, metric, band])
  const catMax = Math.max(1, ...byCategory.map(([, v]) => v))

  const top = sorted.slice(0, 30)
  const rankMax = Math.max(1, ...top.map((r) => r[metric][band]))

  const totals = useMemo(() => {
    const sum = (b: Band) => rows.reduce((a, r) => a + r[metric][b], 0)
    return { conservative: sum('conservative'), base: sum('base'), optimistic: sum('optimistic') }
  }, [rows, metric])

  return (
    <div className="space-y-6">
      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="inline-flex rounded border border-gray-200 overflow-hidden">
          {(['gmv', 'sam'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={`px-3 py-1.5 text-sm ${
                metric === m ? 'bg-black text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {m === 'gmv' ? 'GMV (시장 전체)' : 'SAM (내 몫)'}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded border border-gray-200 overflow-hidden">
          {(['conservative', 'base', 'optimistic'] as Band[]).map((b) => (
            <button
              key={b}
              onClick={() => setBand(b)}
              className={`px-3 py-1.5 text-sm ${
                band === b ? 'bg-black text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {BAND_LABEL[b]}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          {METRIC_LABEL[metric]} · {BAND_LABEL[band]}밴드 기준 · 단위 원/월
        </span>
      </div>

      {/* 총합 3밴드 카드 */}
      <section className="grid grid-cols-3 gap-3">
        {(['conservative', 'base', 'optimistic'] as Band[]).map((b) => (
          <div
            key={b}
            className={`rounded border p-3 text-center ${
              band === b ? 'border-black' : 'border-gray-200'
            }`}
          >
            <div className="text-xs text-gray-500">{BAND_LABEL[b]} · 전체 {metric.toUpperCase()} 합</div>
            <div className="mt-1 text-2xl font-bold">{formatKrwShort(totals[b])}원</div>
          </div>
        ))}
      </section>

      {/* 카테고리 합계 막대 */}
      <section className="rounded border border-gray-200 p-4">
        <h3 className="text-sm font-semibold mb-3">카테고리별 {metric.toUpperCase()} 합계</h3>
        <div className="space-y-2">
          {byCategory.map(([c, v]) => (
            <div key={c} className="flex items-center gap-3">
              <div className="w-20 text-xs text-gray-600 shrink-0">{c}</div>
              <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${(v / catMax) * 100}%`,
                    background: CATEGORY_COLORS[c] ?? '#6b7280',
                    opacity: 0.7,
                  }}
                />
              </div>
              <div className="w-24 text-right text-xs font-mono text-gray-700 shrink-0">
                {formatKrwShort(v)}원
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* KRW 내림차순 랭킹 */}
      <section className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left w-8">#</th>
              <th className="px-3 py-2 text-left">상품</th>
              <th className="px-3 py-2 text-right">{metric.toUpperCase()} ({BAND_LABEL[band]})</th>
              <th className="px-3 py-2 text-right hidden md:table-cell">평균가</th>
              <th className="px-3 py-2 text-right hidden md:table-cell">월검색</th>
              <th className="px-3 py-2 text-right hidden lg:table-cell">경쟁셀러</th>
              <th className="px-3 py-2 text-right">trend</th>
              <th className="px-3 py-2 text-right">comp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {top.map((r, i) => {
              const val = r[metric][band]
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-400 font-mono">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/trend-radar/products/${r.id}`}
                      className="flex items-center gap-2 hover:underline"
                    >
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: CATEGORY_COLORS[r.category] ?? '#6b7280' }}
                      />
                      <span className="truncate max-w-[280px]">{r.name}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="hidden sm:block w-20 h-2 bg-gray-100 rounded overflow-hidden">
                        <div
                          className="h-full"
                          style={{
                            width: `${(val / rankMax) * 100}%`,
                            background: CATEGORY_COLORS[r.category] ?? '#6b7280',
                            opacity: 0.7,
                          }}
                        />
                      </div>
                      <span className="font-mono font-semibold">{formatKrwShort(val)}원</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right hidden md:table-cell font-mono text-gray-600">
                    {r.priceSource === 'none' ? (
                      <span className="text-amber-500" title="도매가·시장가 미확보">–</span>
                    ) : (
                      `${formatKrwShort(r.avgPrice)}`
                    )}
                  </td>
                  <td className="px-3 py-2 text-right hidden md:table-cell font-mono text-gray-600">
                    {r.monthlySearches.toLocaleString('ko-KR')}
                    {r.searchSource === 'estimated' && (
                      <span className="text-[10px] text-amber-500 ml-0.5" title="trend_score 근사(앵커 미적재)">
                        ~
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right hidden lg:table-cell font-mono text-gray-500">
                    {r.estimatedSellers}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600">{r.trendScore}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{r.competitionScore}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-gray-400">
        ⚠️ 추정치. 검색수 앵커(<span className="font-mono">~</span> = trend_score 근사),
        전환율·마크업은 카테고리 기본값. 도매가/시장가 미확보 상품은 평균가 –.
        SAM = GMV ÷ (추정 경쟁셀러+1), 균등분배·후순위 페널티 가정.
      </p>
    </div>
  )
}
