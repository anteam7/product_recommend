import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const FOREIGN_MARKETS = [
  { source: 'amazon_best_us', market: 'us', label: '🇺🇸 Amazon US' },
  { source: 'rakuten_best_jp', market: 'jp', label: '🇯🇵 Rakuten JP' },
  { source: 'taobao_best_cn', market: 'cn', label: '🇨🇳 Taobao CN' },
] as const

interface LagRow {
  category_top: string
  foreign_market: string
  kr_proxy_source: string
  median_lag_days: number
  p25_lag_days: number | null
  p75_lag_days: number | null
  n_pairs: number
  confidence: number | null
}

interface CandidateRow {
  keyword: string
  foreign_source: string
  category_top: string | null
  first_foreign_seen_at: string
  last_foreign_seen_at: string
  kr_entry_deadline: string
  d_day_remaining: number | null
  median_lag_days: number | null
  n_pairs: number | null
  confidence: number | null
}

interface GgsanMatch {
  goods_no: string
  title: string
  price_krw: number | null
  detail_url: string | null
  is_imminent: boolean | null
}

async function fetchData() {
  const sb = createAdminClient()

  // 시차 통계 + 후보 동시 조회. ggsan_products 매칭은 keyword 들이 모이고 나서 별도 조회.
  const [lagRes, candidatesRes] = await Promise.all([
    sb
      .from('jimscanner_trends_market_lag' as never)
      .select('*')
      .order('confidence', { ascending: false }) as unknown as Promise<{ data: LagRow[] | null }>,
    sb
      .from('jimscanner_trends_arbitrage_candidates' as never)
      .select('*')
      .limit(40) as unknown as Promise<{ data: CandidateRow[] | null }>,
  ])

  const lags = (lagRes.data ?? []) as LagRow[]
  const candidates = (candidatesRes.data ?? []) as CandidateRow[]

  // ggsan 위탁 가능 후보 매칭 — keyword 부분일치 (간단 ilike).
  // 키워드 수가 적으니 병렬 호출. cap 20.
  const matchesByKeyword = new Map<string, GgsanMatch[]>()
  const targets = candidates.slice(0, 20)
  if (targets.length > 0) {
    const results = await Promise.all(
      targets.map((c) =>
        sb
          .from('jimscanner_ggsan_products')
          .select('goods_no, title, price_krw, detail_url, is_imminent')
          .ilike('title', `%${c.keyword.split(/[\s,]/)[0]}%`)
          .limit(3)
      )
    )
    targets.forEach((c, i) => {
      const data = (results[i].data ?? []) as GgsanMatch[]
      if (data.length > 0) matchesByKeyword.set(c.keyword, data)
    })
  }

  // 히트맵 — (category_top × foreign_market) → median_lag_days (kr_proxy_source 별 평균).
  const heat = new Map<string, Map<string, { sum: number; n: number; conf: number }>>()
  const categorySet = new Set<string>()
  for (const r of lags) {
    categorySet.add(r.category_top)
    if (!heat.has(r.category_top)) heat.set(r.category_top, new Map())
    const inner = heat.get(r.category_top)!
    if (!inner.has(r.foreign_market))
      inner.set(r.foreign_market, { sum: 0, n: 0, conf: 0 })
    const cell = inner.get(r.foreign_market)!
    cell.sum += Number(r.median_lag_days)
    cell.n += 1
    cell.conf = Math.max(cell.conf, r.confidence ?? 0)
  }
  const categories = Array.from(categorySet).sort()

  return { lags, candidates, heat, categories, matchesByKeyword }
}

function lagColor(days: number | null): string {
  if (days == null) return 'bg-gray-100 text-gray-400'
  if (days <= 7) return 'bg-red-200 text-red-900 font-bold'
  if (days <= 14) return 'bg-orange-200 text-orange-900'
  if (days <= 30) return 'bg-yellow-200 text-yellow-900'
  if (days <= 60) return 'bg-green-200 text-green-900'
  return 'bg-blue-100 text-blue-800'
}

function dDayBadge(d: number | null): { text: string; cls: string } {
  if (d == null) return { text: '—', cls: 'bg-gray-100 text-gray-500' }
  if (d <= 0) return { text: '마감', cls: 'bg-red-600 text-white font-bold' }
  if (d <= 3) return { text: `D-${d}`, cls: 'bg-red-500 text-white font-bold' }
  if (d <= 7) return { text: `D-${d}`, cls: 'bg-orange-500 text-white' }
  if (d <= 14) return { text: `D-${d}`, cls: 'bg-yellow-400 text-yellow-900' }
  return { text: `D-${d}`, cls: 'bg-gray-200 text-gray-700' }
}

function foreignLabel(source: string): string {
  const f = FOREIGN_MARKETS.find((m) => m.source === source)
  return f?.label ?? source
}

export default async function ArbitrageLagPage() {
  const { lags, candidates, heat, categories, matchesByKeyword } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Global→KR 시차 차익 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            해외 best 진입 → 한국 SERP 진입 lag 학습 · 미진입 후보 D-day
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-600">
        <strong className="text-gray-800">데이터 흐름:</strong>{' '}
        <code className="px-1 bg-gray-100 rounded">scripts/fetch-foreign-best.mjs</code> 가 Amazon US /
        Rakuten JP / Taobao CN 베스트셀러를{' '}
        <code className="px-1 bg-gray-100 rounded">jimscanner_trends_keywords</code> 에 적재 →{' '}
        <code className="px-1 bg-gray-100 rounded">jimscanner_trends_market_lag</code> 에 시차 분포
        학습(외부 잡) →{' '}
        <code className="px-1 bg-gray-100 rounded">jimscanner_trends_arbitrage_candidates</code>{' '}
        뷰로 미진입 후보 추출. ggsan 매칭은 keyword 첫 토큰 ilike.
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 좌측: 시차 히트맵 */}
        <section className="rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold mb-3">
            시장×카테고리 시차 히트맵{' '}
            <span className="text-xs font-normal text-gray-500 ml-1">
              (중앙값 lag, 일수 · 색 = 빠를수록 빨강)
            </span>
          </h2>
          {categories.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-8">
              아직 학습된 시차 데이터 없음.
              <br />
              <code className="text-xs">supabase/trends_market_lag.sql</code> 적용 후
              fetch-foreign-best cron 누적 필요.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead>
                  <tr>
                    <th className="text-left p-2 text-xs text-gray-500">카테고리</th>
                    {FOREIGN_MARKETS.map((m) => (
                      <th key={m.market} className="p-2 text-xs text-gray-500 text-center">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {categories.map((cat) => (
                    <tr key={cat}>
                      <td className="p-2 font-medium text-gray-700">{cat}</td>
                      {FOREIGN_MARKETS.map((m) => {
                        const cell = heat.get(cat)?.get(m.market)
                        const avg = cell ? cell.sum / cell.n : null
                        return (
                          <td key={m.market} className="p-1 text-center">
                            <div className={`rounded px-2 py-2 text-xs ${lagColor(avg)}`}>
                              {avg != null ? `${Math.round(avg)}d` : '—'}
                              {cell && cell.conf > 0 && (
                                <div className="text-[10px] opacity-60 mt-0.5">
                                  conf {Math.round(cell.conf * 100)}%
                                </div>
                              )}
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <details className="mt-4 text-xs text-gray-500">
            <summary className="cursor-pointer hover:text-black">
              raw lag 통계 ({lags.length} row)
            </summary>
            <div className="mt-2 max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left p-1">cat</th>
                    <th className="text-left p-1">market</th>
                    <th className="text-left p-1">proxy</th>
                    <th className="text-right p-1">p25</th>
                    <th className="text-right p-1">med</th>
                    <th className="text-right p-1">p75</th>
                    <th className="text-right p-1">n</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lags.map((r, i) => (
                    <tr key={i}>
                      <td className="p-1">{r.category_top}</td>
                      <td className="p-1">{r.foreign_market}</td>
                      <td className="p-1 font-mono">{r.kr_proxy_source}</td>
                      <td className="p-1 text-right">{r.p25_lag_days ?? '—'}</td>
                      <td className="p-1 text-right font-semibold">{r.median_lag_days}</td>
                      <td className="p-1 text-right">{r.p75_lag_days ?? '—'}</td>
                      <td className="p-1 text-right">{r.n_pairs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>

        {/* 우측: 미진입 후보 카드 */}
        <section className="rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold mb-3">
            🔥 미진입 후보{' '}
            <span className="text-xs font-normal text-gray-500 ml-1">
              (해외 best 14d 내 · 한국 30d 부재) · {candidates.length}건
            </span>
          </h2>
          {candidates.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-8">
              현재 미진입 후보 없음.
              <br />
              fetch-foreign-best 누적 후 다시 확인.
            </div>
          ) : (
            <div className="space-y-2 max-h-[640px] overflow-y-auto">
              {candidates.map((c, i) => {
                const dday = dDayBadge(c.d_day_remaining)
                const matches = matchesByKeyword.get(c.keyword) ?? []
                return (
                  <div
                    key={i}
                    className="border border-gray-200 rounded p-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="font-medium text-sm">{c.keyword}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {foreignLabel(c.foreign_source)} · {c.category_top ?? 'uncat'}
                          {c.median_lag_days != null && (
                            <>
                              {' '}
                              · 학습 lag {Math.round(c.median_lag_days)}d (n={c.n_pairs ?? 0})
                            </>
                          )}
                        </div>
                      </div>
                      <span className={`px-2 py-1 rounded text-xs ${dday.cls}`}>{dday.text}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      해외 진입 {c.first_foreign_seen_at?.slice(0, 10)} → 한국 마감{' '}
                      {c.kr_entry_deadline?.slice(0, 10)}
                    </div>
                    {matches.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-gray-100">
                        <div className="text-[10px] text-gray-500 mb-1">
                          ggsan 위탁 후보 ({matches.length})
                        </div>
                        <div className="space-y-1">
                          {matches.map((m) => (
                            <a
                              key={m.goods_no}
                              href={m.detail_url ?? '#'}
                              target="_blank"
                              rel="noreferrer"
                              className="block text-xs hover:text-blue-700"
                            >
                              <span className="font-mono text-gray-400 mr-1">{m.goods_no}</span>
                              {m.title}
                              {m.price_krw != null && (
                                <span className="ml-2 text-gray-600 font-mono">
                                  ₩{m.price_krw.toLocaleString()}
                                </span>
                              )}
                              {m.is_imminent && (
                                <span className="ml-1 text-red-600 font-semibold">[임박]</span>
                              )}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
