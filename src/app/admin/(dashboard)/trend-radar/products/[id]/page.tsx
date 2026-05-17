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

interface KmLookupRow {
  category_top: string
  category_mid: string | null
  entered_at: string
  current_age_weeks: number
  median_remaining_weeks: number | null
  survival_now: number | null
  p_plus_1w: number | null
  p_plus_2w: number | null
  p_plus_4w: number | null
  p_plus_8w: number | null
  recommended_take_profit_week: number | null
  recommended_stop_loss_week: number | null
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, kmRes] = await Promise.all([
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
    sb.rpc('jimscanner_product_km_lookup' as never, { p_product_id: id } as never),
  ])

  if (prodRes.error || !prodRes.data) return null

  const kmRows = ((kmRes.data ?? []) as unknown) as KmLookupRow[]

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    km: kmRows[0] ?? null,
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
  const { product, aliases, scoreHistory, km } = data
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

      {/* Kaplan-Meier 기반 익절·손절 권장 */}
      {km && (
        <section className="rounded border border-gray-200 p-4 bg-blue-50/30">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-700">
              📈 동일 카테고리 KM 기반 익절·손절 권장
            </h2>
            <Link
              href="/admin/trend-radar/survival"
              className="text-xs text-gray-500 hover:text-black underline"
            >
              카테고리 KM 보드 →
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
            <KmStat
              label="현재 진입 후"
              value={`${km.current_age_weeks}주차`}
              hint={km.entered_at?.slice(0, 10) ?? ''}
            />
            <KmStat
              label="카테고리 median"
              value={km.median_remaining_weeks !== null ? `${km.median_remaining_weeks}w` : '—'}
              hint={`${km.category_top}${km.category_mid ? ' / ' + km.category_mid : ''}`}
            />
            <KmStat
              label="현재 잔존 S(t)"
              value={
                km.survival_now !== null
                  ? `${(Number(km.survival_now) * 100).toFixed(0)}%`
                  : '—'
              }
              hint="진입 시점 대비"
            />
            <KmStat
              label="조건부 +4w 생존"
              value={
                km.p_plus_4w !== null
                  ? `${(Number(km.p_plus_4w) * 100).toFixed(0)}%`
                  : '—'
              }
              hint="익절 판단 기준"
              tone={
                km.p_plus_4w === null
                  ? 'neutral'
                  : Number(km.p_plus_4w) >= 0.5
                  ? 'good'
                  : Number(km.p_plus_4w) >= 0.25
                  ? 'warn'
                  : 'bad'
              }
            />
            <KmStat
              label="익절 권장 (+w)"
              value={
                km.recommended_take_profit_week !== null
                  ? `+${km.recommended_take_profit_week}w`
                  : '—'
              }
              hint="S(t)/S(now) ≤ 0.5"
              tone="warn"
            />
            <KmStat
              label="손절 권장 (+w)"
              value={
                km.recommended_stop_loss_week !== null
                  ? `+${km.recommended_stop_loss_week}w`
                  : '—'
              }
              hint="S(t)/S(now) ≤ 0.25"
              tone="bad"
            />
          </div>
          {km.p_plus_1w !== null && (
            <div className="mt-3 text-xs text-gray-600 flex gap-4 flex-wrap">
              <span>
                +1w: <span className="font-mono">{(Number(km.p_plus_1w) * 100).toFixed(0)}%</span>
              </span>
              {km.p_plus_2w !== null && (
                <span>
                  +2w:{' '}
                  <span className="font-mono">{(Number(km.p_plus_2w) * 100).toFixed(0)}%</span>
                </span>
              )}
              {km.p_plus_8w !== null && (
                <span>
                  +8w:{' '}
                  <span className="font-mono">{(Number(km.p_plus_8w) * 100).toFixed(0)}%</span>
                </span>
              )}
            </div>
          )}
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

function KmStat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-green-700'
      : tone === 'warn'
      ? 'text-amber-700'
      : tone === 'bad'
      ? 'text-red-700'
      : 'text-gray-900'
  return (
    <div className="rounded border border-gray-200 bg-white p-2.5">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${toneClass}`}>{value}</div>
      {hint && <div className="text-[10px] text-gray-400 mt-0.5 truncate">{hint}</div>}
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
