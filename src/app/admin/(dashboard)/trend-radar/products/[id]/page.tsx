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
interface BriefRow {
  verdict: 'go' | 'watch' | 'pass'
  confidence: number
  top_reasons: string[]
  biggest_blocker: string | null
  recommended_action: string | null
  suggested_price_band: string | null
  model: string | null
  generated_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, briefRes] = await Promise.all([
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
    // brief 테이블은 마이그레이션(supabase/trends_briefs.sql) 후 — 미적용 시 error 무시.
    (sb as any)
      .from('jimscanner_trends_briefs')
      .select(
        'verdict, confidence, top_reasons, biggest_blocker, recommended_action, suggested_price_band, model, generated_at',
      )
      .eq('product_id', id)
      .order('generated_at', { ascending: false })
      .limit(1),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    brief: ((briefRes as any)?.data?.[0] ?? null) as BriefRow | null,
  }
}

const VERDICT_STYLE: Record<BriefRow['verdict'], { label: string; badge: string; emoji: string }> = {
  go: { label: 'GO', badge: 'bg-emerald-100 text-emerald-700 border-emerald-300', emoji: '🟢' },
  watch: { label: 'WATCH', badge: 'bg-amber-100 text-amber-700 border-amber-300', emoji: '🟡' },
  pass: { label: 'PASS', badge: 'bg-rose-100 text-rose-700 border-rose-300', emoji: '🔴' },
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, brief } = data
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

      {/* Go/No-Go 의사결정 브리프 */}
      {brief && <BriefCard brief={brief} />}

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

function BriefCard({ brief }: { brief: BriefRow }) {
  const v = VERDICT_STYLE[brief.verdict] ?? VERDICT_STYLE.watch
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-bold px-3 py-1 rounded-full border ${v.badge}`}>
            {v.emoji} {v.label}
          </span>
          <span className="text-xs text-gray-500">
            확신도 {(brief.confidence * 100).toFixed(0)}%
          </span>
          {brief.suggested_price_band && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
              권장가 {brief.suggested_price_band}
            </span>
          )}
        </div>
        <span className="text-[10px] text-gray-400 font-mono">
          브리프 {brief.generated_at.slice(0, 16).replace('T', ' ')}
          {brief.model ? ` · ${brief.model}` : ''}
        </span>
      </div>

      {brief.top_reasons.length > 0 && (
        <ul className="space-y-1 mb-3">
          {brief.top_reasons.map((r, i) => (
            <li key={i} className="text-sm text-gray-800 flex gap-2">
              <span className="text-gray-400">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid md:grid-cols-2 gap-3">
        {brief.biggest_blocker && (
          <div className="rounded border border-rose-100 bg-rose-50/50 p-3">
            <div className="text-[10px] uppercase text-rose-500 font-semibold mb-1">최대 블로커</div>
            <div className="text-sm text-gray-800">{brief.biggest_blocker}</div>
          </div>
        )}
        {brief.recommended_action && (
          <div className="rounded border border-emerald-100 bg-emerald-50/50 p-3">
            <div className="text-[10px] uppercase text-emerald-600 font-semibold mb-1">다음 액션</div>
            <div className="text-sm text-gray-800">{brief.recommended_action}</div>
          </div>
        )}
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
