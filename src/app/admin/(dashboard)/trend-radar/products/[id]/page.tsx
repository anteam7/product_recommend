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

interface VelocityRow {
  day_bucket: number
  reviews_p50: number
  reviews_p90: number
  samples_n: number
  computed_at: string
}
interface PinReviewObservation {
  observed_day_bucket: number
  reviews_count: number
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

  const product = prodRes.data as ProductRow

  // Review SLA — 같은 카테고리의 최신 velocity 분포 + 핀별 실측 카운트
  const [velRes, obsRes] = await Promise.all([
    sb
      .from('jimscanner_trends_review_velocity' as never)
      .select('day_bucket, reviews_p50, reviews_p90, samples_n, computed_at')
      .eq('category_top', product.category_top)
      .order('computed_at', { ascending: false })
      .limit(50),
    sb
      .from('jimscanner_trends_pin_review_counts' as never)
      .select('observed_day_bucket, reviews_count')
      .eq('product_id', id)
      .order('observed_day_bucket', { ascending: true }),
  ])

  const velAll = ((velRes.data ?? []) as unknown) as VelocityRow[]
  const latestAt = velAll[0]?.computed_at ?? null
  const velocity = velAll.filter((v) => v.computed_at === latestAt).sort((a, b) => a.day_bucket - b.day_bucket)
  const observations = ((obsRes.data ?? []) as unknown) as PinReviewObservation[]

  return {
    product,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    velocity,
    observations,
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
  const { product, aliases, scoreHistory, velocity, observations } = data
  const latest = scoreHistory[0]

  // 핀 등록(first_seen) 기준 경과일 + 가장 가까운 SLA 버킷 매칭
  const elapsedDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(product.first_seen_at).getTime()) / 86400_000),
  )
  const currentBucket = velocity.find((v) => elapsedDays <= v.day_bucket) ?? velocity[velocity.length - 1]
  const latestObserved = observations.length > 0
    ? observations[observations.length - 1].reviews_count
    : null
  const slaTarget = currentBucket?.reviews_p90 ?? 0
  const slaMet = latestObserved !== null && latestObserved >= slaTarget

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

      {/* Review SLA 게이지 */}
      {velocity.length > 0 && (
        <section
          className={`rounded border p-4 ${
            latestObserved === null
              ? 'border-gray-200 bg-gray-50'
              : slaMet
              ? 'border-green-300 bg-green-50'
              : 'border-red-400 bg-red-50'
          }`}
        >
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold">
              📈 Review SLA (페이지1 사수 게이트)
            </h2>
            <span className="text-xs text-gray-500">
              핀 경과일 D+{elapsedDays} · 표본 n={currentBucket?.samples_n ?? 0}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-xs text-gray-500">현재 SLA 버킷</div>
              <div className="text-lg font-bold mt-0.5">
                D+{currentBucket?.day_bucket ?? '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">요구 리뷰 (p90)</div>
              <div className="text-lg font-bold mt-0.5">
                {Math.round(currentBucket?.reviews_p90 ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">중간값 (p50)</div>
              <div className="text-lg font-bold mt-0.5">
                {Math.round(currentBucket?.reviews_p50 ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">실측 리뷰</div>
              <div
                className={`text-lg font-bold mt-0.5 ${
                  latestObserved === null
                    ? 'text-gray-400'
                    : slaMet
                    ? 'text-green-700'
                    : 'text-red-700'
                }`}
              >
                {latestObserved ?? '— (미관측)'}
              </div>
            </div>
          </div>
          {latestObserved !== null && !slaMet && (
            <p className="mt-3 text-xs text-red-700 font-medium">
              ⚠ SLA 미달 — 광고예산 / UGC 캠페인 보강 필요. 부족분 ≈{' '}
              {Math.max(0, Math.round(slaTarget - latestObserved))}건.
            </p>
          )}
          {velocity.length > 1 && (
            <div className="mt-4">
              <div className="text-xs text-gray-500 mb-1">카테고리 누적 곡선 (p90)</div>
              <div className="grid grid-cols-7 gap-1">
                {velocity.slice(0, 7).map((v) => {
                  const maxP90 = Math.max(...velocity.map((x) => x.reviews_p90))
                  const h = (v.reviews_p90 / Math.max(1, maxP90)) * 60
                  const here = v.day_bucket === currentBucket?.day_bucket
                  return (
                    <div key={v.day_bucket} className="text-center">
                      <div
                        className={`mx-auto ${here ? 'bg-black' : 'bg-blue-400'} rounded-t`}
                        style={{ width: 16, height: `${Math.max(4, h)}px` }}
                      />
                      <div className="text-[10px] mt-0.5 font-mono text-gray-500">
                        D+{v.day_bucket}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-gray-500">
            카테고리 {product.category_top} SERP 상위 셀러의 리뷰 누적 분포 (p90) 와 비교.
            실측 리뷰는 <code className="bg-white px-1 rounded">jimscanner_trends_pin_review_counts</code>{' '}
            에서 가져옵니다.
          </p>
        </section>
      )}

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
