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
interface SerpRow {
  keyword: string
  listing_count: number | null
  price_min: number | null
  price_p25: number | null
  price_median: number | null
  price_p75: number | null
  price_max: number | null
  top_review_sum: number | null
  avg_review: number | null
  rocket_share: number | null
  ad_slot_share: number | null
  low_competition: number | null
  low_review_saturation: number | null
  captured_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, serpRes] = await Promise.all([
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
    // 경쟁 실측: 최신 SERP 스냅샷 (마이그레이션 trends_serp_snapshot.sql 적용 후 동작) — as any.
    (sb as any)
      .from('jimscanner_trends_serp_latest')
      .select(
        'keyword, listing_count, price_min, price_p25, price_median, price_p75, price_max, top_review_sum, avg_review, rocket_share, ad_slot_share, low_competition, low_review_saturation, captured_at',
      )
      .eq('product_id', id)
      .maybeSingle(),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    serp: (serpRes?.data ?? null) as SerpRow | null,
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
  const { product, aliases, scoreHistory, serp } = data
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

      {/* 경쟁 실측 패널 — 쿠팡 SERP 스냅샷으로 competition_score 접지 */}
      <CompetitionPanel serp={serp} competitionScore={latest?.competition_score} />

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

function fmtWon(n: number | null | undefined) {
  return n == null ? '—' : `${Number(n).toLocaleString('ko-KR')}원`
}
function freshness(capturedAt: string) {
  const hrs = (Date.now() - new Date(capturedAt).getTime()) / 36e5
  if (hrs < 24) return { label: `${Math.max(0, Math.round(hrs))}시간 전`, stale: false }
  return { label: `${Math.round(hrs / 24)}일 전`, stale: hrs > 24 * 7 }
}

function CompetitionPanel({
  serp,
  competitionScore,
}: {
  serp: SerpRow | null
  competitionScore?: number
}) {
  if (!serp) {
    return (
      <section className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">경쟁 실측 (쿠팡 SERP)</h2>
        아직 실측 스냅샷이 없습니다. <code className="text-xs">scripts/collect-coupang-serp.mjs</code> 가
        다음 수집 사이클에 적재합니다 (run-crons <code className="text-xs">--serp</code> 단계).
      </section>
    )
  }

  const fresh = freshness(serp.captured_at)
  // 실가격대 박스플롯 좌표 (min ~ max 범위를 0~100%로 매핑)
  const lo = serp.price_min ?? 0
  const hi = serp.price_max ?? lo + 1
  const span = Math.max(hi - lo, 1)
  const pct = (v: number | null) => (v == null ? null : ((v - lo) / span) * 100)
  const p25 = pct(serp.price_p25)
  const p75 = pct(serp.price_p75)
  const med = pct(serp.price_median)

  return (
    <section className="rounded border border-gray-200 p-4 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">
          경쟁 실측 (쿠팡 SERP) · <span className="font-mono text-xs text-gray-500">“{serp.keyword}”</span>
        </h2>
        <span className={`text-xs ${fresh.stale ? 'text-red-500' : 'text-gray-400'}`}>
          수집 {fresh.label}
          {fresh.stale ? ' ⚠ 오래됨' : ''}
        </span>
      </div>

      {/* 파생 competition 컴포넌트 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="검색결과 수"
          value={serp.listing_count != null ? `${serp.listing_count}개` : '—'}
          sub={serp.low_competition != null ? `low_comp ${Math.round(serp.low_competition)}` : undefined}
        />
        <MetricCard
          label="평균 리뷰"
          value={serp.avg_review != null ? serp.avg_review.toLocaleString('ko-KR') : '—'}
          sub={
            serp.low_review_saturation != null
              ? `low_sat ${Math.round(serp.low_review_saturation)}`
              : undefined
          }
        />
        <MetricCard
          label="로켓 점유"
          value={serp.rocket_share != null ? `${Math.round(serp.rocket_share * 100)}%` : '—'}
        />
        <MetricCard
          label="광고 점유"
          value={serp.ad_slot_share != null ? `${Math.round(serp.ad_slot_share * 100)}%` : '—'}
        />
      </div>

      {/* 실가격대 박스플롯 */}
      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>실가격대</span>
          <span>
            중앙값 <span className="font-semibold text-gray-700">{fmtWon(serp.price_median)}</span>
          </span>
        </div>
        <div className="relative h-8 rounded bg-gray-100">
          {/* 전체 min~max 막대 */}
          <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-300" />
          {/* IQR 박스 */}
          {p25 != null && p75 != null && (
            <div
              className="absolute top-1 bottom-1 rounded bg-blue-200/70 border border-blue-400"
              style={{ left: `${p25}%`, width: `${Math.max(p75 - p25, 1)}%` }}
            />
          )}
          {/* 중앙값 라인 */}
          {med != null && (
            <div className="absolute top-0 bottom-0 w-0.5 bg-blue-700" style={{ left: `${med}%` }} />
          )}
        </div>
        <div className="flex justify-between text-[11px] text-gray-500 mt-1">
          <span>{fmtWon(serp.price_min)}</span>
          <span>P25 {fmtWon(serp.price_p25)}</span>
          <span>P75 {fmtWon(serp.price_p75)}</span>
          <span>{fmtWon(serp.price_max)}</span>
        </div>
      </div>

      {competitionScore != null && (
        <p className="text-[11px] text-gray-400">
          현재 competition_score = {competitionScore} · 위 실측이 recompute_scores 에서
          low_competition / low_review_saturation 으로 반영됩니다.
        </p>
      )}
    </section>
  )
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-gray-800">{value}</div>
      {sub && <div className="text-[10px] font-mono text-gray-400 mt-0.5">{sub}</div>}
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
