import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface VelocityRow {
  product_id: string
  sku_count: number
  weekly_new_reviews: number
  avg_price: number | null
  avg_rating: number | null
  total_reviews: number
  last_captured_at: string
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}
interface SkuRow {
  product_id: string
  sku_url: string
  seller: string | null
  title: string | null
  price: number | null
  review_count: number | null
  rating: number | null
  prev_review_count: number | null
  delta_review_7d: number
  captured_at: string
}

async function fetchVelocity() {
  const sb = createAdminClient()
  const { data, error } = await sb
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('jimscanner_serp_product_velocity' as any)
    .select('*')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .order('weekly_new_reviews' as any, { ascending: false })
    .limit(200)
  return { rows: ((data ?? []) as unknown as VelocityRow[]), error: error?.message ?? null }
}

async function fetchTopSkus(productIds: string[]) {
  if (productIds.length === 0) return [] as SkuRow[]
  const sb = createAdminClient()
  const { data } = await sb
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('jimscanner_serp_sku_velocity' as any)
    .select('*')
    .in('product_id', productIds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .order('delta_review_7d' as any, { ascending: false })
    .limit(50)
  return (data ?? []) as unknown as SkuRow[]
}

async function fetchProducts(ids: string[]) {
  if (ids.length === 0) return new Map<string, ProductRow>()
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const map = new Map<string, ProductRow>()
  for (const p of (data ?? []) as ProductRow[]) map.set(p.id, p)
  return map
}

export default async function SalesVelocityPage() {
  const { rows, error } = await fetchVelocity()
  const topIds = rows.slice(0, 30).map((r) => r.product_id)
  const [productMap, topSkus] = await Promise.all([
    fetchProducts(rows.map((r) => r.product_id)),
    fetchTopSkus(topIds),
  ])

  const totalWeeklyReviews = rows.reduce((a, r) => a + (r.weekly_new_reviews ?? 0), 0)
  const totalSkus = rows.reduce((a, r) => a + (r.sku_count ?? 0), 0)
  const productsWithVelocity = rows.filter((r) => (r.weekly_new_reviews ?? 0) > 0).length

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">📈 Sales Velocity</h1>
        <p className="text-sm text-gray-500 mt-1">
          스마트스토어 SERP top 10 SKU 누적 리뷰 델타 → 시장 실판매 속도 proxy.
          <br />
          (관심 ≠ 실판매. <code>trend_score</code> 는 검색·뉴스·TV 관심량, 이 페이지는 SKU 회전 속도.)
        </p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="추적 상품" value={rows.length} hint="SERP 1회 이상 캡처" />
        <KpiCard label="속도 발생 상품" value={productsWithVelocity} hint="주간 신규 리뷰 ≥ 1" />
        <KpiCard label="누적 추적 SKU" value={totalSkus} hint="top 10 × 상품" />
        <KpiCard
          label="주간 신규 리뷰 합계"
          value={totalWeeklyReviews}
          hint="시장 전체 회전 proxy"
        />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          뷰 조회 실패: {error}
          <br />
          <span className="text-xs text-red-600">
            <code>supabase/trends_v5_serp_skus.sql</code> 가 아직 적용되지 않았을 수 있다.
          </span>
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-2">상품별 실판매 속도 Top 200</h2>
        {rows.length === 0 ? (
          <div className="rounded border border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-500">
            아직 캡처 데이터 없음. <code>/api/cron/collect-smartstore-serp</code> 가 실행되어야 합니다.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">canonical 상품</th>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-right">주간 신규 리뷰</th>
                  <th className="px-3 py-2 text-right">누적 리뷰</th>
                  <th className="px-3 py-2 text-right">SKU 수</th>
                  <th className="px-3 py-2 text-right">평균가</th>
                  <th className="px-3 py-2 text-right">평균 별점</th>
                  <th className="px-3 py-2 text-right">최근 캡처</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r, i) => {
                  const p = productMap.get(r.product_id)
                  return (
                    <tr key={r.product_id} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 font-mono text-gray-400">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="text-blue-700 hover:underline"
                        >
                          {p?.canonical_name ?? r.product_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-500">{p?.category_top ?? '—'}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-bold ${
                          (r.weekly_new_reviews ?? 0) >= 50
                            ? 'text-red-700'
                            : (r.weekly_new_reviews ?? 0) >= 10
                              ? 'text-amber-700'
                              : 'text-gray-700'
                        }`}
                      >
                        {r.weekly_new_reviews ?? 0}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{r.total_reviews ?? 0}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{r.sku_count}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                        {r.avg_price ? `${r.avg_price.toLocaleString()}원` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600">
                        {r.avg_rating ? r.avg_rating.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs text-gray-400 font-mono">
                        {r.last_captured_at?.slice(5, 16).replace('T', ' ')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {topSkus.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            🔥 SKU 단위 주간 신규 리뷰 Top 50{' '}
            <span className="text-xs font-normal text-gray-500 ml-2">
              (상위 30개 상품 내 SKU 한정)
            </span>
          </h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">상품 (canonical)</th>
                  <th className="px-3 py-2 text-left">판매자</th>
                  <th className="px-3 py-2 text-left">SKU 제목</th>
                  <th className="px-3 py-2 text-right">가격</th>
                  <th className="px-3 py-2 text-right">7d 신규</th>
                  <th className="px-3 py-2 text-right">누적</th>
                  <th className="px-3 py-2 text-right">별점</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {topSkus.map((s, i) => {
                  const p = productMap.get(s.product_id)
                  return (
                    <tr key={`${s.sku_url}-${i}`} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 text-xs">
                        {p?.canonical_name ?? s.product_id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-600">{s.seller ?? '—'}</td>
                      <td className="px-3 py-1.5">
                        <a
                          href={s.sku_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 hover:underline"
                        >
                          {s.title ?? s.sku_url.slice(0, 60)}
                        </a>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                        {s.price ? `${s.price.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right font-bold text-red-700">
                        {s.delta_review_7d}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{s.review_count ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">
                        {s.rating ? s.rating.toFixed(2) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="text-xs text-gray-500 pt-4 border-t border-gray-100">
        <strong>운영 노트.</strong>{' '}
        주 1~2회 <code>node --env-file=.env.local scripts/run-crons.mjs collect-smartstore-serp</code>{' '}
        실행으로 적재된다. delta 는 5일 이전 가장 가까운 캡처와의 차이로 계산하므로 첫 캡처 후
        주가 지나야 의미 있는 값이 나온다.
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  )
}
