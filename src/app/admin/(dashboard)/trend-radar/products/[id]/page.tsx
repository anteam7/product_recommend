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

interface HalflifeRow {
  t_half_weeks: number | null
  ci_low: number | null
  ci_high: number | null
  analog_ids: string[]
  analog_count: number
  confidence: 'high' | 'mid' | 'low'
  current_score: number | null
  weeks_observed: number | null
  computed_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, hlRes] = await Promise.all([
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
    // 신규 테이블 — generated 타입 미반영 → any 캐스팅
    (sb as any)
      .from('jimscanner_trends_halflife_forecasts')
      .select('t_half_weeks, ci_low, ci_high, analog_ids, analog_count, confidence, current_score, weeks_observed, computed_at')
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    halflife: ((hlRes as any)?.data ?? null) as HalflifeRow | null,
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
  const { product, aliases, scoreHistory, halflife } = data
  const latest = scoreHistory[0]
  // scoreHistory 는 최신→과거 순. 스파크라인엔 시간순(과거→최신)이 필요.
  const sparkSeries = [...scoreHistory].reverse().map((s) => Number(s.final_score))

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

      {/* 반감기(T½) 예측 카드 */}
      <HalflifeCard halflife={halflife} sparkSeries={sparkSeries} latestScore={latest?.final_score ?? null} />

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

function Sparkline({ series, width = 240, height = 60 }: { series: number[]; width?: number; height?: number }) {
  if (series.length < 2) {
    return <div className="text-xs text-gray-400">데이터 부족</div>
  }
  const max = Math.max(...series, 1)
  const min = Math.min(...series, 0)
  const range = Math.max(max - min, 1)
  const step = width / (series.length - 1)
  const points = series
    .map((v, i) => `${(i * step).toFixed(2)},${(height - ((v - min) / range) * height).toFixed(2)}`)
    .join(' ')
  return (
    <svg width={width} height={height} className="block">
      <polyline points={points} fill="none" stroke="#d97706" strokeWidth="2" />
    </svg>
  )
}

function HalflifeCard({
  halflife,
  sparkSeries,
  latestScore,
}: {
  halflife: HalflifeRow | null
  sparkSeries: number[]
  latestScore: number | null
}) {
  if (!halflife) {
    return (
      <section className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-500">
        <div className="font-semibold text-gray-700 mb-1">⏳ 반감기(T½) 예측</div>
        <p className="text-xs">
          아직 예측 row 가 없음. <code className="font-mono">scripts/predict-halflife.mjs</code> 가 24h 주기로 돈 뒤 표시됨.
        </p>
      </section>
    )
  }

  const confColor =
    halflife.confidence === 'high'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : halflife.confidence === 'mid'
        ? 'bg-amber-100 text-amber-800 border-amber-200'
        : 'bg-gray-100 text-gray-600 border-gray-200'

  const tHalf = halflife.t_half_weeks
  const ciLow = halflife.ci_low
  const ciHigh = halflife.ci_high

  return (
    <section className="rounded border border-amber-200 bg-amber-50/30 p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-amber-900">⏳ 반감기(T½) 예측</h2>
            <span className={`text-[10px] px-2 py-0.5 rounded border ${confColor} font-medium uppercase`}>
              {halflife.confidence}
            </span>
            <span className="text-[10px] text-gray-500 font-mono">
              analog {halflife.analog_count}건 · 관측 {halflife.weeks_observed}주
            </span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-bold text-amber-700 font-mono">
              {tHalf != null ? Number(tHalf).toFixed(1) : '—'}
            </span>
            <span className="text-sm text-gray-600">주 (T½)</span>
            {ciLow != null && ciHigh != null && (
              <span className="text-xs text-gray-500 font-mono">
                80% CI: {Number(ciLow).toFixed(1)} ~ {Number(ciHigh).toFixed(1)}주
              </span>
            )}
          </div>
          {tHalf == null && (
            <p className="text-xs text-gray-500 mt-2">
              analog 풀 부족 — 신규 카테고리이거나 매칭 종료 트렌드가 없음. confidence='low' 권고: <strong>보수적 진입</strong>.
            </p>
          )}
          {tHalf != null && (
            <p className="text-xs text-gray-600 mt-2">
              현재 점수 {latestScore ?? '—'} → 절반 {latestScore != null ? Math.round(Number(latestScore) / 2) : '—'} 도달까지 {Number(tHalf).toFixed(1)}주 예상.
              위탁 통관 2~3주 가정 시{' '}
              {tHalf != null && Number(tHalf) <= 3 ? (
                <strong className="text-red-700">⚠ 입고 시점에 반감기 임박 — 진입 비권장</strong>
              ) : tHalf != null && Number(tHalf) <= 6 ? (
                <strong className="text-amber-700">소량 진입 권장</strong>
              ) : (
                <strong className="text-emerald-700">정상 진입 가능</strong>
              )}
              .
            </p>
          )}
          <PaybackSimulator tHalf={tHalf} ciLow={ciLow} ciHigh={ciHigh} />
        </div>
        <div className="text-right">
          <div className="text-[10px] text-gray-500 mb-1">final_score 추이</div>
          <Sparkline series={sparkSeries} />
        </div>
      </div>
    </section>
  )
}

function PaybackSimulator({
  tHalf,
  ciLow,
  ciHigh,
}: {
  tHalf: number | null
  ciLow: number | null
  ciHigh: number | null
}) {
  if (tHalf == null) return null
  // SSR 컴포넌트라 input/state 없이, 고정 시나리오(입고 N=100, 통관 3주, 주당 판매율 30%) 로 잔여 재고 표시.
  const stockIn = 100
  const customsWeeks = 3
  const weeklySellRate = 0.3
  // T½ 도달까지 남은 주차 — 통관 기간 제외
  const effective = Math.max(0, tHalf - customsWeeks)
  const sold = Math.min(stockIn, Math.round(stockIn * (1 - Math.pow(1 - weeklySellRate, effective))))
  const remaining = stockIn - sold
  const lowEff = ciLow != null ? Math.max(0, ciLow - customsWeeks) : effective
  const highEff = ciHigh != null ? Math.max(0, ciHigh - customsWeeks) : effective
  const remLow = stockIn - Math.min(stockIn, Math.round(stockIn * (1 - Math.pow(1 - weeklySellRate, lowEff))))
  const remHigh = stockIn - Math.min(stockIn, Math.round(stockIn * (1 - Math.pow(1 - weeklySellRate, highEff))))
  return (
    <div className="mt-3 rounded bg-white/70 border border-amber-100 px-3 py-2 text-xs">
      <div className="font-semibold text-gray-700 mb-1">💰 payback 시뮬레이터 (입고 100개 · 통관 3주 · 주당 30% 판매)</div>
      <div className="font-mono text-gray-700">
        T½ 도달 시 잔여 재고: <strong className="text-amber-700 text-base">{remaining}개</strong>
        <span className="text-gray-500 ml-2">
          (CI: {Math.min(remLow, remHigh)} ~ {Math.max(remLow, remHigh)}개)
        </span>
      </div>
      <div className="text-[10px] text-gray-500 mt-1">
        잔여 = 100 × (1 − 0.3)^max(0, T½ − 3) · 잔여가 클수록 데드스톡 리스크 ↑
      </div>
    </div>
  )
}
