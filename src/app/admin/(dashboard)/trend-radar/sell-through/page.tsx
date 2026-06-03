import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// supabase/trends_serp_snapshot.sql 의 RPC 반환 형태
interface VelocityRow {
  coupang_item_id: string
  product_title: string | null
  keyword: string
  category_top: string | null
  rank: number | null
  price: number | null
  rating: number | null
  review_count: number
  prev_review_count: number | null
  delta_reviews: number
  delta_days: number
  review_rate: number
  daily_units: number
  monthly_units: number
  monthly_revenue: number
  first_captured_at: string
  last_captured_at: string
  snapshot_count: number
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

async function fetchVelocity(days: number) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/trends_serp_snapshot.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_serp_velocity' as never, {
    days_window: days,
    result_limit: 200,
  } as never)
  if (error) return { rows: [] as VelocityRow[], error: error.message }
  return { rows: (data ?? []) as VelocityRow[], error: null as string | null }
}

function buildHref(days: number): string {
  return `/admin/trend-radar/sell-through?days=${days}`
}

function won(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString()}만`
  return Math.round(n).toLocaleString()
}

export default async function SellThroughPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30

  const { rows, error } = await fetchVelocity(validDays)

  // velocity 계산이 가능한(연속 2스냅샷 + Δ>0) 후보만 강조
  const live = rows.filter((r) => r.delta_days > 0 && r.delta_reviews > 0)
  const totalMonthlyRevenue = live.reduce((s, r) => s + Number(r.monthly_revenue || 0), 0)
  const totalMonthlyUnits = live.reduce((s, r) => s + Number(r.monthly_units || 0), 0)
  const trackedItems = rows.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💰 실판매 속도 (Sell-through Velocity)</h1>
          <p className="text-sm text-gray-500 mt-1">
            경쟁 쿠팡 리스팅의 리뷰 증가량(Δreview/Δt)을 카테고리 리뷰작성률 역수로 보정 →
            <strong> 실제 월 판매수량·예상 월매출(₩)</strong>로 역산. &lsquo;관심도&rsquo;가 아니라 &lsquo;돈이 도는 속도&rsquo; 순.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 방법론 한계 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>추정치 주의</strong> · 리뷰작성률(기본 health 3% / living 2.5% / digital 2%)은 가정값.
        연속 두 스냅샷 차분 기반이므로 스냅샷이 1회뿐인 item 은 속도 0으로 표시됩니다.
        수집은 <code className="font-mono">scripts/collect-coupang-serp-snapshot.mjs</code> (Playwright) 주기 실행 후 누적됩니다.
      </div>

      {/* 기간 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(d.v)}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="추적 리스팅" value={trackedItems} />
        <Kpi label="속도 측정 가능" value={live.length} highlight={live.length > 0} />
        <Kpi label="합산 월 판매수량(추정)" value={`${Math.round(totalMonthlyUnits).toLocaleString()}개`} />
        <Kpi label="합산 월매출(추정)" value={`${won(totalMonthlyRevenue)}원`} highlight={totalMonthlyRevenue > 0} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_serp_velocity</code> 가 DB에 적용 안 됐을 가능성. supabase/trends_serp_snapshot.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 결과 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 스냅샷 없음</div>
          <div className="text-xs text-gray-400">
            <code className="font-mono">node --env-file=.env.local scripts/collect-coupang-serp-snapshot.mjs --keyword=&quot;멜라토닌&quot;</code>
            <br />
            를 주기 실행해 2회 이상 누적되면 속도가 계산됩니다.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">상품 / 키워드</th>
                <th className="px-3 py-2 text-right">가격</th>
                <th className="px-3 py-2 text-right">리뷰(Δ)</th>
                <th className="px-3 py-2 text-right">일 판매</th>
                <th className="px-3 py-2 text-right">월 판매</th>
                <th className="px-3 py-2 text-right">월매출(추정)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isLive = r.delta_days > 0 && r.delta_reviews > 0
                return (
                  <tr
                    key={r.coupang_item_id}
                    className={`border-t border-gray-100 ${isLive ? 'hover:bg-emerald-50/40' : 'opacity-60'}`}
                  >
                    <td className="px-3 py-2 text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-3 py-2">
                      <a
                        href={`https://www.coupang.com/vp/products/${r.coupang_item_id}`}
                        target="_blank"
                        rel="noopener"
                        className="font-medium text-gray-900 hover:underline line-clamp-1"
                        title={r.product_title ?? r.coupang_item_id}
                      >
                        {r.product_title ?? r.coupang_item_id}
                      </a>
                      <div className="text-xs text-gray-400 flex items-center gap-2">
                        <span>🔍 {r.keyword}</span>
                        {r.rank != null && <span>· SERP #{r.rank}</span>}
                        {r.category_top && <span>· {r.category_top}</span>}
                        {r.rating != null && <span>· ⭐{Number(r.rating).toFixed(1)}</span>}
                        <span>· 스냅 {r.snapshot_count}회</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.price ? `${r.price.toLocaleString()}원` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.review_count.toLocaleString()}
                      {r.delta_reviews > 0 && (
                        <span className="text-emerald-600 text-xs"> +{r.delta_reviews}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                      {isLive ? `${Number(r.daily_units).toLocaleString()}개` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {isLive ? `${Math.round(Number(r.monthly_units)).toLocaleString()}개` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">
                      {isLive ? `${won(Number(r.monthly_revenue))}원` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Sell-through Velocity 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          daily_units = (Δreview / Δday) ÷ review_rate
          <br />
          monthly_units = daily_units × 30
          <br />
          monthly_revenue(₩) = monthly_units × price
          <br />
          review_rate = 카테고리별 리뷰작성률 (health 0.03 / living 0.025 / digital 0.02)
        </code>
        <div className="pt-2">
          <strong>보강 예정:</strong> 실측 리뷰작성률 캘리브레이션 · recommend RPC final_score 에 velocity 가산 옵션 연결 · product_id 매핑 후 ggsan 소싱가 대비 마진 속도(₩마진/월) 산출
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
