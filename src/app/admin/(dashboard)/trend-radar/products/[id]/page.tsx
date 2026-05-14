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
interface MarketSignalRow {
  id: string
  signal_type: string
  keywords: string[]
  frequency: number
  first_seen: string
  last_seen: string
  raw_ids: string[]
}
interface MarketRawRow {
  id: string
  source: string
  title: string | null
  source_url: string | null
  captured_at: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, signalRes] = await Promise.all([
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
    // market_signals.product_id 는 link_market_signals.sql 마이그레이션에서 추가되는 컬럼.
    // 마이그레이션 미적용 환경 대비 any 캐스팅.
    (sb as any)
      .from('jimscanner_market_signals')
      .select('id, signal_type, keywords, frequency, first_seen, last_seen, raw_ids')
      .eq('product_id', id)
      .order('last_seen', { ascending: false })
      .limit(20),
  ])

  if (prodRes.error || !prodRes.data) return null

  const signals = (signalRes.data ?? []) as MarketSignalRow[]
  let recentRaws: MarketRawRow[] = []
  const rawIdSet = new Set<string>()
  for (const s of signals) {
    for (const rid of s.raw_ids ?? []) rawIdSet.add(rid)
  }
  if (rawIdSet.size > 0) {
    const ids = Array.from(rawIdSet).slice(0, 30)
    const rawRes = await sb
      .from('jimscanner_market_raw')
      .select('id, source, title, source_url, captured_at')
      .in('id', ids)
      .order('captured_at', { ascending: false })
    recentRaws = (rawRes.data ?? []) as MarketRawRow[]
  }

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    signals,
    recentRaws,
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
  const { product, aliases, scoreHistory, signals, recentRaws } = data
  const latest = scoreHistory[0]
  const rawById = new Map(recentRaws.map((r) => [r.id, r]))

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

      {/* 최근 뉴스 시그널 — market_raw 에서 키워드 매칭된 뉴스/검색 시그널 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          최근 뉴스 시그널 ({signals.length})
        </h2>
        {signals.length === 0 ? (
          <p className="text-xs text-gray-400">
            연결된 시장 시그널이 없습니다. (link-market-signals 배치 대기 중)
          </p>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {signals.map((s) => (
              <div key={s.id} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium">
                    {s.keywords?.[0] ?? '—'}
                    <span className="ml-2 text-xs text-gray-500">
                      {s.signal_type} · freq {s.frequency}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-400 font-mono">
                    {s.last_seen?.slice(0, 19).replace('T', ' ')}
                  </div>
                </div>
                {s.raw_ids?.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                    {s.raw_ids.slice(0, 3).map((rid) => {
                      const r = rawById.get(rid)
                      if (!r) return null
                      return (
                        <li key={rid} className="truncate">
                          <span className="text-gray-400 mr-1">[{r.source}]</span>
                          {r.source_url ? (
                            <a
                              href={r.source_url}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                            >
                              {r.title ?? r.source_url}
                            </a>
                          ) : (
                            <span>{r.title ?? '(제목 없음)'}</span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ))}
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
