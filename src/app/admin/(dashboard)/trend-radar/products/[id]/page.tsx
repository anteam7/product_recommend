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
  // 버즈 감성극성 게이트 (supabase/buzz_sentiment_gate.sql)
  polarity_score: number | null
  buzz_positive_ratio: number | null
  risk_flag: string | null
  buzz_sentiment: { reason?: string | null } | null
  buzz_sentiment_at: string | null
}

const RISK_LABELS: Record<string, string> = {
  recall: '리콜·회수',
  safety: '부작용·안전',
  fraud: '사기·과장광고',
  quality: '품질불량',
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

  return {
    // buzz_* 컬럼은 generated 타입 미반영 — gen:types 시 unknown 캐스팅 제거
    product: prodRes.data as unknown as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
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
  const { product, aliases, scoreHistory } = data
  const latest = scoreHistory[0]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1 flex items-center gap-2 flex-wrap">
            {product.canonical_name}
            {product.risk_flag && (
              <span className="text-xs px-2 py-1 rounded bg-red-600 text-white font-bold align-middle">
                ⚠ 부정버즈 · {RISK_LABELS[product.risk_flag] ?? product.risk_flag}
              </span>
            )}
          </h1>
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

      {/* 버즈 감성극성 게이트 */}
      <BuzzGate product={product} />

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

function BuzzGate({ product }: { product: ProductRow }) {
  const hasData =
    product.polarity_score != null ||
    product.buzz_positive_ratio != null ||
    product.risk_flag != null
  if (!hasData) {
    return (
      <section className="rounded border border-dashed border-gray-300 px-4 py-3 text-xs text-gray-400">
        🫧 버즈 감성극성 미분석 — LLM 분류 크론(classify-trends-llm) 적재 대기 중.
      </section>
    )
  }

  const polarity = product.polarity_score ?? 0
  // positive_ratio 가 없으면 polarity(-1~1)를 0~1 로 환산해 대체
  const posRatio =
    product.buzz_positive_ratio != null
      ? product.buzz_positive_ratio
      : (polarity + 1) / 2
  const pct = Math.round(posRatio * 100)
  const demoted = product.risk_flag != null || polarity < -0.2
  const reason = product.buzz_sentiment?.reason

  const barColor =
    pct >= 60 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500'
  const tone = demoted
    ? 'border-red-300 bg-red-50'
    : pct >= 60
      ? 'border-emerald-200 bg-emerald-50/40'
      : 'border-gray-200'

  return (
    <section className={`rounded border px-4 py-4 space-y-3 ${tone}`}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          🫧 버즈 감성극성 게이트
          {demoted && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white font-bold">
              소싱 후보 강등
            </span>
          )}
        </h2>
        <span className="text-xs font-mono text-gray-500">
          polarity {polarity > 0 ? '+' : ''}
          {polarity.toFixed(2)}
        </span>
      </div>

      {/* 긍정버즈 비율 게이지 */}
      <div>
        <div className="flex justify-between text-xs text-gray-600 mb-1">
          <span>긍정버즈 비율</span>
          <span className="font-mono font-semibold">{pct}%</span>
        </div>
        <div className="h-3 w-full rounded-full bg-gray-200 overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {product.risk_flag && (
        <div className="text-xs text-red-800 font-medium">
          ⚠ 위험 신호: {RISK_LABELS[product.risk_flag] ?? product.risk_flag} — 위탁 소싱 시
          계정정지·반품 리스크. 원문 evidence 확인 후 진행.
        </div>
      )}
      {!product.risk_flag && demoted && (
        <div className="text-xs text-red-700">
          부정 발화 우세(polarity {polarity.toFixed(2)}) — 소싱 후보에서 강등됨.
        </div>
      )}
      {reason && (
        <div className="text-xs text-gray-500">
          판단 근거: <span className="text-gray-700">{reason}</span>
          {product.buzz_sentiment_at && (
            <span className="ml-2 font-mono text-gray-400">
              {product.buzz_sentiment_at.slice(0, 19).replace('T', ' ')}
            </span>
          )}
        </div>
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
