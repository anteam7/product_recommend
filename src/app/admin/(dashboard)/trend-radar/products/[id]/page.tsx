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
interface BuzzQualityRow {
  window_days: number
  sample_count: number
  unique_days: number
  kurtosis: number | null
  top1_share: number | null
  cluster_lag_h: number | null
  burst_score: number | null
  grade: string
  source_breakdown: Record<string, number>
  computed_at: string
}
interface BuzzDailyRow {
  day: string
  source: string
  cnt: number
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, buzzRes, buzzDailyRes] = await Promise.all([
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
    // 버즈 분포 분석 — supabase/buzz_quality.sql 적용 후 캐스팅 제거.
    sb
      .from('jimscanner_trends_buzz_quality' as never)
      .select('window_days, sample_count, unique_days, kurtosis, top1_share, cluster_lag_h, burst_score, grade, source_breakdown, computed_at')
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(1) as unknown as Promise<{ data: BuzzQualityRow[] | null; error: { message: string } | null }>,
    sb.rpc('jimscanner_buzz_daily_for_product' as never, {
      p_product_id: id,
      p_window_days: 14,
    } as never) as unknown as Promise<{ data: BuzzDailyRow[] | null; error: { message: string } | null }>,
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    buzzQuality: (buzzRes.data?.[0] ?? null) as BuzzQualityRow | null,
    buzzDaily: (buzzDailyRes.data ?? []) as BuzzDailyRow[],
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
  const { product, aliases, scoreHistory, buzzQuality, buzzDaily } = data
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

      {/* 버즈 분포 분석 — Sponsored vs Organic */}
      <BuzzQualityPanel buzzQuality={buzzQuality} buzzDaily={buzzDaily} />

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

// ─────────────────────────────────────────────────────────────
// 버즈 분포 패널 — kurtosis / top1_share / cluster_lag / grade + 일별 sparkline
// ─────────────────────────────────────────────────────────────
function GradeBadge({ grade }: { grade: string }) {
  const meta: Record<string, { label: string; cls: string }> = {
    organic: { label: '🌱 organic', cls: 'bg-green-100 text-green-800 border-green-200' },
    mixed: { label: '🟡 mixed', cls: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    sponsored_suspect: { label: '⚠ sponsored 의심', cls: 'bg-red-100 text-red-800 border-red-200' },
    insufficient: { label: '· 표본 부족', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  }
  const m = meta[grade] ?? meta.insufficient
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded border ${m.cls} font-medium`}>
      {m.label}
    </span>
  )
}

function BuzzQualityPanel({
  buzzQuality,
  buzzDaily,
}: {
  buzzQuality: {
    window_days: number
    sample_count: number
    unique_days: number
    kurtosis: number | null
    top1_share: number | null
    cluster_lag_h: number | null
    burst_score: number | null
    grade: string
    source_breakdown: Record<string, number>
    computed_at: string
  } | null
  buzzDaily: { day: string; source: string; cnt: number }[]
}) {
  // 일별 합계 (source 별 stacked sparkline 용)
  const dayMap = new Map<string, Record<string, number>>()
  for (const r of buzzDaily) {
    if (!dayMap.has(r.day)) dayMap.set(r.day, {})
    dayMap.get(r.day)![r.source] = (dayMap.get(r.day)![r.source] ?? 0) + r.cnt
  }
  const window = buzzQuality?.window_days ?? 14
  const today = new Date()
  const days: { day: string; counts: Record<string, number>; total: number }[] = []
  for (let i = window - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000)
    const kst = new Date(d.getTime() + 9 * 3600_000)
    const key = kst.toISOString().slice(0, 10)
    const counts = dayMap.get(key) ?? {}
    const total = Object.values(counts).reduce((s, v) => s + v, 0)
    days.push({ day: key, counts, total })
  }
  const maxTotal = Math.max(1, ...days.map((d) => d.total))
  const sourceColor: Record<string, string> = {
    naver_blog: 'bg-emerald-500',
    naver_news: 'bg-sky-500',
    quasarzone_sale: 'bg-violet-500',
  }
  const sourceLabel: Record<string, string> = {
    naver_blog: '블로그',
    naver_news: '뉴스',
    quasarzone_sale: '퀘사존',
  }

  return (
    <section>
      <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
        🔬 버즈 분포 분석 (sponsored vs organic)
        {buzzQuality && <GradeBadge grade={buzzQuality.grade} />}
      </h2>

      {!buzzQuality ? (
        <div className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
          아직 분류 안 됨. <code className="font-mono">scripts/buzz-quality-classify.mjs</code> 실행 후 다시 확인.
        </div>
      ) : (
        <div className="rounded border border-gray-200 p-4 space-y-3">
          {/* 지표 4개 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <Metric label="sample" value={buzzQuality.sample_count.toString()} />
            <Metric label="unique days" value={`${buzzQuality.unique_days}/${buzzQuality.window_days}`} />
            <Metric
              label="kurtosis"
              value={buzzQuality.kurtosis != null ? buzzQuality.kurtosis.toFixed(2) : '—'}
              hint="↑ 한 날 집중"
            />
            <Metric
              label="top1 share"
              value={buzzQuality.top1_share != null ? `${(buzzQuality.top1_share * 100).toFixed(0)}%` : '—'}
              hint="최대 적재일 비중"
            />
            <Metric
              label="cluster lag"
              value={buzzQuality.cluster_lag_h != null ? `${buzzQuality.cluster_lag_h.toFixed(0)}h` : '—'}
              hint="첫 등장→80%"
            />
          </div>

          {/* burst_score */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">burst_score</span>
            <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
              <div
                className={`h-full ${
                  (buzzQuality.burst_score ?? 0) >= 0.65
                    ? 'bg-red-500'
                    : (buzzQuality.burst_score ?? 0) >= 0.4
                    ? 'bg-yellow-500'
                    : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(100, (buzzQuality.burst_score ?? 0) * 100)}%` }}
              />
            </div>
            <span className="text-xs font-mono w-12 text-right">
              {(buzzQuality.burst_score ?? 0).toFixed(2)}
            </span>
          </div>

          {/* sparkline (stacked) */}
          <div>
            <div className="text-xs text-gray-500 mb-1">최근 {window}일 일별 buzz (source 누적)</div>
            <div className="flex items-end gap-0.5 h-20">
              {days.map((d) => (
                <div
                  key={d.day}
                  title={`${d.day} · 총 ${d.total}건`}
                  className="flex-1 flex flex-col justify-end relative"
                  style={{ minWidth: '4px' }}
                >
                  {(['naver_blog', 'naver_news', 'quasarzone_sale'] as const).map((s) => {
                    const v = d.counts[s] ?? 0
                    if (v === 0) return null
                    const h = (v / maxTotal) * 100
                    return (
                      <div
                        key={s}
                        className={sourceColor[s]}
                        style={{ height: `${h}%` }}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-500">
              {(['naver_blog', 'naver_news', 'quasarzone_sale'] as const).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <span className={`inline-block w-2 h-2 rounded-sm ${sourceColor[s]}`} />
                  {sourceLabel[s]} ({buzzQuality.source_breakdown?.[s] ?? 0})
                </span>
              ))}
            </div>
          </div>

          <div className="text-[10px] text-gray-400 font-mono pt-1">
            computed_at: {buzzQuality.computed_at.slice(0, 19).replace('T', ' ')}
          </div>
        </div>
      )}
    </section>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 px-2 py-1">
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className="text-base font-mono">{value}</div>
      {hint && <div className="text-[9px] text-gray-400">{hint}</div>}
    </div>
  )
}
