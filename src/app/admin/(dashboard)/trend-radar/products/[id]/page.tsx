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

interface AliasShareRow {
  alias: string
  volume: number
  share: number
}
interface SpreadRow {
  product_id: string
  alias_n: number
  total_volume: number
  top1_alias: string | null
  top1_share: number
  top3_share: number
  effective_alias_count: number
  capture_uplift: number
  gini: number
}

async function fetchAliasShares(id: string, aliasList: string[]): Promise<AliasShareRow[]> {
  if (aliasList.length === 0) return []
  const sb = createAdminClient()
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative, collected_at')
    .in('keyword', aliasList)
    .gte('collected_at', since)
    .not('volume_relative', 'is', null)
    .order('collected_at', { ascending: false })
    .limit(5000)

  type Row = { keyword: string; volume_relative: number | null; collected_at: string }
  const seen = new Map<string, number>()
  for (const r of (data ?? []) as Row[]) {
    if (seen.has(r.keyword)) continue
    seen.set(r.keyword, Number(r.volume_relative ?? 0))
  }
  const volumes: AliasShareRow[] = aliasList.map((a) => ({
    alias: a,
    volume: seen.get(a) ?? 0,
    share: 0,
  }))
  const total = volumes.reduce((acc, v) => acc + v.volume, 0)
  if (total > 0) {
    for (const v of volumes) v.share = v.volume / total
  }
  volumes.sort((a, b) => b.volume - a.volume)
  return volumes
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, spreadRes] = await Promise.all([
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
    (sb as any)
      .from('jimscanner_alias_spread')
      .select('*')
      .eq('product_id', id)
      .maybeSingle(),
  ])

  if (prodRes.error || !prodRes.data) return null

  const aliases = (aliasRes.data ?? []) as AliasRow[]
  const aliasShares = await fetchAliasShares(id, aliases.map((a) => a.alias))
  const spread = (spreadRes?.data ?? null) as SpreadRow | null

  return {
    product: prodRes.data as ProductRow,
    aliases,
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    aliasShares,
    spread,
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
  const { product, aliases, scoreHistory, aliasShares, spread } = data
  const latest = scoreHistory[0]
  const topShares = aliasShares.slice(0, 8)
  const maxShare = topShares.length > 0 ? Math.max(...topShares.map((a) => a.share), 0.0001) : 0.0001

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

      {/* alias 분포 막대 */}
      {topShares.length > 0 && topShares.some((a) => a.volume > 0) && (
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold">Alias 검색량 분포 (최근 30일)</h2>
            <Link
              href="/admin/trend-radar/alias-spread"
              className="text-xs text-gray-500 hover:text-black underline"
            >
              alias 분산 보드 →
            </Link>
          </div>
          {spread && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 text-xs">
              <SpreadStat label="alias N" value={String(spread.alias_n)} />
              <SpreadStat label="top1 점유" value={`${(Number(spread.top1_share) * 100).toFixed(0)}%`} />
              <SpreadStat label="top3 점유" value={`${(Number(spread.top3_share) * 100).toFixed(0)}%`} />
              <SpreadStat label="effective alias" value={Number(spread.effective_alias_count).toFixed(2)} />
              <SpreadStat
                label="capture uplift"
                value={`${Number(spread.capture_uplift).toFixed(2)}×`}
                emphasize
              />
            </div>
          )}
          <div className="rounded border border-gray-200 p-3 space-y-1.5">
            {topShares.map((a) => {
              const widthPct = (a.share / maxShare) * 100
              return (
                <div key={a.alias} className="grid grid-cols-12 items-center text-xs gap-2">
                  <div className="col-span-4 truncate text-gray-700">{a.alias}</div>
                  <div className="col-span-6">
                    <div className="h-3 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-3 bg-indigo-500"
                        style={{ width: `${Math.max(2, widthPct)}%` }}
                      />
                    </div>
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {(a.share * 100).toFixed(1)}%
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-400">
                    {a.volume > 0 ? a.volume.toFixed(1) : '—'}
                  </div>
                </div>
              )
            })}
          </div>
          {spread && (
            <div className="text-xs text-gray-500 mt-2">
              {Number(spread.top1_share) >= 0.7
                ? '✅ top1 점유율이 높아 단일 표준 리스팅 1개로 검색량 대부분을 흡수할 수 있습니다.'
                : Number(spread.top1_share) < 0.4 && Number(spread.capture_uplift) >= 3
                ? '🔥 검색량이 alias 전반에 분산 — 동의어 통합 표준 리스팅을 만들면 top1 단독 대비 ' +
                  Number(spread.capture_uplift).toFixed(2) +
                  '× 검색량 흡수 가능.'
                : 'ℹ︎ 주력 + 보조 alias 1~2 개의 분산 리스팅 전략을 검토하세요.'}
            </div>
          )}
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

function SpreadStat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className={`rounded border px-2 py-1.5 ${emphasize ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200'}`}>
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`font-mono ${emphasize ? 'text-indigo-700 font-bold' : 'text-gray-700'}`}>
        {value}
      </div>
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
