import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  returnRiskLabel,
  RETURN_RISK_TONE_CLASS,
} from '@/lib/trends/return-risk'

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
  return_risk_score: number | null
  score_components: any
  computed_at: string
}

interface BaselineRow {
  category_top: string
  category_mid: string | null
  return_rate_low: number
  return_rate_high: number
  return_rate_mid: number
  notes: string | null
}

interface ReviewSignalRow {
  low_star_ratio: number | null
  total_reviews: number | null
  keyword_counts: Record<string, number> | null
  source: string | null
  collected_at: string
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
      .select('trend_score, commerce_score, supplier_score, competition_score, final_score, return_risk_score, score_components, computed_at' as any)
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(30),
  ])

  if (prodRes.error || !prodRes.data) return null

  const product = prodRes.data as ProductRow

  // 카테고리 베이스라인 + 리뷰 시그널 (둘 다 신규 테이블, RLS service-role only)
  const [baselineRes, reviewRes] = await Promise.all([
    sb
      .from('jimscanner_returns_baseline' as any)
      .select('category_top, category_mid, return_rate_low, return_rate_high, return_rate_mid, notes')
      .eq('category_top', product.category_top)
      .is('category_mid', null)
      .maybeSingle(),
    sb
      .from('jimscanner_trends_review_signals' as any)
      .select('low_star_ratio, total_reviews, keyword_counts, source, collected_at')
      .eq('product_id', id)
      .order('collected_at', { ascending: false })
      .limit(10),
  ])

  return {
    product,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as unknown as ScoreRow[],
    baseline: ((baselineRes as any).data ?? null) as BaselineRow | null,
    reviewSignals: (((reviewRes as any).data ?? []) as unknown) as ReviewSignalRow[],
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
  const { product, aliases, scoreHistory, baseline, reviewSignals } = data
  const latest = scoreHistory[0]

  // 부정 키워드 누적: 최근 10건 review_signals 합산
  const aggregatedKeywords: Record<string, number> = {}
  let totalReviewSamples = 0
  let weightedLowStar = 0
  for (const r of reviewSignals) {
    const kw = r.keyword_counts ?? {}
    for (const [k, v] of Object.entries(kw)) {
      aggregatedKeywords[k] = (aggregatedKeywords[k] ?? 0) + (typeof v === 'number' ? v : 0)
    }
    if (r.total_reviews) {
      totalReviewSamples += r.total_reviews
      if (r.low_star_ratio != null) {
        weightedLowStar += r.low_star_ratio * r.total_reviews
      }
    }
  }
  const avgLowStarRatio =
    totalReviewSamples > 0 ? weightedLowStar / totalReviewSamples : null
  const topNegativeKeywords = Object.entries(aggregatedKeywords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
  const maxKwCount = topNegativeKeywords[0]?.[1] ?? 0

  const riskBadge = returnRiskLabel(latest?.return_risk_score ?? null)

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

      {/* 4점수 카드 + 반품위험 */}
      {latest && (
        <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <ScoreCard label="final" value={latest.final_score} bold />
          <ScoreCard label="trend" value={latest.trend_score} />
          <ScoreCard label="commerce" value={latest.commerce_score} />
          <ScoreCard label="supplier" value={latest.supplier_score} />
          <ScoreCard label="competition" value={latest.competition_score} />
          <div
            className={`rounded border p-3 text-center ${
              latest.return_risk_score != null
                ? RETURN_RISK_TONE_CLASS[riskBadge.tone]
                : RETURN_RISK_TONE_CLASS.unknown
            }`}
          >
            <div className="text-xs uppercase opacity-70">⚠️ 반품위험</div>
            <div className="mt-1 text-2xl font-bold">
              {latest.return_risk_score != null ? Math.round(latest.return_risk_score) : '—'}
            </div>
            <div className="text-[10px] mt-0.5 font-medium">{riskBadge.label}</div>
          </div>
        </section>
      )}

      {/* 반품위험 breakdown — 베이스라인 vs 본 상품 */}
      {(baseline || reviewSignals.length > 0) && (
        <section className="rounded border border-gray-200 p-4 bg-amber-50/30">
          <h2 className="text-sm font-semibold mb-3">
            ⚠️ 반품위험 분석
            <span className="ml-2 text-xs font-normal text-gray-500">
              위탁셀러 hidden cost — 반품 1건당 단가의 30~50% 손실
            </span>
          </h2>

          <div className="grid md:grid-cols-2 gap-4">
            {/* 베이스라인 delta */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-700">카테고리 베이스라인</div>
              {baseline ? (
                <div className="rounded bg-white border border-gray-200 p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-gray-600">{baseline.category_top}</span>
                    <span className="font-mono text-sm">
                      {baseline.return_rate_low}~{baseline.return_rate_high}%{' '}
                      <span className="text-gray-400">(중앙 {baseline.return_rate_mid}%)</span>
                    </span>
                  </div>
                  {/* 막대: low~high 범위 표시 + 중앙값 마커 */}
                  <div className="mt-2 relative h-3 bg-gray-100 rounded overflow-hidden">
                    <div
                      className="absolute top-0 bottom-0 bg-amber-300/60"
                      style={{
                        left: `${(baseline.return_rate_low / 50) * 100}%`,
                        width: `${((baseline.return_rate_high - baseline.return_rate_low) / 50) * 100}%`,
                      }}
                    />
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-amber-700"
                      style={{ left: `${(baseline.return_rate_mid / 50) * 100}%` }}
                    />
                  </div>
                  {baseline.notes && (
                    <div className="text-[11px] text-gray-500 mt-2">{baseline.notes}</div>
                  )}
                </div>
              ) : (
                <div className="rounded bg-white border border-dashed border-gray-300 p-3 text-xs text-gray-500">
                  카테고리 <code>{product.category_top}</code> 베이스라인 미등록.{' '}
                  <code>jimscanner_returns_baseline</code> 시드 필요.
                </div>
              )}

              {/* 본 상품 측정치 */}
              <div className="rounded bg-white border border-gray-200 p-3">
                <div className="text-xs text-gray-700 font-semibold mb-1">본 상품 측정치</div>
                <dl className="text-xs space-y-1">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">1~2점 비율</dt>
                    <dd className="font-mono">
                      {avgLowStarRatio != null
                        ? `${(avgLowStarRatio * 100).toFixed(1)}%`
                        : '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">표본 리뷰 수</dt>
                    <dd className="font-mono">
                      {totalReviewSamples > 0 ? totalReviewSamples.toLocaleString() : '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">부정 키워드 합계</dt>
                    <dd className="font-mono">
                      {Object.values(aggregatedKeywords).reduce((s, v) => s + v, 0) || '—'}
                    </dd>
                  </div>
                </dl>
                {reviewSignals.length === 0 && (
                  <div className="text-[10px] text-gray-400 mt-2">
                    SERP 리뷰델타 파이프라인 미적재 — 점수는 베이스라인만 반영.
                  </div>
                )}
              </div>
            </div>

            {/* 부정 키워드 워드클라우드 */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-700">부정 리뷰 키워드</div>
              {topNegativeKeywords.length > 0 ? (
                <div className="rounded bg-white border border-gray-200 p-3 flex flex-wrap gap-2 items-baseline min-h-[120px]">
                  {topNegativeKeywords.map(([kw, cnt]) => {
                    const ratio = maxKwCount > 0 ? cnt / maxKwCount : 0
                    // 12px ~ 28px 사이로 크기 매핑
                    const fontSize = 12 + Math.round(ratio * 16)
                    const opacity = 0.5 + ratio * 0.5
                    return (
                      <span
                        key={kw}
                        className="text-red-700 font-medium"
                        style={{ fontSize: `${fontSize}px`, opacity }}
                        title={`${kw}: ${cnt}회`}
                      >
                        {kw}
                        <span className="text-[10px] text-gray-400 ml-0.5 font-mono">
                          {cnt}
                        </span>
                      </span>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded bg-white border border-dashed border-gray-300 p-3 text-xs text-gray-500 min-h-[120px] flex items-center justify-center">
                  부정 리뷰 키워드 데이터 없음
                </div>
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
                  <th className="px-3 py-2 text-right">⚠️ return</th>
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
                    <td className="px-3 py-1 text-right">
                      {s.return_risk_score != null ? Math.round(s.return_risk_score) : '—'}
                    </td>
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
