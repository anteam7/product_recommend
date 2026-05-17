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

interface LagSample {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  first_seen_at: string
  first_spike_at: string
  lag_days: number
  matched_keyword: string
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

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
  }
}

async function fetchLagSamples(categoryTop: string): Promise<LagSample[]> {
  const sb = createAdminClient()
  // RPC: supabase/trends_v4_supply_demand_lag.sql 적용 후 사용 가능
  const { data, error } = await sb.rpc('jimscanner_supply_demand_lag_samples' as never, {
    p_category_top: categoryTop,
    days_window: 180,
    min_sim: 0.30,
    spike_threshold: 40,
    sample_limit: 200,
  } as never)
  if (error || !data) return []
  return data as LagSample[]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory } = data
  const latest = scoreHistory[0]

  const lagSamples = await fetchLagSamples(product.category_top)
  const sortedLags = lagSamples
    .map((s) => Number(s.lag_days))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b)
  const lagStats = sortedLags.length
    ? {
        n: sortedLags.length,
        p50: percentile(sortedLags, 0.5),
        p90: percentile(sortedLags, 0.9),
        mean: sortedLags.reduce((a, b) => a + b, 0) / sortedLags.length,
        max: sortedLags[sortedLags.length - 1],
      }
    : null

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

      {/* 공급→수요 lag 분포 (ggsan first_seen → trends_keywords first-spike) */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          공급→수요 lag 분포{' '}
          <span className="text-xs font-normal text-gray-500">
            (카테고리: {product.category_top} · ggsan 입고 → 검색 첫 정점까지)
          </span>
        </h2>
        {!lagStats ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            카테고리 표본 부족 — 더 많은 ggsan 입고 + naver_search_trend 누적 후 재계산됩니다.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
              <LagStat label="표본 n" value={`${lagStats.n}`} />
              <LagStat label="P50 (정점 중앙)" value={`D+${lagStats.p50.toFixed(1)}일`} accent />
              <LagStat label="P90 (윈도우 끝)" value={`D+${lagStats.p90.toFixed(1)}일`} accent />
              <LagStat label="평균" value={`${lagStats.mean.toFixed(1)}일`} />
              <LagStat label="최대" value={`${lagStats.max.toFixed(0)}일`} />
            </div>
            <LagScatter samples={lagSamples} p50={lagStats.p50} p90={lagStats.p90} />
            <p className="text-[11px] text-gray-500">
              x축 = 공급(입고) 시점 D+0 기준 경과일 / y축 = 매칭 키워드(첫 검색 정점) lag. P50 안쪽 = listing/광고 골든 윈도우.
            </p>
          </div>
        )}
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

function LagStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={`rounded border p-2 ${
        accent ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
      }`}
    >
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className={`mt-0.5 text-base font-bold ${accent ? 'text-amber-700' : 'text-gray-800'}`}>
        {value}
      </div>
    </div>
  )
}

function LagScatter({
  samples,
  p50,
  p90,
}: {
  samples: LagSample[]
  p50: number
  p90: number
}) {
  const W = 720
  const H = 200
  const padL = 32
  const padR = 8
  const padT = 8
  const padB = 22
  const maxX = Math.max(p90 * 1.1, ...samples.map((s) => Number(s.lag_days)), 7)
  const xs = (x: number) => padL + ((W - padL - padR) * x) / maxX
  const jitter = (i: number) => ((i * 73) % 100) / 100 // deterministic
  const y = (i: number) => padT + (H - padT - padB) * (0.15 + 0.7 * jitter(i))
  return (
    <div className="rounded border border-gray-200 bg-white overflow-x-auto">
      <svg width={W} height={H} className="block">
        {/* P50/P90 가이드 */}
        <line x1={xs(p50)} y1={padT} x2={xs(p50)} y2={H - padB} stroke="#f59e0b" strokeDasharray="4 3" />
        <line x1={xs(p90)} y1={padT} x2={xs(p90)} y2={H - padB} stroke="#dc2626" strokeDasharray="4 3" />
        <text x={xs(p50) + 4} y={padT + 10} fontSize="10" fill="#b45309">
          P50 D+{p50.toFixed(1)}
        </text>
        <text x={xs(p90) + 4} y={padT + 22} fontSize="10" fill="#b91c1c">
          P90 D+{p90.toFixed(1)}
        </text>
        {/* x축 */}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#d1d5db" />
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const x = padL + (W - padL - padR) * t
          const v = (maxX * t).toFixed(0)
          return (
            <g key={i}>
              <line x1={x} y1={H - padB} x2={x} y2={H - padB + 3} stroke="#9ca3af" />
              <text x={x} y={H - padB + 14} fontSize="10" fill="#6b7280" textAnchor="middle">
                D+{v}
              </text>
            </g>
          )
        })}
        {/* y축 라벨 */}
        <text x={4} y={padT + 12} fontSize="10" fill="#6b7280">
          SKU
        </text>
        {/* 점 */}
        {samples.map((s, i) => {
          const lag = Number(s.lag_days)
          if (!Number.isFinite(lag) || lag < 0) return null
          return (
            <circle
              key={s.goods_no + i}
              cx={xs(lag)}
              cy={y(i)}
              r={3}
              fill={lag <= p50 ? '#059669' : lag <= p90 ? '#f59e0b' : '#9ca3af'}
              opacity={0.75}
            >
              <title>{`${s.title}\nlag = ${lag.toFixed(1)}일\nkw = ${s.matched_keyword}`}</title>
            </circle>
          )
        })}
      </svg>
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
