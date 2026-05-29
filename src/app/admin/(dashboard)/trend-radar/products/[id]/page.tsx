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
interface TimelineRow {
  ts: string
  source: string
  kind: string
  label: string
  delta: number | null
  url: string | null
  meta: any
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, timelineRes] = await Promise.all([
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
    // 멀티소스 증거 타임라인 (RPC — alias 집합으로 raw 시그널 합류)
    (sb as any).rpc('jimscanner_product_timeline', {
      p_product_id: id,
      days_window: 90,
    }),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    timeline: (timelineRes.data ?? []) as TimelineRow[],
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
  const { product, aliases, scoreHistory, timeline } = data
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

      {/* 멀티소스 증거 타임라인 */}
      <EvidenceTimeline rows={timeline} />

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

// ── 증거 타임라인 ─────────────────────────────────────────────
const SOURCE_META: Record<string, { label: string; dot: string; chip: string; icon: string }> = {
  naver_search_trend: { label: '검색 트렌드', dot: 'bg-green-500', chip: 'bg-green-50 text-green-700', icon: '🔍' },
  naver_shopping_insight: { label: '쇼핑 인사이트', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700', icon: '🛒' },
  naver_tvtime: { label: 'TV 홈쇼핑', dot: 'bg-purple-500', chip: 'bg-purple-50 text-purple-700', icon: '📺' },
  naver_news: { label: '뉴스', dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-700', icon: '📰' },
  quasarzone_sale: { label: '핫딜', dot: 'bg-red-500', chip: 'bg-red-50 text-red-700', icon: '🔥' },
  ggsan: { label: 'ggsan 도매', dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700', icon: '📦' },
  scores: { label: 'score 변동', dot: 'bg-gray-800', chip: 'bg-gray-100 text-gray-800', icon: '🎯' },
}

function fmtTs(ts: string) {
  return ts?.slice(0, 16).replace('T', ' ') ?? ''
}

function VolumeSparkline({ points }: { points: { ts: string; v: number }[] }) {
  if (points.length < 2) return null
  const W = 320
  const H = 40
  const vals = points.map((p) => p.v)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const step = W / (points.length - 1)
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(H - ((p.v - min) / span) * (H - 6) - 3).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={W} height={H} className="overflow-visible">
      <path d={path} fill="none" stroke="#16a34a" strokeWidth={1.5} />
      {points.map((p, i) => (
        <circle key={i} cx={(i * step).toFixed(1)} cy={(H - ((p.v - min) / span) * (H - 6) - 3).toFixed(1)} r={1.6} fill="#16a34a" />
      ))}
    </svg>
  )
}

function EvidenceTimeline({ rows }: { rows: TimelineRow[] }) {
  // volume 시리즈 (검색·쇼핑) — 오름차순 스파크라인
  const volumePoints = rows
    .filter((r) => r.kind === 'volume' && r.delta != null)
    .map((r) => ({ ts: r.ts, v: Number(r.delta) }))
    .sort((a, b) => a.ts.localeCompare(b.ts))

  // 소스별 건수 (범례)
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.source] = (counts[r.source] ?? 0) + 1

  return (
    <section>
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-sm font-semibold">증거 타임라인 (최근 90일 · {rows.length}건)</h2>
        <div className="flex items-center gap-2 flex-wrap">
          {Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => {
              const m = SOURCE_META[src] ?? { label: src, chip: 'bg-gray-50 text-gray-600', dot: 'bg-gray-400', icon: '•' }
              return (
                <span key={src} className={`text-[11px] px-2 py-0.5 rounded-full ${m.chip}`}>
                  {m.icon} {m.label} {n}
                </span>
              )
            })}
        </div>
      </div>

      {volumePoints.length >= 2 && (
        <div className="rounded border border-gray-200 p-3 mb-3 flex items-center gap-4">
          <span className="text-xs text-gray-500 shrink-0">volume 추이 ({volumePoints.length}p)</span>
          <VolumeSparkline points={volumePoints} />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-gray-400 rounded border border-dashed border-gray-200 p-4 text-center">
          이 상품 alias 에 매칭된 raw 시그널이 최근 90일 내 없습니다.
        </p>
      ) : (
        <ol className="relative border-l border-gray-200 ml-2">
          {rows.map((r, i) => {
            const m = SOURCE_META[r.source] ?? { label: r.source, dot: 'bg-gray-400', chip: 'bg-gray-50 text-gray-600', icon: '•' }
            const delta = r.delta
            const deltaTxt =
              r.kind === 'score' && delta != null
                ? `${delta > 0 ? '▲' : delta < 0 ? '▼' : '='}${Math.abs(Number(delta))}`
                : r.kind === 'volume' && delta != null
                  ? `vol ${Number(delta)}`
                  : r.kind === 'ggsan_price' && delta != null
                    ? `${Number(delta).toLocaleString()}원`
                    : null
            return (
              <li key={i} className="ml-4 mb-3">
                <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${m.dot} ring-2 ring-white`} />
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded ${m.chip}`}>
                        {m.icon} {m.label}
                      </span>
                      {deltaTxt && (
                        <span
                          className={`text-[11px] font-mono ${
                            r.kind === 'score' && delta != null && Number(delta) > 0
                              ? 'text-green-600'
                              : r.kind === 'score' && delta != null && Number(delta) < 0
                                ? 'text-red-600'
                                : 'text-gray-500'
                          }`}
                        >
                          {deltaTxt}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-800 mt-0.5 break-words">
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="hover:underline text-blue-700">
                          {r.label}
                        </a>
                      ) : (
                        r.label
                      )}
                    </p>
                  </div>
                  <time className="text-[11px] text-gray-400 font-mono whitespace-nowrap shrink-0 mt-0.5">
                    {fmtTs(r.ts)}
                  </time>
                </div>
              </li>
            )
          })}
        </ol>
      )}
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
