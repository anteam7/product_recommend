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

interface CompanionRow {
  candidate_id: string
  candidate_name: string
  candidate_brand: string | null
  candidate_category_top: string | null
  candidate_category_mid: string | null
  candidate_intent_label: string | null
  candidate_score: number | null
  candidate_has_ggsan: boolean
  co_count: number
  pmi: number
  jaccard: number
  sample_title: string | null
  sample_url: string | null
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, compRes] = await Promise.all([
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
      .from('jimscanner_trends_companions')
      .select(
        'candidate_id, candidate_name, candidate_brand, candidate_category_top, candidate_category_mid, candidate_intent_label, candidate_score, candidate_has_ggsan, co_count, pmi, jaccard, sample_title, sample_url',
      )
      .eq('seed_id', id)
      .order('pmi', { ascending: false })
      .limit(12),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    companions: ((compRes as any)?.data ?? []) as CompanionRow[],
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
  const { product, aliases, scoreHistory, companions } = data
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

      {/* Companion Products — 동시 언급 기반 인접 상품 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          Companion Products{' '}
          <span className="text-xs font-normal text-gray-500">
            (90일 본문 co-occurrence · PMI 내림차순)
          </span>
        </h2>
        {companions.length === 0 ? (
          <p className="text-xs text-gray-400">
            함께 언급된 상품이 아직 없습니다. cooccurrence matview 가 갱신되었는지 확인하세요.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {companions.map((c) => (
              <Link
                key={c.candidate_id}
                href={`/admin/trend-radar/products/${c.candidate_id}`}
                className="block rounded border border-gray-200 p-3 hover:border-black hover:shadow-sm transition"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-medium truncate">{c.candidate_name}</div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      c.candidate_has_ggsan
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {c.candidate_has_ggsan ? 'ggsan ✓' : 'ggsan 미매칭'}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-gray-500 truncate">
                  {c.candidate_brand ? `${c.candidate_brand} · ` : ''}
                  {c.candidate_category_top}
                  {c.candidate_category_mid ? ` / ${c.candidate_category_mid}` : ''}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1 text-[11px] font-mono">
                  <div className="text-gray-600">
                    PMI <span className="text-black font-bold">{Number(c.pmi).toFixed(2)}</span>
                  </div>
                  <div className="text-gray-600">
                    co <span className="text-black font-bold">{c.co_count}</span>
                  </div>
                  <div className="text-gray-600">
                    score{' '}
                    <span className="text-black font-bold">
                      {c.candidate_score != null ? Math.round(c.candidate_score) : '—'}
                    </span>
                  </div>
                </div>
                {c.sample_title && (
                  <div className="mt-2 text-[11px] text-gray-500 line-clamp-2 italic">
                    “{c.sample_title}”
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
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
