import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import GscMiniStrip from './GscMiniStrip'

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

interface GscDailyRow {
  date: string
  clicks: number
  impressions: number
  position: number
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

  // GSC 28일 시계열: alias 와 ILIKE 매칭되는 query 일별 합계
  let gscDaily: GscDailyRow[] = []
  const aliases = (aliasRes.data ?? []) as AliasRow[]
  if (aliases.length > 0) {
    // 상위 confidence alias 중 너무 짧은 것(<2) 제외 — 상위 5개만 사용해 비용 제한
    const topAliases = aliases.filter((a) => (a.alias ?? '').length >= 2).slice(0, 5)
    if (topAliases.length > 0) {
      const since = new Date()
      since.setDate(since.getDate() - 28)
      const sinceStr = since.toISOString().slice(0, 10)
      // OR 조건 — ilike '%alias%' (alias 가 query 의 부분문자열인 경우)
      const orExpr = topAliases.map((a) => `query.ilike.%${a.alias.replace(/[,()]/g, '')}%`).join(',')
      const { data: gscRows } = await sb
        .from('jimscanner_gsc_queries')
        .select('date, clicks, impressions, position')
        .gte('date', sinceStr)
        .or(orExpr)
      if (gscRows && gscRows.length > 0) {
        const dayMap = new Map<string, { clicks: number; impressions: number; pos_weighted: number }>()
        for (const r of gscRows as any[]) {
          const d = String(r.date)
          const prev = dayMap.get(d) ?? { clicks: 0, impressions: 0, pos_weighted: 0 }
          prev.clicks += Number(r.clicks ?? 0)
          prev.impressions += Number(r.impressions ?? 0)
          prev.pos_weighted += Number(r.position ?? 0) * Number(r.impressions ?? 0)
          dayMap.set(d, prev)
        }
        gscDaily = Array.from(dayMap.entries())
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, v]) => ({
            date,
            clicks: v.clicks,
            impressions: v.impressions,
            position: v.impressions > 0 ? v.pos_weighted / v.impressions : 0,
          }))
      }
    }
  }

  return {
    product: prodRes.data as ProductRow,
    aliases,
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    gscDaily,
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
  const { product, aliases, scoreHistory, gscDaily } = data
  const latest = scoreHistory[0]
  const gscTotals = gscDaily.reduce(
    (acc, r) => {
      acc.clicks += r.clicks
      acc.impressions += r.impressions
      acc.pos_weighted += r.position * r.impressions
      return acc
    },
    { clicks: 0, impressions: 0, pos_weighted: 0 },
  )
  const gscAvgPos = gscTotals.impressions > 0 ? gscTotals.pos_weighted / gscTotals.impressions : 0
  const gscCtr = gscTotals.impressions > 0 ? (gscTotals.clicks / gscTotals.impressions) * 100 : 0

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

      {/* GSC 28일 미니 차트 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          🔍 GSC 28일 (alias 매칭 query 합산)
        </h2>
        {gscDaily.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
            매칭되는 GSC 검색어 없음 — 노출/클릭 데이터 아직 안 누적되었거나 alias 정밀화 필요
          </div>
        ) : (
          <div className="rounded border border-gray-200 p-3 space-y-2">
            <div className="flex gap-6 text-xs">
              <div>
                <span className="text-gray-500">노출 </span>
                <span className="font-mono font-semibold">{gscTotals.impressions.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-gray-500">클릭 </span>
                <span className="font-mono font-semibold">{gscTotals.clicks.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-gray-500">CTR </span>
                <span className="font-mono font-semibold">{gscCtr.toFixed(2)}%</span>
              </div>
              <div>
                <span className="text-gray-500">avg position </span>
                <span className="font-mono font-semibold">{gscAvgPos.toFixed(1)}</span>
              </div>
            </div>
            <GscMiniStrip rows={gscDaily} />
          </div>
        )}
      </section>

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
