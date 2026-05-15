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

interface ConvergenceRow {
  product_id: string
  sources: string[]
  source_count: number
  convergence_score: number
}
interface ConvergenceDailyRow {
  product_id: string
  day: string
  source_count: number
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const sbAny = sb as any
  const [prodRes, aliasRes, scoreRes, convRes, sparkRes] = await Promise.all([
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
    sbAny
      .from('jimscanner_trends_source_convergence')
      .select('*')
      .eq('product_id', id)
      .maybeSingle(),
    sbAny
      .from('jimscanner_trends_source_convergence_daily')
      .select('*')
      .eq('product_id', id)
      .order('day', { ascending: true }),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    convergence: (convRes.data ?? null) as ConvergenceRow | null,
    sparkline: (sparkRes.data ?? []) as ConvergenceDailyRow[],
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
  const { product, aliases, scoreHistory, convergence, sparkline } = data
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
          {/* 소스 합치 칩 + sparkline */}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <ConvergenceBadge convergence={convergence} />
            <div className="flex items-center gap-1 flex-wrap">
              {(convergence?.sources ?? []).map((s) => (
                <SourceChip key={s} source={s} />
              ))}
              {(!convergence || convergence.sources.length === 0) && (
                <span className="text-xs text-gray-400">최근 14일 매칭 채널 없음</span>
              )}
            </div>
            <Sparkline rows={sparkline} />
          </div>
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

const SOURCE_LABEL: Record<string, string> = {
  naver_tvtime: 'TV',
  naver_shopping_insight: 'Shop',
  naver_search_trend: 'Search',
  naver_news: 'News',
  naver_blog: 'Blog',
  clien_park: 'Clien',
  quasarzone_sale: 'Quasar',
  ggsan: 'ggsan',
}

function SourceChip({ source }: { source: string }) {
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-gray-100 text-gray-700 border border-gray-200"
      title={source}
    >
      {SOURCE_LABEL[source] ?? source}
    </span>
  )
}

function ConvergenceBadge({ convergence }: { convergence: ConvergenceRow | null }) {
  const count = convergence?.source_count ?? 0
  const score = convergence?.convergence_score ?? 0
  const tone =
    count >= 4
      ? 'bg-green-100 text-green-800 border-green-200'
      : count >= 2
      ? 'bg-amber-100 text-amber-800 border-amber-200'
      : 'bg-gray-100 text-gray-600 border-gray-200'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-mono ${tone}`}>
      <span className="font-semibold">합치 {score}</span>
      <span className="text-[10px] opacity-80">{count}/8 채널</span>
    </span>
  )
}

function Sparkline({ rows }: { rows: ConvergenceDailyRow[] }) {
  // 14일 격자 만들기 (없는 날은 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days: { day: string; count: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000)
    const key = d.toISOString().slice(0, 10)
    const hit = rows.find((r) => r.day?.slice(0, 10) === key)
    days.push({ day: key, count: hit?.source_count ?? 0 })
  }
  const max = Math.max(1, ...days.map((d) => d.count))
  const width = 14 * 8
  const height = 24
  return (
    <span
      className="inline-flex items-end gap-[1px] h-6"
      title={`최근 14일 합치 추이 (max ${max})`}
      style={{ width }}
    >
      {days.map((d, i) => {
        const h = Math.max(2, Math.round((d.count / max) * height))
        const color = d.count >= 4 ? '#15803d' : d.count >= 2 ? '#b45309' : '#9ca3af'
        return (
          <span
            key={i}
            style={{ width: 6, height: h, background: color, display: 'inline-block', borderRadius: 1 }}
          />
        )
      })}
    </span>
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
