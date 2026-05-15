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

interface VelocityRow {
  product_id: string
  sku_count: number
  weekly_new_reviews: number
  avg_price: number | null
  avg_rating: number | null
  total_reviews: number
  last_captured_at: string
}
interface SkuVelocityRow {
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

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, velocityRes, skuVelocityRes] = await Promise.all([
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
    sb
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('jimscanner_serp_product_velocity' as any)
      .select('*')
      .eq('product_id', id)
      .maybeSingle(),
    sb
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('jimscanner_serp_sku_velocity' as any)
      .select('*')
      .eq('product_id', id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .order('delta_review_7d' as any, { ascending: false })
      .limit(10),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    velocity: (velocityRes.data ?? null) as VelocityRow | null,
    skuVelocity: ((skuVelocityRes.data ?? []) as unknown) as SkuVelocityRow[],
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
  const { product, aliases, scoreHistory, velocity, skuVelocity } = data
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

      {/* 📈 실판매 속도 — Smartstore SERP review delta */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          📈 실판매 속도 (Smartstore SERP)
          <Link
            href="/admin/trend-radar/sales-velocity"
            className="ml-2 text-xs font-normal text-gray-500 hover:text-black underline"
          >
            전체 보드 →
          </Link>
        </h2>
        {velocity ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <VelocityCard
                label="주간 신규 리뷰"
                value={velocity.weekly_new_reviews ?? 0}
                hint="SKU 합산 · 회전 속도 proxy"
                bold
              />
              <VelocityCard label="추적 SKU" value={velocity.sku_count ?? 0} hint="top 10 캡처" />
              <VelocityCard
                label="평균가"
                value={velocity.avg_price ?? 0}
                hint="원 · SKU 평균"
                fmt="krw"
              />
              <VelocityCard
                label="평균 별점"
                value={velocity.avg_rating ?? 0}
                hint="0~5"
                fmt="rating"
              />
            </div>
            {skuVelocity.length > 0 && (
              <div className="rounded border border-gray-200 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">SKU</th>
                      <th className="px-3 py-2 text-left">판매자</th>
                      <th className="px-3 py-2 text-right">가격</th>
                      <th className="px-3 py-2 text-right">7d 신규</th>
                      <th className="px-3 py-2 text-right">누적</th>
                      <th className="px-3 py-2 text-right">별점</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {skuVelocity.map((s, i) => (
                      <tr key={`${s.sku_url}-${i}`}>
                        <td className="px-3 py-1.5">
                          <a
                            href={s.sku_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 hover:underline"
                          >
                            {s.title ?? s.sku_url.slice(0, 50)}
                          </a>
                        </td>
                        <td className="px-3 py-1.5 text-gray-600">{s.seller ?? '—'}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-600">
                          {s.price ? s.price.toLocaleString() : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-bold text-red-700">
                          {s.delta_review_7d}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600">
                          {s.review_count ?? '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600">
                          {s.rating ? s.rating.toFixed(2) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
            아직 SERP SKU 캡처가 없다. 첫 캡처 후 약 7일 뒤부터 의미 있는 델타가 잡힌다.
          </div>
        )}
      </section>

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

function VelocityCard({
  label,
  value,
  hint,
  bold,
  fmt,
}: {
  label: string
  value: number
  hint?: string
  bold?: boolean
  fmt?: 'krw' | 'rating'
}) {
  const display =
    fmt === 'krw'
      ? value > 0
        ? `${value.toLocaleString()}원`
        : '—'
      : fmt === 'rating'
        ? value > 0
          ? value.toFixed(2)
          : '—'
        : value.toLocaleString()
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`mt-1 ${bold ? 'text-2xl font-bold' : 'text-xl text-gray-700'} ${
          bold && value >= 10 ? 'text-red-700' : ''
        }`}
      >
        {display}
      </div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
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
