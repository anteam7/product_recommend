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

interface SupplierPriceRow {
  price_krw: number | null
  collected_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, supplierRes] = await Promise.all([
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
      .from('jimscanner_trends_supplier')
      .select('price_krw, collected_at')
      .eq('product_id', id)
      .order('collected_at', { ascending: false })
      .limit(60),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    supplierHistory: (supplierRes.data ?? []) as SupplierPriceRow[],
  }
}

// 같은 timestamp 최저가 축약 후 오름차순 (오래된→최근)
function buildCostSeries(rows: SupplierPriceRow[]): { t: string; v: number }[] {
  const byT = new Map<string, number>()
  for (const r of rows) {
    if (r.price_krw == null || r.price_krw <= 0) continue
    const cur = byT.get(r.collected_at)
    if (cur == null || r.price_krw < cur) byT.set(r.collected_at, r.price_krw)
  }
  return [...byT.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t.localeCompare(b.t))
}

// 서버 렌더 미니 듀얼축 시저 차트 (수요 trend vs 원가 price)
function ScissorMiniChart({
  demand,
  cost,
}: {
  demand: { v: number }[]
  cost: { v: number }[]
}) {
  const W = 460
  const H = 140
  const PAD = 28
  const line = (vs: number[], color: string) => {
    if (vs.length === 0) return null
    const min = Math.min(...vs)
    const span = Math.max(...vs) - min || 1
    const n = vs.length
    const d = vs
      .map((v, i) => {
        const px = PAD + (n === 1 ? (W - 2 * PAD) / 2 : (i / (n - 1)) * (W - 2 * PAD))
        const py = H - PAD - ((v - min) / span) * (H - 2 * PAD)
        return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`
      })
      .join(' ')
    return <path d={d} fill="none" stroke={color} strokeWidth={2} />
  }
  return (
    <svg width={W} height={H} className="block">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e5e7eb" />
      {line(demand.map((p) => p.v), '#2563eb')}
      {line(cost.map((p) => p.v), '#dc2626')}
    </svg>
  )
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, supplierHistory } = data
  const latest = scoreHistory[0]

  // 시저 미니 차트용 시계열 (오래된→최근)
  const demandSeries = [...scoreHistory].reverse().map((s) => ({ v: s.trend_score }))
  const costSeries = buildCostSeries(supplierHistory)
  const demandDelta = demandSeries.length > 1 ? Math.round(demandSeries[demandSeries.length - 1].v - demandSeries[0].v) : 0
  const costDropPct =
    costSeries.length > 1 && costSeries[0].v > 0
      ? Math.round(((costSeries[0].v - costSeries[costSeries.length - 1].v) / costSeries[0].v) * 1000) / 10
      : 0

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

      {/* 수요-원가 시저 미니 차트 */}
      {(demandSeries.length > 1 || costSeries.length > 1) && (
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold">수요 ↔ 원가 시저</h2>
            <Link href="/admin/trend-radar/margin-momentum" className="text-xs text-gray-500 hover:text-black underline">
              시저 보드 →
            </Link>
          </div>
          <div className="rounded border border-gray-200 p-4 flex flex-wrap items-center gap-6">
            <ScissorMiniChart demand={demandSeries} cost={costSeries} />
            <div className="text-xs text-gray-600 space-y-1">
              <div><span className="inline-block w-3 h-0.5 bg-blue-600 align-middle mr-1" /> 수요(trend) Δ {demandDelta > 0 ? '+' : ''}{demandDelta}</div>
              <div>
                <span className="inline-block w-3 h-0.5 bg-red-600 align-middle mr-1" /> 원가{' '}
                {costDropPct > 0 ? `▼ ${costDropPct}% 하락 (마진 확장)` : costDropPct < 0 ? `▲ ${-costDropPct}% 상승` : '변동 없음/데이터 부족'}
              </div>
              {costSeries.length > 1 && (
                <div className="text-gray-500">
                  {costSeries[0].v.toLocaleString()}원 → {costSeries[costSeries.length - 1].v.toLocaleString()}원
                </div>
              )}
              {demandDelta > 0 && costDropPct > 0 && (
                <div className="text-emerald-600 font-medium">① 즉시소싱 신호 (골든크로스)</div>
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
