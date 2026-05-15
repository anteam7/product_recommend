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
interface PainpointQuote {
  quote: string
  competitor_sku: string
  severity: number
  mentions: number
  sentiment: number
}
interface PainpointGapRow {
  painpoint_category: string
  total_mentions: number
  weighted_severity: number | string
  competitor_count: number
  top_quotes: PainpointQuote[]
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, painpointRes] = await Promise.all([
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
    sb.rpc('jimscanner_painpoint_gap_matrix' as never, { p_product_id: id } as never),
  ])

  if (prodRes.error || !prodRes.data) return null

  const painpointRows = Array.isArray(painpointRes.data)
    ? (painpointRes.data as unknown as PainpointGapRow[])
    : []

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    painpoints: painpointRows,
  }
}

const CATEGORY_LABELS: Record<string, { label: string; emoji: string }> = {
  shipping: { label: '배송', emoji: '🚚' },
  quality: { label: '품질', emoji: '🛠' },
  size: { label: '사이즈', emoji: '📏' },
  flavor: { label: '향·맛', emoji: '👃' },
  efficacy: { label: '효능 체감', emoji: '⚡' },
  price: { label: '가격', emoji: '💰' },
  other: { label: '기타', emoji: '•' },
}

function heatColor(total: number, max: number) {
  if (max <= 0) return 'bg-gray-50 text-gray-400'
  const r = total / max
  if (r >= 0.75) return 'bg-rose-600 text-white'
  if (r >= 0.5) return 'bg-rose-400 text-white'
  if (r >= 0.25) return 'bg-amber-300 text-amber-900'
  if (r > 0) return 'bg-amber-100 text-amber-800'
  return 'bg-gray-50 text-gray-400'
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, painpoints } = data
  const latest = scoreHistory[0]
  const maxMentions = painpoints.reduce(
    (m, r) => Math.max(m, r.total_mentions || 0),
    0,
  )

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

      {/* 경쟁 리뷰 갭 매트릭스 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          경쟁 리뷰 갭 매트릭스
          {painpoints.length > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-500">
              ({painpoints.length} 카테고리 · 페인 {painpoints.reduce((s, r) => s + (r.total_mentions || 0), 0)}건)
            </span>
          )}
        </h2>
        {painpoints.length === 0 ? (
          <div className="rounded border border-dashed border-gray-200 p-4 text-xs text-gray-500">
            아직 마이닝된 페인포인트가 없습니다. 일 1회 cron <code>mine-review-painpoints</code> 에서 상위
            점수 상품의 경쟁 SKU 리뷰를 분류해 적재합니다.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
              {(['shipping', 'quality', 'size', 'flavor', 'efficacy', 'price', 'other'] as const).map(
                (cat) => {
                  const row = painpoints.find((p) => p.painpoint_category === cat)
                  const meta = CATEGORY_LABELS[cat]
                  const total = row?.total_mentions ?? 0
                  return (
                    <div
                      key={cat}
                      className={`rounded p-2 text-center text-xs ${heatColor(total, maxMentions)}`}
                      title={
                        row
                          ? `총 ${total}건 · 가중 ${row.weighted_severity} · SKU ${row.competitor_count}`
                          : '데이터 없음'
                      }
                    >
                      <div className="text-base leading-none">{meta.emoji}</div>
                      <div className="mt-1 font-medium">{meta.label}</div>
                      <div className="mt-1 font-mono text-[11px]">{total}</div>
                    </div>
                  )
                },
              )}
            </div>

            <div className="space-y-2">
              {painpoints
                .slice()
                .sort((a, b) => (b.total_mentions || 0) - (a.total_mentions || 0))
                .map((row) => {
                  const meta =
                    CATEGORY_LABELS[row.painpoint_category] ?? CATEGORY_LABELS.other
                  const quotes = (row.top_quotes ?? []).slice(0, 3)
                  return (
                    <div
                      key={row.painpoint_category}
                      className="rounded border border-gray-200 p-3"
                    >
                      <div className="flex items-center justify-between text-xs text-gray-600">
                        <div className="font-medium text-gray-800">
                          {meta.emoji} {meta.label}
                        </div>
                        <div className="font-mono">
                          총 {row.total_mentions}건 · 가중 {row.weighted_severity} · SKU{' '}
                          {row.competitor_count}
                        </div>
                      </div>
                      <ul className="mt-2 space-y-1 text-sm text-gray-700">
                        {quotes.map((q, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="mt-0.5 inline-block rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-mono text-rose-700">
                              sev {q.severity}
                            </span>
                            <span className="flex-1">
                              "{q.quote}"
                              <span className="ml-2 text-xs text-gray-400">— {q.competitor_sku}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
            </div>
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
