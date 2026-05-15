import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'

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

interface SupplyRow {
  product_id: string
  supplier_count: number
  supplier_sources: string[] | null
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  ggsan_status: string | null
  ggsan_is_imminent: boolean | null
  ggsan_detail_url: string | null
  ggsan_sim: number | null
  in_stock_count: number
  limited_count: number
  out_of_stock_count: number
  inventory_total: number
  in_stock_ratio: number | null
  limited_ratio: number | null
  out_of_stock_ratio: number | null
  avg_price: number | null
  stddev_price: number | null
  price_cv: number | null
  min_lead_time_days: number | null
  single_source_risk: boolean
  risk_label: 'no_supplier' | 'single_supplier' | 'all_out_of_stock_or_limited' | 'ok'
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, supplyRes] = await Promise.all([
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
    (sb as any)
      .from('v_supply_diversification')
      .select('*')
      .eq('product_id', id)
      .maybeSingle(),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    supply: (supplyRes?.data ?? null) as SupplyRow | null,
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
  const { product, aliases, scoreHistory, supply } = data
  const latest = scoreHistory[0]

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

      {/* Supply 카드 (공급 다양성) */}
      {supply && (
        <section>
          <h2 className="text-sm font-semibold mb-2">Supply — 공급 다양성</h2>
          <div className={`rounded border p-4 ${supply.single_source_risk ? 'border-amber-400 bg-amber-50' : 'border-gray-200'}`}>
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div className="flex items-center gap-2">
                {supply.single_source_risk ? (
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-200 text-amber-900 font-semibold">
                    ⚠ {supply.risk_label === 'no_supplier' ? '공급사 0' :
                       supply.risk_label === 'single_supplier' ? '단일 공급원' : '재고 위험'}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
                    ✓ 다중 공급원
                  </span>
                )}
                <span className="text-sm text-gray-700">
                  공급사 <strong>{supply.supplier_count}</strong>개
                </span>
              </div>
              {supply.supplier_sources && supply.supplier_sources.length > 0 && (
                <div className="text-xs text-gray-500">
                  {supply.supplier_sources.join(' · ')}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <SupplyMetric
                label="재고 분포"
                value={
                  supply.inventory_total > 0
                    ? `${supply.in_stock_count}/${supply.limited_count}/${supply.out_of_stock_count}`
                    : '—'
                }
                hint={
                  supply.inventory_total > 0
                    ? `in ${Math.round((supply.in_stock_ratio ?? 0) * 100)}% · out ${Math.round((supply.out_of_stock_ratio ?? 0) * 100)}%`
                    : 'inventory 미수집'
                }
              />
              <SupplyMetric
                label="가격 변동성 (CV)"
                value={supply.price_cv != null ? supply.price_cv.toFixed(2) : '—'}
                hint={supply.avg_price ? `평균 ${Math.round(supply.avg_price).toLocaleString()}원` : '가격 X'}
              />
              <SupplyMetric
                label="최단 리드타임"
                value={supply.min_lead_time_days != null ? `${supply.min_lead_time_days}d` : '—'}
                hint="lead_time_days"
              />
              <SupplyMetric
                label="ggsan 매칭"
                value={supply.ggsan_goods_no ? `sim ${(supply.ggsan_sim ?? 0).toFixed(2)}` : '없음'}
                hint={supply.ggsan_title ?? '—'}
              />
            </div>

            {supply.ggsan_goods_no && (
              <div className="mt-3 pt-3 border-t border-gray-200 text-xs flex items-center gap-2 flex-wrap">
                <span className="text-gray-500">ggsan:</span>
                {supply.ggsan_detail_url ? (
                  <a
                    href={supply.ggsan_detail_url}
                    target="_blank"
                    rel="noopener"
                    className="text-amber-700 hover:underline truncate max-w-[400px]"
                  >
                    {supply.ggsan_title}
                  </a>
                ) : (
                  <span className="truncate max-w-[400px]">{supply.ggsan_title}</span>
                )}
                {supply.ggsan_price_krw && (
                  <span className="text-gray-700 font-mono">{supply.ggsan_price_krw.toLocaleString()}원</span>
                )}
                {supply.ggsan_status && supply.ggsan_status !== 'active' && (
                  <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-semibold">
                    {supply.ggsan_status}
                  </span>
                )}
                {supply.ggsan_is_imminent && (
                  <span className="px-1.5 py-0.5 bg-red-600 text-white rounded font-semibold">임박특가</span>
                )}
              </div>
            )}
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

function SupplyMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-2">
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
      <div className="text-[10px] text-gray-400 mt-0.5 truncate" title={hint}>{hint}</div>
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
