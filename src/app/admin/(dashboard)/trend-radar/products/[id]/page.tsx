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

interface InflectionRow {
  score_kind: 'final' | 'trend' | 'commerce' | 'supplier' | 'competition'
  latest_score: number
  slope_7d: number
  accel_7d: number
  sample_count: number
  quadrant: 'accel_up' | 'decel_up' | 'accel_down' | 'decel_down' | 'flat'
  rank_score: number
  computed_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, inflRes] = await Promise.all([
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
      .from('jimscanner_trends_inflection' as never)
      .select('score_kind, latest_score, slope_7d, accel_7d, sample_count, quadrant, rank_score, computed_at')
      .eq('product_id', id),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    inflection: ((inflRes.data ?? []) as unknown as InflectionRow[]) ?? [],
  }
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { id } = await params
  const sp = await searchParams
  const tab = sp.tab === 'trajectory' ? 'trajectory' : 'overview'
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, inflection } = data
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

      {/* 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        <Link
          href={`/admin/trend-radar/products/${product.id}`}
          className={`px-3 py-2 text-sm ${
            tab === 'overview'
              ? 'border-b-2 border-black font-semibold text-black'
              : 'text-gray-500 hover:text-black'
          }`}
        >
          개요
        </Link>
        <Link
          href={`/admin/trend-radar/products/${product.id}?tab=trajectory`}
          className={`px-3 py-2 text-sm ${
            tab === 'trajectory'
              ? 'border-b-2 border-black font-semibold text-black'
              : 'text-gray-500 hover:text-black'
          }`}
        >
          🔺 변곡 (trajectory)
        </Link>
      </nav>

      {tab === 'trajectory' ? (
        <TrajectoryTab inflection={inflection} scoreHistory={scoreHistory} />
      ) : (
        <OverviewTab
          latest={latest}
          scoreHistory={scoreHistory}
          aliases={aliases}
          product={product}
        />
      )}
    </div>
  )
}

function OverviewTab({
  latest,
  scoreHistory,
  aliases,
  product,
}: {
  latest: ScoreRow | undefined
  scoreHistory: ScoreRow[]
  aliases: AliasRow[]
  product: ProductRow
}) {
  return (
    <>
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
    </>
  )
}

const SCORE_KIND_COLOR: Record<string, string> = {
  final: '#111827',
  trend: '#059669',
  commerce: '#2563eb',
  supplier: '#7c3aed',
  competition: '#e11d48',
}

const QUADRANT_LABEL: Record<string, string> = {
  accel_up: '🚀 가속·상승',
  decel_up: '⚠️ 감속·상승',
  accel_down: '🔻 가속·하락',
  decel_down: '🌱 감속·하락',
  flat: '➖ 정체',
}

function TrajectoryTab({
  inflection,
  scoreHistory,
}: {
  inflection: InflectionRow[]
  scoreHistory: ScoreRow[]
}) {
  // score_kind 별 inflection map
  const infByKind = new Map<string, InflectionRow>()
  for (const r of inflection) infByKind.set(r.score_kind, r)

  // 시계열은 오래된 → 최근 순으로 sparkline 그리기 (scoreHistory 는 desc 순)
  const series = [...scoreHistory].reverse()

  const kinds: Array<{ k: InflectionRow['score_kind']; column: keyof ScoreRow }> = [
    { k: 'final', column: 'final_score' },
    { k: 'trend', column: 'trend_score' },
    { k: 'commerce', column: 'commerce_score' },
    { k: 'supplier', column: 'supplier_score' },
    { k: 'competition', column: 'competition_score' },
  ]

  return (
    <>
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {kinds.map(({ k, column }) => {
          const inf = infByKind.get(k)
          const values = series
            .map((s) => Number(s[column]))
            .filter((v) => Number.isFinite(v))
          return (
            <div key={k} className="rounded border border-gray-200 p-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-xs uppercase text-gray-500">{k}</div>
                  <div className="text-2xl font-mono font-semibold">
                    {inf ? inf.latest_score : values[values.length - 1] ?? '—'}
                  </div>
                </div>
                <div className="text-right text-xs">
                  {inf ? (
                    <>
                      <div className="text-xs text-gray-700 font-medium">
                        {QUADRANT_LABEL[inf.quadrant] ?? inf.quadrant}
                      </div>
                      <div className="font-mono text-gray-500 mt-0.5">
                        slope {fmtNum(inf.slope_7d)} / accel {fmtNum(inf.accel_7d)}
                      </div>
                      <div className="font-mono text-gray-400 text-[10px]">
                        n={inf.sample_count}
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-gray-400">변곡 미산출</div>
                  )}
                </div>
              </div>
              <Sparkline
                values={values}
                color={SCORE_KIND_COLOR[k] ?? '#111827'}
                markerLast={!!inf}
              />
            </div>
          )
        })}
      </section>

      <section className="text-xs text-gray-500">
        변곡 산출 = 최근 7일 회귀 slope − 직전 7일 slope · rank = |slope| × |accel|
      </section>
    </>
  )
}

function Sparkline({
  values,
  color,
  markerLast,
}: {
  values: number[]
  color: string
  markerLast?: boolean
}) {
  if (values.length < 2) {
    return <div className="mt-2 h-12 text-xs text-gray-400">샘플 부족 ({values.length})</div>
  }
  const w = 280
  const h = 48
  const padX = 2
  const padY = 4
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const n = values.length
  const points = values.map((v, i) => {
    const x = padX + (i / (n - 1)) * (w - padX * 2)
    const y = h - padY - ((v - min) / range) * (h - padY * 2)
    return [x, y] as const
  })
  const d = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="mt-2 w-full h-12"
      aria-hidden
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
      {markerLast && last && (
        <circle cx={last[0]} cy={last[1]} r={3} fill={color} />
      )}
    </svg>
  )
}

function fmtNum(n: number) {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const s = abs >= 10 ? n.toFixed(1) : abs >= 1 ? n.toFixed(2) : n.toFixed(3)
  return n > 0 ? `+${s}` : s
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
