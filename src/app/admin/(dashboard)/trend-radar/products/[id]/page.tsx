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
interface ElasticityRow {
  elasticity_coef: number | null
  competitor_coef: number | null
  r_squared: number | null
  sample_days: number
  price_band_p10: number | null
  price_band_p50: number | null
  price_band_p90: number | null
  optimal_entry_price: number | null
  decision_label: string | null
  confidence: string
  computed_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, elastRes] = await Promise.all([
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
      .from('jimscanner_trends_elasticity' as never)
      .select(
        'elasticity_coef, competitor_coef, r_squared, sample_days, price_band_p10, price_band_p50, price_band_p90, optimal_entry_price, decision_label, confidence, computed_at',
      )
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(1),
  ])

  if (prodRes.error || !prodRes.data) return null

  const elasticityList = (elastRes.data ?? []) as unknown as ElasticityRow[]

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    elasticity: (elasticityList[0] ?? null) as ElasticityRow | null,
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
  const { product, aliases, scoreHistory, elasticity } = data
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

      {/* 탄력성 카드 */}
      <ElasticityCard data={elasticity} />

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

function ElasticityCard({ data }: { data: ElasticityRow | null }) {
  if (!data) {
    return (
      <section className="rounded border border-dashed border-gray-200 p-4 text-xs text-gray-500">
        가격 탄력성: 아직 계산되지 않음 (scripts/compute-price-elasticity.mjs 실행 필요)
      </section>
    )
  }
  const dim = data.confidence === 'low'
  const beta = data.elasticity_coef
  const absBeta = beta == null ? null : Math.abs(beta)
  let label: string
  let color: string
  if (dim) {
    label = '신뢰도 낮음'
    color = 'bg-gray-100 text-gray-500'
  } else if (data.decision_label === 'price_sensitive') {
    label = '가격민감 — 저가공세 권장'
    color = 'bg-red-100 text-red-700'
  } else if (data.decision_label === 'differentiable') {
    label = '차별화 가능 — 프리미엄 포지셔닝'
    color = 'bg-emerald-100 text-emerald-700'
  } else {
    label = '중간 — p50 부근 마진 최적화'
    color = 'bg-amber-100 text-amber-700'
  }
  const textCls = dim ? 'text-gray-400' : 'text-gray-800'
  return (
    <section className={`rounded border border-gray-200 p-4 ${textCls}`}>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold">가격 탄력성</h2>
        <span className={`text-xs px-2 py-0.5 rounded ${color}`}>{label}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
        <div>
          <div className="text-[10px] uppercase text-gray-500">β</div>
          <div className="text-2xl font-bold font-mono mt-1">
            {beta?.toFixed(2) ?? '—'}
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {absBeta != null
              ? absBeta >= 1.5
                ? '|β|≥1.5 고탄력'
                : absBeta <= 0.5
                  ? '|β|≤0.5 저탄력'
                  : '중간'
              : ''}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-gray-500">R²</div>
          <div className="text-xl font-mono mt-1">{data.r_squared?.toFixed(2) ?? '—'}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">n={data.sample_days}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-gray-500">p10</div>
          <div className="text-xl font-mono mt-1">
            {data.price_band_p10?.toLocaleString() ?? '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-gray-500">p50</div>
          <div className="text-xl font-mono mt-1">
            {data.price_band_p50?.toLocaleString() ?? '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-gray-500">p90</div>
          <div className="text-xl font-mono mt-1">
            {data.price_band_p90?.toLocaleString() ?? '—'}
          </div>
        </div>
      </div>
      <div className="mt-3 text-sm">
        권장 진입가:{' '}
        <span className="font-bold font-mono text-base">
          {data.optimal_entry_price?.toLocaleString() ?? '—'}원
        </span>
      </div>
      <div className="text-[10px] text-gray-400 mt-1 font-mono">
        computed_at: {data.computed_at?.slice(0, 19).replace('T', ' ')} · confidence:{' '}
        {data.confidence}
      </div>
    </section>
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
