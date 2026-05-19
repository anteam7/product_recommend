import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface FunnelRow {
  keyword: string
  category: string | null
  info_peak_at: string | null
  txn_peak_at: string | null
  info_first_at: string | null
  txn_first_at: string | null
  lag_days: number | null
  info_total: number
  txn_total: number
  info_peak_cnt: number
  txn_peak_cnt: number
  conversion_ratio: number | null
  stage: 'info_only' | 'txn_only' | 'info_leads' | 'txn_leads' | 'simultaneous'
  d_day: number | null
}

async function fetchData() {
  const sb = createAdminClient()

  // 뷰는 아직 generate 안 된 타입 — as any 캐스팅
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_intent_funnel')
    .select('*')
    .order('info_peak_at', { ascending: false, nullsFirst: false })
    .limit(500)

  const rows = (data ?? []) as FunnelRow[]

  // 카테고리별 평균 lag (info_leads 만)
  const byCategory = new Map<string, { lags: number[]; count: number }>()
  for (const r of rows) {
    if (r.stage !== 'info_leads' || r.lag_days == null) continue
    const cat = r.category ?? '미분류'
    const bucket = byCategory.get(cat) ?? { lags: [], count: 0 }
    bucket.lags.push(r.lag_days)
    bucket.count++
    byCategory.set(cat, bucket)
  }
  const categoryLag = Array.from(byCategory.entries())
    .map(([cat, { lags, count }]) => ({
      category: cat,
      avg_lag_days: Math.round(
        (lags.reduce((a, b) => a + b, 0) / Math.max(1, lags.length)) * 10,
      ) / 10,
      sample_size: count,
    }))
    .sort((a, b) => b.sample_size - a.sample_size)

  // info_only = 정보형 떴는데 거래형 아직 → 진입 골든타임
  const goldenTime = rows
    .filter((r) => r.stage === 'info_only' && r.info_peak_cnt >= 2)
    .sort((a, b) => {
      // d_day 작은 순 (임박), info_peak_cnt 큰 순
      const da = a.d_day ?? 999
      const db = b.d_day ?? 999
      if (da !== db) return da - db
      return b.info_peak_cnt - a.info_peak_cnt
    })
    .slice(0, 24)

  // info_leads = 이미 전환된 학습 데이터
  const completedFunnel = rows
    .filter((r) => r.stage === 'info_leads')
    .sort((a, b) => (b.txn_peak_at ?? '').localeCompare(a.txn_peak_at ?? ''))
    .slice(0, 50)

  return {
    rows,
    goldenTime,
    completedFunnel,
    categoryLag,
    error: error?.message ?? null,
  }
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  return d.slice(5, 10) // MM-DD
}

function dDayBadge(d: number | null): { label: string; cls: string } {
  if (d == null) return { label: '—', cls: 'bg-gray-100 text-gray-500' }
  if (d <= 0) return { label: 'D-0 (지금)', cls: 'bg-red-100 text-red-700' }
  if (d <= 3) return { label: `D-${d}`, cls: 'bg-orange-100 text-orange-700' }
  if (d <= 7) return { label: `D-${d}`, cls: 'bg-amber-100 text-amber-700' }
  return { label: `D-${d}`, cls: 'bg-emerald-100 text-emerald-700' }
}

export default async function IntentFunnelPage() {
  const { rows, goldenTime, completedFunnel, categoryLag, error } = await fetchData()

  const totalKeywords = rows.length
  const infoOnly = rows.filter((r) => r.stage === 'info_only').length
  const infoLeads = rows.filter((r) => r.stage === 'info_leads').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Intent Funnel — 정보→거래 전환 lag</h1>
          <p className="text-sm text-gray-500 mt-1">
            정보형(blog/news) 부상 → 거래형(shopping) 부상까지 lag 분석.{' '}
            <strong className="text-gray-800">info_only</strong> 단계가 진입 골든타임.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          뷰 조회 실패: {error}. supabase/trends_intent_funnel.sql 적용 여부 확인.
        </div>
      ) : null}

      <section className="grid grid-cols-4 gap-3">
        <Stat label="추적 키워드" value={totalKeywords} />
        <Stat label="진입 골든타임 (info_only)" value={infoOnly} accent="emerald" />
        <Stat label="학습된 전환 (info_leads)" value={infoLeads} />
        <Stat
          label="평균 lag (전체)"
          value={
            categoryLag.length === 0
              ? '—'
              : `${Math.round(
                  (categoryLag.reduce(
                    (acc, c) => acc + c.avg_lag_days * c.sample_size,
                    0,
                  ) /
                    Math.max(
                      1,
                      categoryLag.reduce((acc, c) => acc + c.sample_size, 0),
                    )) *
                    10,
                ) / 10}d`
          }
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          ⏰ 진입 골든타임 — 정보형은 떴는데 거래형은 아직
        </h2>
        {goldenTime.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            아직 후보 없음. naver_blog/naver_news 누적이 더 필요.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {goldenTime.map((r) => {
              const badge = dDayBadge(r.d_day)
              return (
                <div
                  key={r.keyword}
                  className="rounded border border-gray-200 p-3 hover:border-emerald-400 hover:shadow-sm transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-gray-900 truncate" title={r.keyword}>
                      {r.keyword}
                    </div>
                    <span
                      className={`shrink-0 text-xs font-mono px-2 py-0.5 rounded ${badge.cls}`}
                    >
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-gray-500 space-y-0.5">
                    <div>
                      정보형 부상: <span className="font-mono">{fmtDate(r.info_peak_at)}</span>
                      <span className="text-gray-400"> · {r.info_peak_cnt}건</span>
                    </div>
                    <div>
                      거래형 부상: <span className="text-gray-400">— (대기)</span>
                    </div>
                    <div>
                      카테고리: <span className="text-gray-700">{r.category ?? '미분류'}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          카테고리별 평균 lag (학습된 info_leads 만)
        </h2>
        {categoryLag.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
            아직 학습 데이터 부족.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">category</th>
                  <th className="px-3 py-2 text-right">avg lag (days)</th>
                  <th className="px-3 py-2 text-right">samples</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {categoryLag.map((c) => (
                  <tr key={c.category}>
                    <td className="px-3 py-1 font-mono">{c.category}</td>
                    <td className="px-3 py-1 text-right">{c.avg_lag_days}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{c.sample_size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          최근 완료된 전환 (info_leads) — 학습 신호
        </h2>
        {completedFunnel.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
            아직 완료된 전환 없음.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">keyword</th>
                  <th className="px-3 py-2 text-left">category</th>
                  <th className="px-3 py-2 text-right">info peak</th>
                  <th className="px-3 py-2 text-right">txn peak</th>
                  <th className="px-3 py-2 text-right">lag (days)</th>
                  <th className="px-3 py-2 text-right">info / txn 누적</th>
                  <th className="px-3 py-2 text-right">conv ratio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {completedFunnel.map((r) => (
                  <tr key={r.keyword}>
                    <td className="px-3 py-1 font-medium">{r.keyword}</td>
                    <td className="px-3 py-1 text-gray-600">{r.category ?? '미분류'}</td>
                    <td className="px-3 py-1 text-right font-mono">{fmtDate(r.info_peak_at)}</td>
                    <td className="px-3 py-1 text-right font-mono">{fmtDate(r.txn_peak_at)}</td>
                    <td className="px-3 py-1 text-right font-semibold">{r.lag_days}</td>
                    <td className="px-3 py-1 text-right text-gray-500">
                      {r.info_total} / {r.txn_total}
                    </td>
                    <td className="px-3 py-1 text-right text-gray-500">
                      {r.conversion_ratio ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 leading-relaxed">
        <strong className="text-gray-700">알파:</strong> 거래형이 폭발한 뒤에 보면 늦다.
        info_only 단계의 D-day 카드 = 정보형 검색이 떴지만 쇼핑 검색은 아직 잠잠한 키워드.
        카테고리별 평균 lag 으로 거래형 부상 예상 시점을 D-day 로 노출한다.
        뷰 정의: <span className="font-mono">supabase/trends_intent_funnel.sql</span>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number | string
  accent?: 'emerald'
}) {
  const tone =
    accent === 'emerald'
      ? 'border-emerald-200 bg-emerald-50'
      : 'border-gray-200 bg-white'
  return (
    <div className={`rounded border ${tone} p-3`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
    </div>
  )
}
