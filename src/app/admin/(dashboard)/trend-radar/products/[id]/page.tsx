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
interface KeywordIndexRow {
  keyword: string
  source: string
  indexed_series: { date: string; index: number }[]
  raw_series: { date: string; ratio: number }[]
  velocity: number
  meta: any
  computed_at: string
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

  // 체인링크 보정 연속지수 — 상품 alias(=DataLab group title)로 매칭.
  // jimscanner_trends_keyword_index 는 마이그레이션 후 테이블이라 as any 캐스팅.
  const aliasNames = ((aliasRes.data ?? []) as AliasRow[]).map((a) => a.alias)
  let keywordIndex: KeywordIndexRow | null = null
  if (aliasNames.length > 0) {
    const idxRes = await (sb as any)
      .from('jimscanner_trends_keyword_index')
      .select('keyword, source, indexed_series, raw_series, velocity, meta, computed_at')
      .in('keyword', aliasNames)
      .order('computed_at', { ascending: false })
      .limit(1)
    keywordIndex = (idxRes.data?.[0] ?? null) as KeywordIndexRow | null
  }

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    keywordIndex,
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
  const { product, aliases, scoreHistory, keywordIndex } = data
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

      {/* 체인링크 보정: raw(윈도 재정규화) vs 보정 연속지수 오버레이 */}
      {keywordIndex && keywordIndex.indexed_series?.length > 1 && (
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold">
              수요지수 — raw vs 체인링크 보정{' '}
              <span className="text-xs font-normal text-gray-400">
                ({keywordIndex.keyword})
              </span>
            </h2>
            <div className="text-xs text-gray-500">
              보정 velocity{' '}
              <span className="font-bold text-black">{keywordIndex.velocity}</span>
              {typeof keywordIndex.meta?.correctionSpan === 'number' && (
                <span className="ml-2">
                  · 보정강도 {keywordIndex.meta.correctionSpan} (윈도{' '}
                  {keywordIndex.meta.windows})
                </span>
              )}
            </div>
          </div>
          <OverlaySparkline
            indexed={keywordIndex.indexed_series}
            raw={keywordIndex.raw_series}
          />
          <div className="mt-1 flex gap-4 text-[10px] text-gray-500">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-gray-300" /> raw (윈도 재정규화)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-0.5 bg-emerald-500" /> 보정 연속지수
            </span>
          </div>
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

/**
 * raw(윈도 재정규화) 와 보정 연속지수를 같은 날짜축/같은 스케일에 겹쳐 그리는 SVG 스파크라인.
 * 두 시계열을 각자 0~1 로 정규화해 모양(시간축 정합성)의 차이를 드러낸다.
 */
function OverlaySparkline({
  indexed,
  raw,
}: {
  indexed: { date: string; index: number }[]
  raw: { date: string; ratio: number }[]
}) {
  const W = 640
  const H = 120
  const pad = 4

  // 공통 날짜축: 두 시계열 날짜 합집합 오름차순
  const dates = Array.from(
    new Set([...indexed.map((p) => p.date), ...raw.map((p) => p.date)]),
  ).sort()
  if (dates.length < 2) return null
  const xOf = (d: string) =>
    pad + (dates.indexOf(d) / (dates.length - 1)) * (W - 2 * pad)

  const path = (
    pts: { date: string; v: number }[],
    color: string,
    width: number,
  ) => {
    if (pts.length < 2) return null
    const vals = pts.map((p) => p.v)
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min || 1
    const yOf = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad)
    const d = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.date).toFixed(1)} ${yOf(p.v).toFixed(1)}`)
      .join(' ')
    return <path d={d} fill="none" stroke={color} strokeWidth={width} />
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        {path(
          raw.map((p) => ({ date: p.date, v: p.ratio })),
          '#d1d5db',
          1.5,
        )}
        {path(
          indexed.map((p) => ({ date: p.date, v: p.index })),
          '#10b981',
          2,
        )}
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
