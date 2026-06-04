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
// jimscanner_trends_rivalry — 마이그레이션 후 타입 미생성이라 as any 캐스팅.
interface RivalryRow {
  from_product_id: string | null
  to_product_id: string | null
  from_name: string
  to_name: string
  relation: 'vs' | 'replace'
  mention_count: number
  sample_quote: string | null
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, rivalRes] = await Promise.all([
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
      .from('jimscanner_trends_rivalry')
      .select('from_product_id, to_product_id, from_name, to_name, relation, mention_count, sample_quote')
      .or(`from_product_id.eq.${id},to_product_id.eq.${id}`)
      .order('mention_count', { ascending: false })
      .limit(50),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    rivalry: (rivalRes?.error ? [] : (rivalRes?.data ?? [])) as RivalryRow[],
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
  const { product, aliases, scoreHistory, rivalry } = data
  const latest = scoreHistory[0]

  // 경쟁 구도: 이 상품 관점에서 '이겨야 할 incumbent'(내가 challenger=from) vs '나를 위협하는 challenger'(내가 incumbent=to)
  const mustBeat = rivalry
    .filter((r) => r.from_product_id === product.id || r.from_name === product.canonical_name)
    .map((r) => ({ name: r.to_name, relation: r.relation, mentions: r.mention_count, quote: r.sample_quote }))
  const threatenedBy = rivalry
    .filter((r) => r.to_product_id === product.id || r.to_name === product.canonical_name)
    .map((r) => ({ name: r.from_name, relation: r.relation, mentions: r.mention_count, quote: r.sample_quote }))

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

      {/* 경쟁 구도 (rivalry 마이닝) */}
      {(mustBeat.length > 0 || threatenedBy.length > 0) && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            ⚔️ 경쟁 구도{' '}
            <Link href="/admin/trend-radar/rivalry" className="text-xs font-normal text-gray-400 hover:text-black">
              전체 보기 →
            </Link>
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border border-red-200 p-3">
              <div className="text-xs font-semibold text-red-700 mb-2">이겨야 할 incumbent ({mustBeat.length})</div>
              {mustBeat.length === 0 ? (
                <div className="text-xs text-gray-400">—</div>
              ) : (
                <ul className="space-y-1">
                  {mustBeat.map((r, i) => (
                    <li key={i} className="text-sm flex items-baseline justify-between gap-2">
                      <span>
                        {r.name}{' '}
                        <span className="text-[10px] text-gray-400">
                          {r.relation === 'replace' ? '대체' : 'vs'}
                        </span>
                      </span>
                      <span className="text-xs font-mono text-gray-500">{r.mentions}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded border border-amber-200 p-3">
              <div className="text-xs font-semibold text-amber-700 mb-2">
                나를 위협하는 challenger ({threatenedBy.length})
              </div>
              {threatenedBy.length === 0 ? (
                <div className="text-xs text-gray-400">—</div>
              ) : (
                <ul className="space-y-1">
                  {threatenedBy.map((r, i) => (
                    <li key={i} className="text-sm flex items-baseline justify-between gap-2">
                      <span>
                        {r.name}{' '}
                        <span className="text-[10px] text-gray-400">
                          {r.relation === 'replace' ? '대체' : 'vs'}
                        </span>
                      </span>
                      <span className="text-xs font-mono text-gray-500">{r.mentions}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
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
