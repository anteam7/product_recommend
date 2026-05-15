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
  purchase_intent_score: number | null
  score_components: any
  computed_at: string
}

interface IntentSignalRow {
  intent_class: string
  co_keyword: string
  volume: number | null
  source: string
  collected_at?: string
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, intentRes] = await Promise.all([
    sb.from('jimscanner_trends_products').select('*').eq('id', id).single(),
    sb
      .from('jimscanner_trends_aliases')
      .select('alias, alias_type, source, confidence, classified_by, created_at')
      .eq('product_id', id)
      .order('confidence', { ascending: false }),
    (sb as any)
      .from('jimscanner_trends_scores')
      .select('trend_score, commerce_score, supplier_score, competition_score, final_score, purchase_intent_score, score_components, computed_at')
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(30),
    (sb as any)
      .from('jimscanner_trends_intent_latest')
      .select('intent_class, co_keyword, volume, source, collected_at')
      .eq('product_id', id)
      .limit(500),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    intentSignals: ((intentRes as any)?.data ?? []) as IntentSignalRow[],
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
  const { product, aliases, scoreHistory, intentSignals } = data
  const latest = scoreHistory[0]

  // 의도 분포 집계
  const intentDist: Record<string, number> = {
    informational: 0,
    comparison: 0,
    review: 0,
    transactional: 0,
    unknown: 0,
  }
  for (const s of intentSignals) {
    const v = Number(s.volume ?? 0)
    intentDist[s.intent_class] = (intentDist[s.intent_class] ?? 0) + v
  }
  const intentTotal = Object.values(intentDist).reduce((a, b) => a + b, 0)

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

      {/* 4점수 카드 + purchase intent */}
      {latest && (
        <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <ScoreCard label="final" value={latest.final_score} bold />
          <ScoreCard label="trend" value={latest.trend_score} />
          <ScoreCard label="commerce" value={latest.commerce_score} />
          <ScoreCard label="supplier" value={latest.supplier_score} />
          <ScoreCard label="competition" value={latest.competition_score} />
          <ScoreCard
            label="purchase intent"
            value={typeof latest.purchase_intent_score === 'number' ? latest.purchase_intent_score : 0}
          />
        </section>
      )}

      {/* 검색의도 분포 + 워드클라우드 */}
      {intentSignals.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">검색의도 분포 (suffix {intentSignals.length}개)</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <IntentDonut dist={intentDist} total={intentTotal} />
            <div className="md:col-span-2">
              <IntentWordCloud signals={intentSignals} />
            </div>
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

const INTENT_COLOR_HEX: Record<string, string> = {
  informational: '#3b82f6',
  comparison: '#f59e0b',
  review: '#a855f7',
  transactional: '#10b981',
  unknown: '#d1d5db',
}

const INTENT_LABEL_KR: Record<string, string> = {
  informational: '정보',
  comparison: '비교',
  review: '후기',
  transactional: '거래',
  unknown: '미분류',
}

function IntentDonut({ dist, total }: { dist: Record<string, number>; total: number }) {
  if (total === 0) return <div className="text-xs text-gray-400">데이터 없음</div>
  const order = ['informational', 'comparison', 'review', 'transactional', 'unknown']
  const size = 160
  const cx = size / 2
  const cy = size / 2
  const r = 60
  const stroke = 24

  let acc = 0
  const arcs: Array<{ cls: string; pct: number; offset: number }> = []
  for (const cls of order) {
    const v = dist[cls] ?? 0
    if (v <= 0) continue
    const pct = v / total
    arcs.push({ cls, pct, offset: acc })
    acc += pct
  }

  const circumference = 2 * Math.PI * r

  return (
    <div className="rounded border border-gray-200 p-4 flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f3f4f6" strokeWidth={stroke} />
        {arcs.map((a) => (
          <circle
            key={a.cls}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={INTENT_COLOR_HEX[a.cls] ?? '#9ca3af'}
            strokeWidth={stroke}
            strokeDasharray={`${a.pct * circumference} ${circumference}`}
            strokeDashoffset={-a.offset * circumference}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        ))}
      </svg>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs w-full">
        {order.map((cls) => {
          const v = dist[cls] ?? 0
          if (v === 0) return null
          const pct = total > 0 ? Math.round((v / total) * 100) : 0
          return (
            <div key={cls} className="flex items-center justify-between">
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm"
                  style={{ backgroundColor: INTENT_COLOR_HEX[cls] }}
                />
                {INTENT_LABEL_KR[cls]}
              </span>
              <span className="font-mono text-gray-600">{pct}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function IntentWordCloud({ signals }: { signals: IntentSignalRow[] }) {
  const maxVol = signals.reduce((m, s) => Math.max(m, Number(s.volume ?? 0)), 1)
  const sorted = [...signals]
    .sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
    .slice(0, 60)
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500 mb-2">의도별 키워드 (volume 가중)</div>
      <div className="flex flex-wrap gap-2 items-baseline">
        {sorted.map((s, i) => {
          const v = Number(s.volume ?? 0)
          const ratio = v / maxVol
          const sizePx = 11 + Math.round(ratio * 11)
          const color = INTENT_COLOR_HEX[s.intent_class] ?? '#9ca3af'
          return (
            <span
              key={i}
              style={{ fontSize: `${sizePx}px`, color }}
              title={`${INTENT_LABEL_KR[s.intent_class] ?? s.intent_class} · vol ${v}`}
              className="font-medium leading-none"
            >
              {s.co_keyword}
            </span>
          )
        })}
        {sorted.length === 0 && <span className="text-xs text-gray-400">키워드 없음</span>}
      </div>
    </div>
  )
}
