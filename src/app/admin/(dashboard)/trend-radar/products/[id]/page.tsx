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

interface SeasonalityRow {
  year: number
  week_of_year: number
  value: number
  baseline_mean: number | null
  baseline_std: number | null
  baseline_years: number
  novelty_z: number | null
  seasonality_recurrence: number | null
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, seasonalityRes] = await Promise.all([
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
      // jimscanner_trends_seasonality 는 새 테이블 — 타입 생성 전이라 as never 캐스팅 필요.
      .from('jimscanner_trends_seasonality' as never)
      .select('year, week_of_year, value, baseline_mean, baseline_std, baseline_years, novelty_z, seasonality_recurrence')
      .eq('product_id', id)
      .order('year', { ascending: true })
      .order('week_of_year', { ascending: true }),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    seasonality: (seasonalityRes.data ?? []) as unknown as SeasonalityRow[],
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
  const { product, aliases, scoreHistory, seasonality } = data
  const latest = scoreHistory[0]
  const seasonalLatest = seasonality[seasonality.length - 1]
  const isSeasonal =
    typeof seasonalLatest?.seasonality_recurrence === 'number' &&
    seasonalLatest.seasonality_recurrence >= 0.5

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
          {(product.intent_label || product.description || isSeasonal) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {isSeasonal && (
                <span
                  className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium"
                  title={`동주차 평균이 평년 대비 높음 (recurrence=${seasonalLatest!.seasonality_recurrence!.toFixed(2)}) — 매년 반복되는 시즌 상품`}
                >
                  🔁 시즌성
                </span>
              )}
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

      {/* 동주차 3년 평균 vs 올해 */}
      {seasonality.length > 0 && (
        <SeasonalityPanel rows={seasonality} />
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

function SeasonalityPanel({ rows }: { rows: SeasonalityRow[] }) {
  const currentYear = Math.max(...rows.map((r) => r.year))
  const currentRows = rows.filter((r) => r.year === currentYear)
  const pastRows = rows.filter((r) => r.year < currentYear)

  // week → past values map
  const pastByWeek = new Map<number, number[]>()
  for (const r of pastRows) {
    if (!pastByWeek.has(r.week_of_year)) pastByWeek.set(r.week_of_year, [])
    pastByWeek.get(r.week_of_year)!.push(r.value)
  }

  // 차트용 시리즈 (1~53주)
  const series = Array.from({ length: 53 }, (_, i) => {
    const week = i + 1
    const cur = currentRows.find((r) => r.week_of_year === week)
    const past = pastByWeek.get(week) ?? []
    const pastMean = past.length ? past.reduce((a, b) => a + b, 0) / past.length : null
    return { week, current: cur?.value ?? null, pastMean, pastCount: past.length, novelty_z: cur?.novelty_z ?? null }
  })

  const maxVal = Math.max(
    1,
    ...series.flatMap((s) => [s.current ?? 0, s.pastMean ?? 0]),
  )
  const latest = currentRows[currentRows.length - 1]

  return (
    <section>
      <h2 className="text-sm font-semibold mb-2">
        동주차 과거 평균 vs 올해 ({currentYear})
        {latest && (
          <span className="ml-2 text-xs font-normal text-gray-500">
            최신 W{latest.week_of_year}: 값 {latest.value.toFixed(1)}
            {latest.baseline_mean !== null && (
              <> · 베이스라인 {latest.baseline_mean.toFixed(1)} ({latest.baseline_years}년)</>
            )}
            {latest.novelty_z !== null && (
              <> · novelty z={latest.novelty_z.toFixed(2)}</>
            )}
            {latest.seasonality_recurrence !== null && (
              <> · recurrence={latest.seasonality_recurrence.toFixed(2)}</>
            )}
          </span>
        )}
      </h2>
      <div className="rounded border border-gray-200 p-3 bg-white">
        <svg viewBox="0 0 530 140" className="w-full h-32">
          {/* 베이스라인 (회색 점선) */}
          <polyline
            fill="none"
            stroke="#9ca3af"
            strokeWidth="1.5"
            strokeDasharray="3,3"
            points={series
              .filter((s) => s.pastMean !== null)
              .map((s) => `${s.week * 10},${130 - (s.pastMean! / maxVal) * 120}`)
              .join(' ')}
          />
          {/* 올해 (검정 실선) */}
          <polyline
            fill="none"
            stroke="#111"
            strokeWidth="2"
            points={series
              .filter((s) => s.current !== null)
              .map((s) => `${s.week * 10},${130 - (s.current! / maxVal) * 120}`)
              .join(' ')}
          />
        </svg>
        <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0.5 bg-black" /> 올해 ({currentYear})
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t border-dashed border-gray-400" /> 과거 동주차 평균
          </span>
          <span className="text-gray-400">x: ISO 주차 1~53 / y: volume_relative</span>
        </div>
      </div>
    </section>
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
