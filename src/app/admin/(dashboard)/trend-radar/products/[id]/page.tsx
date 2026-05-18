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
  jtbd_tags: string[] | null
  jtbd_classified_at: string | null
  regulation_risk: number | null
  entry_difficulty: number | null
  margin_score: number | null
}
interface AlternativeRow {
  target_product_id: string
  shared_jtbd_tags: string[]
  edge_strength: number
  edge_type: string
  target: {
    id: string
    canonical_name: string
    category_top: string
    category_mid: string | null
    brand: string | null
    jtbd_tags: string[] | null
    regulation_risk: number | null
    entry_difficulty: number | null
    margin_score: number | null
  } | null
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

async function fetchAlternatives(sb: ReturnType<typeof createAdminClient>, id: string) {
  // JTBD 그래프 — 마이그레이션 미적용 환경이면 빈 배열로 폴백
  try {
    const { data, error } = await (sb as any)
      .from('jimscanner_trends_jtbd_graph')
      .select('target_product_id, shared_jtbd_tags, edge_strength, edge_type')
      .eq('source_product_id', id)
      .order('edge_strength', { ascending: false })
      .limit(12)
    if (error || !data || data.length === 0) return [] as AlternativeRow[]

    const targetIds = (data as any[]).map((r) => r.target_product_id)
    const { data: targets } = await (sb as any)
      .from('jimscanner_trends_products')
      .select(
        'id, canonical_name, category_top, category_mid, brand, jtbd_tags, regulation_risk, entry_difficulty, margin_score',
      )
      .in('id', targetIds)

    const byId = new Map<string, AlternativeRow['target']>()
    for (const t of (targets as any[]) ?? []) byId.set(t.id, t)

    return (data as any[]).map((edge) => ({
      target_product_id: edge.target_product_id,
      shared_jtbd_tags: Array.isArray(edge.shared_jtbd_tags) ? edge.shared_jtbd_tags : [],
      edge_strength: Number(edge.edge_strength) || 0,
      edge_type: edge.edge_type ?? 'alternative',
      target: byId.get(edge.target_product_id) ?? null,
    })) as AlternativeRow[]
  } catch {
    return [] as AlternativeRow[]
  }
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, alternatives] = await Promise.all([
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
    fetchAlternatives(sb, id),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as unknown as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    alternatives,
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
  const { product, aliases, scoreHistory, alternatives } = data
  const latest = scoreHistory[0]
  const productJtbd = Array.isArray(product.jtbd_tags) ? product.jtbd_tags : []

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
          {(product.intent_label || product.description || productJtbd.length > 0) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {product.intent_label && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  🏷 {product.intent_label}
                </span>
              )}
              {productJtbd.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 rounded bg-violet-100 text-violet-700 font-medium"
                >
                  🎯 {tag}
                </span>
              ))}
              {product.description && (
                <span className="text-sm text-gray-700">{product.description}</span>
              )}
            </div>
          )}
          {(product.regulation_risk != null ||
            product.entry_difficulty != null ||
            product.margin_score != null) && (
            <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
              {product.regulation_risk != null && (
                <span>
                  규제리스크:{' '}
                  <span className={riskColor(product.regulation_risk)}>
                    {product.regulation_risk}/10
                  </span>
                </span>
              )}
              {product.entry_difficulty != null && (
                <span>
                  진입난이도:{' '}
                  <span className={riskColor(product.entry_difficulty)}>
                    {product.entry_difficulty}/10
                  </span>
                </span>
              )}
              {product.margin_score != null && (
                <span>
                  마진:{' '}
                  <span className={marginColor(product.margin_score)}>
                    {product.margin_score}/10
                  </span>
                </span>
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

      {/* JTBD 대체재 후보 */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">
            JTBD 대안 후보 <span className="text-gray-400 font-normal">({alternatives.length})</span>
          </h2>
          <p className="text-xs text-gray-500">
            같은 'needs' 공간의 다른 상품 — 진입 막힘 시 우회 카드
          </p>
        </div>
        {alternatives.length === 0 ? (
          <div className="rounded border border-dashed border-gray-200 p-4 text-xs text-gray-500">
            {productJtbd.length === 0
              ? 'JTBD 태그가 아직 부여되지 않았습니다. classify-trends-llm 실행 후 그래프가 생성됩니다.'
              : '동일 JTBD 클러스터에 매칭되는 다른 상품이 없습니다.'}
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {alternatives.map((alt) => {
              const tgt = alt.target
              if (!tgt) return null
              return (
                <Link
                  key={alt.target_product_id}
                  href={`/admin/trend-radar/products/${alt.target_product_id}`}
                  className="grid grid-cols-12 gap-2 px-3 py-2 text-sm items-center hover:bg-gray-50"
                >
                  <div className="col-span-4">
                    <div className="font-medium">{tgt.canonical_name}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {tgt.brand ? `${tgt.brand} · ` : ''}
                      {tgt.category_top}
                      {tgt.category_mid ? ` / ${tgt.category_mid}` : ''}
                    </div>
                  </div>
                  <div className="col-span-3 flex flex-wrap gap-1">
                    {alt.shared_jtbd_tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="col-span-1 text-center">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        alt.edge_type === 'alternative'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                      title={
                        alt.edge_type === 'alternative'
                          ? '다른 카테고리/브랜드 — 진짜 대안'
                          : '같은 카테고리 — 룩얼라이크'
                      }
                    >
                      {alt.edge_type === 'alternative' ? '대안' : '룩얼라이크'}
                    </span>
                  </div>
                  <div className="col-span-1 text-right text-[10px] font-mono text-gray-500">
                    {(alt.edge_strength * 100).toFixed(0)}%
                  </div>
                  <div className="col-span-3 flex items-center justify-end gap-2 text-[11px]">
                    <ScoreChip label="규제" value={tgt.regulation_risk} kind="risk" />
                    <ScoreChip label="진입" value={tgt.entry_difficulty} kind="risk" />
                    <ScoreChip label="마진" value={tgt.margin_score} kind="margin" />
                  </div>
                </Link>
              )
            })}
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

function riskColor(n: number) {
  if (n >= 7) return 'text-red-600 font-medium'
  if (n >= 4) return 'text-amber-600 font-medium'
  return 'text-emerald-600 font-medium'
}

function marginColor(n: number) {
  if (n >= 7) return 'text-emerald-600 font-medium'
  if (n >= 4) return 'text-amber-600 font-medium'
  return 'text-red-600 font-medium'
}

function ScoreChip({
  label,
  value,
  kind,
}: {
  label: string
  value: number | null
  kind: 'risk' | 'margin'
}) {
  if (value == null) {
    return <span className="text-gray-300">{label}: —</span>
  }
  const cls = kind === 'risk' ? riskColor(value) : marginColor(value)
  return (
    <span className="whitespace-nowrap">
      <span className="text-gray-400">{label}:</span> <span className={cls}>{value}</span>
    </span>
  )
}
