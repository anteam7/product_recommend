import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeImitationDecay, type ImitationObservation } from '@/lib/scoring/imitation-decay'

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

interface ImitationTrackRow {
  observed_at: string
  serp_listing_count: number
  new_listings_24h: number
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, imitRes] = await Promise.all([
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('jimscanner_trends_imitation_track' as any)
      .select('observed_at, serp_listing_count, new_listings_24h')
      .eq('product_id', id)
      .order('observed_at', { ascending: true }),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    imitationRows: ((imitRes.data ?? []) as unknown as ImitationTrackRow[]) ?? [],
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
  const { product, aliases, scoreHistory, imitationRows } = data
  const latest = scoreHistory[0]
  const imitObs: ImitationObservation[] = imitationRows.map((r) => ({
    observed_at: r.observed_at,
    serp_listing_count: r.serp_listing_count,
  }))
  const imitDecay = computeImitationDecay(imitObs)

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

      {/* 모방 클리프 미니 차트 */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">모방 클리프 (카피캣 SERP 증가)</h2>
          <Link
            href="/admin/trend-radar/imitation"
            className="text-xs text-gray-500 hover:text-black underline"
          >
            전체 추적기 →
          </Link>
        </div>
        {imitationRows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-200 p-4 text-xs text-gray-500">
            추적 데이터 없음. /api/cron/track-imitation 가동 후 표시.
          </div>
        ) : (
          <div className="rounded border border-gray-200 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 items-center">
            <ImitationMiniChart rows={imitationRows} />
            <div className="text-xs">
              <div className="text-gray-500 uppercase">최근 SERP</div>
              <div className="text-xl font-bold">{imitDecay.latest_count}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500 uppercase">반감기</div>
              <div className="text-xl font-bold">
                {imitDecay.imitation_half_life_days
                  ? `${imitDecay.imitation_half_life_days.toFixed(1)}일`
                  : '—'}
              </div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500 uppercase">진입 윈도우</div>
              <div
                className={`text-xl font-bold ${
                  imitDecay.severity === 'closing'
                    ? 'text-red-700'
                    : imitDecay.severity === 'narrow'
                      ? 'text-amber-700'
                      : ''
                }`}
              >
                {imitDecay.dday_label}
              </div>
            </div>
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

function ImitationMiniChart({ rows }: { rows: ImitationTrackRow[] }) {
  if (rows.length < 2) {
    return <span className="text-xs text-gray-400">데이터 1점 — 추이 미정</span>
  }
  const counts = rows.map((r) => r.serp_listing_count)
  const max = Math.max(...counts, 1)
  const min = Math.min(...counts, 0)
  const w = 200
  const h = 60
  const span = Math.max(1, max - min)
  const pts = counts.map((c, i) => {
    const x = (i / (counts.length - 1)) * w
    const y = h - ((c - min) / span) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        points={pts.join(' ')}
        className="text-amber-600"
      />
    </svg>
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
