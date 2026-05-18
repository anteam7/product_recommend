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

interface BundleSuggestRow {
  complement_id: string
  score: number
  reasons: any
  cheapest_supplier_source: string | null
  cheapest_supplier_price_krw: number | null
  cheapest_supplier_moq: number | null
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, bundleRes] = await Promise.all([
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
      .from('jimscanner_trends_bundle_candidates')
      .select('complement_id, score, reasons, cheapest_supplier_source, cheapest_supplier_price_krw, cheapest_supplier_moq')
      .eq('anchor_id', id)
      .order('score', { ascending: false })
      .limit(10),
  ])

  if (prodRes.error || !prodRes.data) return null

  const bundles = (bundleRes?.data ?? []) as BundleSuggestRow[]
  let bundleComplements = new Map<string, { canonical_name: string; category_top: string }>()
  if (bundles.length > 0) {
    const { data: comps } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', bundles.map((b) => b.complement_id))
    for (const c of (comps ?? []) as { id: string; canonical_name: string; category_top: string }[]) {
      bundleComplements.set(c.id, { canonical_name: c.canonical_name, category_top: c.category_top })
    }
  }

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    bundles,
    bundleComplements,
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
  const { product, aliases, scoreHistory, bundles, bundleComplements } = data
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

      {/* score breakdown */}
      {latest?.score_components && (
        <section>
          <h2 className="text-sm font-semibold mb-2">최신 score components</h2>
          <pre className="rounded border border-gray-200 p-3 text-xs overflow-x-auto bg-gray-50">
            {JSON.stringify(latest.score_components, null, 2)}
          </pre>
        </section>
      )}

      {/* 번들 추천 (보완재) */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">
            🎁 번들 추천 — 보완재 Top {bundles.length}
            <span className="text-xs font-normal text-gray-500 ml-2">
              객단가 부스터 (임베딩 0.55~0.80 + 카테고리 + 페르소나 + co-occurrence)
            </span>
          </h2>
          <Link
            href={`/admin/trend-radar/bundles?anchor=${product.id}`}
            className="text-xs text-gray-600 hover:text-black underline"
          >
            전체 보드 →
          </Link>
        </div>
        {bundles.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-xs text-gray-500">
            아직 보완재가 산출되지 않았습니다. <br />
            <code className="px-1 bg-gray-100 rounded">
              node scripts/compute-bundle-candidates.mjs --anchor={product.id}
            </code>
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left w-8">#</th>
                  <th className="px-3 py-2 text-left">보완재</th>
                  <th className="px-3 py-2 text-right">score</th>
                  <th className="px-3 py-2 text-right">최저 공급가</th>
                  <th className="px-3 py-2 text-right">MOQ</th>
                  <th className="px-3 py-2 text-left">공급사</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bundles.map((b, i) => {
                  const comp = bundleComplements.get(b.complement_id)
                  return (
                    <tr key={b.complement_id} className="hover:bg-gray-50">
                      <td className="px-3 py-1 font-mono text-gray-400">{i + 1}</td>
                      <td className="px-3 py-1">
                        {comp ? (
                          <Link href={`/admin/trend-radar/products/${b.complement_id}`} className="hover:underline">
                            {comp.canonical_name}
                            <span className="text-gray-400 ml-1">· {comp.category_top}</span>
                          </Link>
                        ) : (
                          <span className="text-gray-400 font-mono">{b.complement_id.slice(0, 8)}…</span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right font-mono font-bold">{b.score.toFixed(2)}</td>
                      <td className="px-3 py-1 text-right font-mono text-gray-700">
                        {b.cheapest_supplier_price_krw != null
                          ? `${Math.round(b.cheapest_supplier_price_krw).toLocaleString()}원`
                          : '—'}
                      </td>
                      <td className="px-3 py-1 text-right font-mono text-gray-700">
                        {b.cheapest_supplier_moq ?? '—'}
                      </td>
                      <td className="px-3 py-1 text-gray-600">{b.cheapest_supplier_source ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
