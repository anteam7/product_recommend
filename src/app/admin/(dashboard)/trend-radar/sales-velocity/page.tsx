import Link from 'next/link'
import { fetchTopAccelSkus } from '@/lib/trend-radar/sales-estimate'

export const dynamic = 'force-dynamic'

export default async function SalesVelocityPage() {
  const rows = await fetchTopAccelSkus(50)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🚀 최근 14일 가속 SKU</h1>
          <p className="text-sm text-gray-500 mt-1">
            리뷰 적립속도 기반 추정 일판매량 — 최근 7일 합 ÷ 이전 7일 합 = 가속도 비율
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">스냅샷 데이터 부족</div>
          <div className="text-xs text-gray-400">
            <code className="font-mono">jimscanner_competitor_review_snapshots</code> 에 2일 이상 적재되어야 표시됩니다.
            <br />
            cron: 일 1회 쿠팡/스마트스토어 경쟁 SKU 의 review_count 수집.
          </div>
        </div>
      ) : (
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-left">channel</th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-right">이전 7d 추정</th>
                <th className="px-3 py-2 text-right">최근 7d 추정</th>
                <th className="px-3 py-2 text-right">가속도</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => {
                const hot = r.accel_ratio >= 1.5
                return (
                  <tr key={r.competitor_sku_id} className={hot ? 'bg-amber-50' : ''}>
                    <td className="px-3 py-2 font-mono text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2">
                      {r.product_id ? (
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="hover:underline font-medium"
                        >
                          {r.product_name ?? '(미명명 상품)'}
                        </Link>
                      ) : (
                        <span className="text-gray-400">미연결</span>
                      )}
                    </td>
                    <td className="px-3 py-2 uppercase text-xs">{r.channel}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-600">{r.external_sku_id}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.est_sales_prior7.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.est_sales_recent7.toLocaleString()}</td>
                    <td className={`px-3 py-2 text-right font-bold ${hot ? 'text-amber-700' : ''}`}>
                      {r.accel_ratio >= 99 ? 'NEW' : `${r.accel_ratio.toFixed(2)}×`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 가속도 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          est_daily_sales = ΔReviews/day ÷ channel_review_rate
          <br />
          accel_ratio = Σ(최근 7d est_daily_sales) ÷ Σ(이전 7d est_daily_sales)
          <br />
          기본 review_rate: coupang 2.5% · smartstore 1.5% (자기 SKU 캘리브레이션 후 갱신)
        </code>
      </section>
    </div>
  )
}
