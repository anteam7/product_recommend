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

interface HaloEdge {
  partner: string
  source: string
  weight: number
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

  const aliases = (aliasRes.data ?? []) as AliasRow[]
  const haloEdges = await fetchHaloEdges(sb, aliases.map((a) => a.alias))

  return {
    product: prodRes.data as ProductRow,
    aliases,
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    haloEdges,
  }
}

async function fetchHaloEdges(
  sb: ReturnType<typeof createAdminClient>,
  aliases: string[],
): Promise<HaloEdge[]> {
  if (aliases.length === 0) return []
  // 'as any' — trends_v5_query_edges 마이그레이션 적용 전까지 타입 미생성
  try {
    const [aRes, bRes] = await Promise.all([
      (sb as any)
        .from('jimscanner_trends_query_edges')
        .select('keyword_a, keyword_b, source, weight')
        .in('keyword_a', aliases)
        .order('weight', { ascending: false })
        .limit(200),
      (sb as any)
        .from('jimscanner_trends_query_edges')
        .select('keyword_a, keyword_b, source, weight')
        .in('keyword_b', aliases)
        .order('weight', { ascending: false })
        .limit(200),
    ])
    if (aRes.error || bRes.error) return []
    const seen = new Set(aliases.map((a) => a.toLowerCase()))
    const acc = new Map<string, HaloEdge>()
    type EdgeRaw = { keyword_a: string; keyword_b: string; source: string; weight: number }
    for (const row of (aRes.data ?? []) as EdgeRaw[]) {
      const partner = row.keyword_b
      if (seen.has(partner.toLowerCase())) continue
      const k = `${partner}|${row.source}`
      const existing = acc.get(k)
      if (existing) existing.weight += Number(row.weight ?? 0)
      else acc.set(k, { partner, source: row.source, weight: Number(row.weight ?? 0) })
    }
    for (const row of (bRes.data ?? []) as EdgeRaw[]) {
      const partner = row.keyword_a
      if (seen.has(partner.toLowerCase())) continue
      const k = `${partner}|${row.source}`
      const existing = acc.get(k)
      if (existing) existing.weight += Number(row.weight ?? 0)
      else acc.set(k, { partner, source: row.source, weight: Number(row.weight ?? 0) })
    }
    return [...acc.values()].sort((a, b) => b.weight - a.weight).slice(0, 10)
  } catch {
    return []
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
  const { product, aliases, scoreHistory, haloEdges } = data
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

      {/* SEO halo 묶음 — co-search graph */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          🪢 SEO halo 묶음{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">
            이 핀과 함께 검색되는 상위 쿼리 (co-search weight 기준 · 묶음 진입 권장)
          </span>
        </h2>
        {haloEdges.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
            아직 co-search 엣지 없음. 마이그레이션 적용 + KST 03:40 cron 누적 후 표시.
            <Link
              href="/admin/trend-radar/co-search"
              className="ml-2 underline hover:text-black"
            >
              그래프 보기 →
            </Link>
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {haloEdges.map((h, i) => (
              <div
                key={i}
                className="grid grid-cols-12 px-3 py-2 text-sm items-center hover:bg-emerald-50/30"
              >
                <div className="col-span-1 text-gray-400 font-mono text-xs">{i + 1}</div>
                <div className="col-span-7">
                  <span className="font-medium">{h.partner}</span>
                </div>
                <div className="col-span-2 text-xs text-gray-500">{h.source}</div>
                <div className="col-span-2 text-right font-mono text-xs text-emerald-700">
                  {h.weight.toFixed(1)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="text-xs text-gray-400 mt-2">
          💡 commerce_score.halo_bundle 컴포넌트는 이 묶음 사이즈를 기반으로 가산됩니다 (recompute 적용 후).
        </div>
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
