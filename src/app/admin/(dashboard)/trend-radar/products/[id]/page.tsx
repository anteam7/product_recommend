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

interface ReorderCycleRow {
  source: string
  cycle_days: number
  peak_strength: number
  confidence: number
  p_value: number | null
  segment: string
  series_length: number
  series_start: string | null
  series_end: string | null
  acf_top_lags: Array<{ lag: number; acf: number }>
  ltv_proxy_krw: number | null
  ltv_basis_price: number | null
  computed_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  // jimscanner_trends_reorder_cycle 은 generated 타입 미반영 — `as any` 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cycleQuery: any = (sb as any)
    .from('jimscanner_trends_reorder_cycle')
    .select(
      'source, cycle_days, peak_strength, confidence, p_value, segment, series_length, series_start, series_end, acf_top_lags, ltv_proxy_krw, ltv_basis_price, computed_at',
    )
    .eq('product_id', id)
    .order('confidence', { ascending: false })
    .limit(5)
  const [prodRes, aliasRes, scoreRes, cycleRes] = await Promise.all([
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
    cycleQuery,
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    cycles: (cycleRes?.data ?? []) as ReorderCycleRow[],
  }
}

function segBadge(s: string): string {
  if (s === 'consumable') return 'bg-red-100 text-red-700'
  if (s === 'repeatable') return 'bg-amber-100 text-amber-700'
  if (s === 'durable') return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-600'
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, cycles } = data
  const latest = scoreHistory[0]
  const cycle = cycles[0] ?? null

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
          {(product.intent_label || product.description || cycle) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {product.intent_label && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  🏷 {product.intent_label}
                </span>
              )}
              {cycle && (
                <>
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-medium ${segBadge(cycle.segment)}`}
                    title={`ACF peak=${cycle.peak_strength.toFixed(2)} · p=${cycle.p_value?.toExponential(1) ?? '—'}`}
                  >
                    🔁 {cycle.cycle_days}일 cycle · {cycle.segment}
                  </span>
                  {cycle.ltv_proxy_krw != null && (
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700"
                      title={`price × 365 ÷ cycle_days = ${cycle.ltv_basis_price?.toLocaleString() ?? '?'} × 365 ÷ ${cycle.cycle_days}`}
                    >
                      💰 LTV ≈ {cycle.ltv_proxy_krw.toLocaleString()}원/년
                    </span>
                  )}
                </>
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

      {/* Reorder ACF 상위 lag (시각화) */}
      {cycle && cycle.acf_top_lags.length > 0 && (
        <section className="rounded border border-indigo-200 bg-indigo-50/30 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold text-indigo-900">
              🔁 Reorder Cadence — ACF 시계열 (상위 {cycle.acf_top_lags.length} lags)
            </h2>
            <span className="text-[10px] text-gray-500 font-mono">
              N={cycle.series_length}d · {cycle.series_start} → {cycle.series_end} · src={cycle.source}
            </span>
          </div>
          <div className="space-y-1">
            {cycle.acf_top_lags.map((lag, idx) => {
              const isPeak = lag.lag === cycle.cycle_days
              const width = Math.max(0, Math.min(100, lag.acf * 100))
              return (
                <div key={idx} className="flex items-center gap-3 text-xs">
                  <div className="w-12 font-mono text-gray-600">{lag.lag}d</div>
                  <div className="flex-1 bg-white border border-gray-200 h-5 rounded overflow-hidden">
                    <div
                      className={`h-full ${isPeak ? 'bg-indigo-600' : 'bg-indigo-300'}`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <div className="w-16 text-right font-mono">{lag.acf.toFixed(3)}</div>
                  {isPeak && (
                    <span className="text-[10px] text-indigo-700 font-semibold">★ peak</span>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-3 text-[10px] text-gray-500 font-mono">
            confidence={cycle.confidence.toFixed(3)} · peak_strength=
            {cycle.peak_strength.toFixed(3)} · p={cycle.p_value?.toExponential(2) ?? '—'}
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
