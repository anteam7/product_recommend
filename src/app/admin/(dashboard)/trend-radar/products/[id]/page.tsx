import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  fetchProductSalesEstimate,
  fetchCompetitorSkus,
  fetchDailySales,
  type DailySalesRow,
} from '@/lib/trend-radar/sales-estimate'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  description: string | null
  intent_label: string | null
  llm_classified_at: string | null
  llm_model: string | null
  alias_count: number
  first_seen_at: string
  last_seen_at: string
}
interface AliasRow {
  alias: string
  alias_type: string
  source: string | null
  confidence: number
  classified_by: string | null
  created_at: string
}
interface ScoreRow {
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes] = await Promise.all([
    sb.from('jimscanner_trends_products').select('*').eq('id', id).single(),
    sb
      .from('jimscanner_trends_aliases')
      .select('alias, alias_type, source, confidence, classified_by, created_at')
      .eq('product_id', id)
      .order('confidence', { ascending: false }),
    sb
      .from('jimscanner_trends_scores')
      .select('trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at')
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(30),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
  }
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory } = data
  const latest = scoreHistory[0]

  const [salesEst, competitorSkus, dailySales] = await Promise.all([
    fetchProductSalesEstimate(id),
    fetchCompetitorSkus(id),
    fetchDailySales(id, 30),
  ])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">{product.canonical_name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {product.brand ? <span className="text-black font-medium">{product.brand}</span> : null}
            {product.brand ? ' · ' : ''}
            카테고리: {product.category_top}
            {product.category_mid ? ` / ${product.category_mid}` : ''} · alias {product.alias_count}건
          </p>
          {(product.intent_label || product.description) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {product.intent_label && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  🏷 {product.intent_label}
                </span>
              )}
              {product.description && (
                <span className="text-sm text-gray-700">{product.description}</span>
              )}
            </div>
          )}
          {product.llm_classified_at && (
            <p className="text-[10px] text-gray-400 mt-1 font-mono">
              LLM 분류: {product.llm_classified_at.slice(0, 19).replace('T', ' ')}
              {product.llm_model ? ` · ${product.llm_model}` : ''}
            </p>
          )}
        </div>
      </header>

      {/* 4점수 카드 */}
      {latest && (
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <ScoreCard label="final" value={latest.final_score} bold />
          <ScoreCard label="trend" value={latest.trend_score} />
          <ScoreCard label="commerce" value={latest.commerce_score} />
          <ScoreCard label="supplier" value={latest.supplier_score} />
          <ScoreCard label="competition" value={latest.competition_score} />
        </section>
      )}

      {/* 💰 추정 매출 보드 (리뷰 적립속도 기반) */}
      <SalesEstimateSection
        estimate={salesEst}
        skus={competitorSkus}
        daily={dailySales}
      />

      {/* score 시계열 (최근 30 row) */}
      {scoreHistory.length > 1 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">점수 추이 (최근 {scoreHistory.length}회 산출)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">computed_at</th>
                  <th className="px-3 py-2 text-right">final</th>
                  <th className="px-3 py-2 text-right">trend</th>
                  <th className="px-3 py-2 text-right">commerce</th>
                  <th className="px-3 py-2 text-right">supplier</th>
                  <th className="px-3 py-2 text-right">competition</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {scoreHistory.map((s, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1 font-mono text-gray-600">{s.computed_at?.slice(5, 19)}</td>
                    <td className="px-3 py-1 text-right font-bold">{s.final_score}</td>
                    <td className="px-3 py-1 text-right">{s.trend_score}</td>
                    <td className="px-3 py-1 text-right">{s.commerce_score}</td>
                    <td className="px-3 py-1 text-right">{s.supplier_score}</td>
                    <td className="px-3 py-1 text-right">{s.competition_score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* score breakdown */}
      {latest?.score_components && (
        <section>
          <h2 className="text-sm font-semibold mb-2">최신 score components</h2>
          <pre className="rounded border border-gray-200 p-3 text-xs overflow-x-auto bg-gray-50">
            {JSON.stringify(latest.score_components, null, 2)}
          </pre>
        </section>
      )}

      {/* aliases */}
      <section>
        <h2 className="text-sm font-semibold mb-2">매핑된 alias ({aliases.length})</h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {aliases.map((a, i) => (
            <div key={i} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
              <div className="col-span-7">{a.alias}</div>
              <div className="col-span-2 text-xs text-gray-500">{a.source ?? '—'}</div>
              <div className="col-span-2 text-xs text-gray-500">{a.classified_by ?? '—'}</div>
              <div className="col-span-1 text-right text-xs font-mono text-gray-600">
                {a.confidence?.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="text-xs text-gray-500">
        first_seen: {product.first_seen_at} · last_seen: {product.last_seen_at}
      </section>
    </div>
  )
}

function SalesEstimateSection({
  estimate,
  skus,
  daily,
}: {
  estimate: Awaited<ReturnType<typeof fetchProductSalesEstimate>>
  skus: Awaited<ReturnType<typeof fetchCompetitorSkus>>
  daily: DailySalesRow[]
}) {
  const hasData = !!estimate && Number(estimate.tracked_sku_count ?? 0) > 0
  const krw = (n: number | null | undefined) =>
    n == null ? '—' : `${Math.round(Number(n)).toLocaleString()}원`
  const fmt = (n: number | null | undefined) =>
    n == null ? '—' : Math.round(Number(n)).toLocaleString()

  // 채널별 추정 일판매량 sparkline 데이터 (최근 30일)
  const byChannel = new Map<string, DailySalesRow[]>()
  for (const d of daily) {
    if (d.estimated_daily_sales == null) continue
    const arr = byChannel.get(d.channel) ?? []
    arr.push(d)
    byChannel.set(d.channel, arr)
  }

  const accel = estimate ? Number(estimate.accel_ratio_14d ?? 1) : 1
  const accelLabel =
    accel >= 1.5 ? '🚀 급가속' : accel >= 1.15 ? '📈 가속' : accel >= 0.85 ? '➡ 평이' : '📉 감속'

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">💰 추정 매출 보드 (리뷰 적립속도 기반)</h2>
        <span className="text-[10px] text-gray-400">
          ΔReviews / 채널별 리뷰전환률 (coupang 2.5% / smartstore 1.5% 디폴트, 자기 SKU 캘리브레이션 시 자동 갱신)
        </span>
      </div>

      {!hasData ? (
        <div className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500 space-y-1">
          <div className="font-medium">경쟁 SKU 리뷰 스냅샷 미수집</div>
          <div className="text-xs text-gray-400">
            <code className="font-mono">jimscanner_trends_competitor_skus</code> 에 이 상품의 쿠팡/스마트스토어 SKU 등록 후,
            일 1회 cron 으로 <code className="font-mono">jimscanner_competitor_review_snapshots</code> 적재 시 자동 산출.
          </div>
          {skus.length > 0 && (
            <div className="text-xs text-gray-500 pt-1">
              등록된 SKU {skus.length}건 — 스냅샷이 2일 이상 누적되면 표시.
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Kpi label="7d 추정 판매수량" value={fmt(estimate!.est_sales_7d)} />
            <Kpi label="30d 추정 판매수량" value={fmt(estimate!.est_sales_30d)} />
            <Kpi label="7d 추정 매출" value={krw(estimate!.est_revenue_7d_krw)} />
            <Kpi label="30d 추정 매출" value={krw(estimate!.est_revenue_30d_krw)} />
            <Kpi
              label="14d 가속도"
              value={`${accel.toFixed(2)}× ${accelLabel}`}
              highlight={accel >= 1.5}
            />
          </div>

          {/* 채널별 추정치 */}
          {byChannel.size > 0 && (
            <div className="rounded border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">channel</th>
                    <th className="px-3 py-2 text-right">관측일수</th>
                    <th className="px-3 py-2 text-right">총 ΔReviews</th>
                    <th className="px-3 py-2 text-right">최대 일판매량</th>
                    <th className="px-3 py-2 text-right">평균 일판매량</th>
                    <th className="px-3 py-2 text-right">최근 일자</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {Array.from(byChannel.entries()).map(([channel, rows]) => {
                    const deltas = rows.map((r) => Number(r.delta_reviews ?? 0))
                    const sales = rows.map((r) => Number(r.estimated_daily_sales ?? 0))
                    const totalDelta = deltas.reduce((a, b) => a + b, 0)
                    const maxSales = sales.length ? Math.max(...sales) : 0
                    const avgSales = sales.length ? sales.reduce((a, b) => a + b, 0) / sales.length : 0
                    const latest = rows[rows.length - 1]?.observed_date ?? '—'
                    return (
                      <tr key={channel}>
                        <td className="px-3 py-1 font-medium">{channel}</td>
                        <td className="px-3 py-1 text-right font-mono">{rows.length}</td>
                        <td className="px-3 py-1 text-right font-mono">{totalDelta.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right font-mono">{maxSales.toLocaleString()}</td>
                        <td className="px-3 py-1 text-right font-mono">{avgSales.toFixed(1)}</td>
                        <td className="px-3 py-1 text-right text-gray-500">{latest}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 등록된 경쟁 SKU */}
          {skus.length > 0 && (
            <div>
              <div className="text-xs text-gray-500 mb-1">추적 중 경쟁 SKU ({skus.length})</div>
              <div className="rounded border border-gray-200 divide-y divide-gray-100">
                {skus.slice(0, 20).map((s) => (
                  <div key={s.id} className="grid grid-cols-12 px-3 py-2 text-xs items-center">
                    <div className="col-span-2 font-medium uppercase">{s.channel}</div>
                    <div className="col-span-2 font-mono text-gray-600">{s.external_sku_id}</div>
                    <div className="col-span-6 text-gray-800 truncate" title={s.name ?? ''}>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noopener" className="hover:underline">
                          {s.name ?? '—'}
                        </a>
                      ) : (
                        s.name ?? '—'
                      )}
                    </div>
                    <div className="col-span-1 text-right text-gray-500">{s.rank_serp ?? '—'}</div>
                    <div className="col-span-1 text-right text-gray-400">{s.last_seen_at?.slice(0, 10)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${highlight ? 'text-amber-700' : ''}`}>{value}</div>
    </div>
  )
}

function ScoreCard({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className={`mt-1 ${bold ? 'text-3xl font-bold' : 'text-2xl text-gray-700'}`}>
        {value}
      </div>
    </div>
  )
}
