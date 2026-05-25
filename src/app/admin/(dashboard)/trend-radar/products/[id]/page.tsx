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
interface CertRow {
  cert_type: string
  mandatory: boolean
  est_cost_krw: number | null
  est_lead_weeks: number | null
  rule_source: string | null
  rule_keyword: string | null
  confidence: number
}

const CERT_LABEL: Record<string, string> = {
  kc_safety: 'KC 안전',
  kc_emi: 'KC 전자파',
  kc_kids: 'KC 어린이',
  mfds_food: '식약처 식품',
  mfds_cosmetic: '책임판매업자',
  mfds_med: '의료기기',
  rra_radio: '전파인증',
  kats_efficiency: '에너지효율',
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, certRes] = await Promise.all([
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
      .from('jimscanner_trends_certifications')
      .select('cert_type, mandatory, est_cost_krw, est_lead_weeks, rule_source, rule_keyword, confidence')
      .eq('product_id', id)
      .order('mandatory', { ascending: false }),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    certs: ((certRes as any)?.data ?? []) as CertRow[],
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
  const { product, aliases, scoreHistory, certs } = data
  const latest = scoreHistory[0]
  const mandatoryCerts = certs.filter((c) => c.mandatory)
  const certCostTotal = mandatoryCerts.reduce((sum, c) => sum + (c.est_cost_krw ?? 0), 0)
  const certLeadMax = mandatoryCerts.reduce((m, c) => Math.max(m, c.est_lead_weeks ?? 0), 0)
  const entryClass =
    mandatoryCerts.length === 0
      ? 'clear'
      : certCostTotal < 2_000_000 && certLeadMax < 6
        ? 'low_cost'
        : 'high_cost'

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

      {/* 🚪 인허가 강제 게이트 */}
      <section
        className={`rounded border px-4 py-3 ${
          entryClass === 'clear'
            ? 'border-green-200 bg-green-50'
            : entryClass === 'low_cost'
              ? 'border-amber-300 bg-amber-50'
              : 'border-red-300 bg-red-50'
        }`}
      >
        <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
          <div className="text-sm font-semibold">
            {entryClass === 'clear'
              ? '🟢 진입가능 — 강제 인증 0건'
              : entryClass === 'low_cost'
                ? '🟡 진입제한 (저비용)'
                : '🔴 진입불가 (고비용·장기)'}
          </div>
          {mandatoryCerts.length > 0 && (
            <div className="text-xs text-gray-700">
              예상비용{' '}
              <span className="font-bold">{(certCostTotal / 10_000).toLocaleString()}만원</span>
              {' · '}
              lead <span className="font-bold">{certLeadMax}주</span>
            </div>
          )}
        </div>
        {certs.length === 0 ? (
          <div className="text-xs text-gray-600">
            룰북에서 강제 인증 키워드가 감지되지 않았습니다. 그러나 도매 진입 전 KATS·MFDS 가이드 직접 확인 권장.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {certs.map((c) => (
              <span
                key={c.cert_type}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                  c.mandatory
                    ? 'bg-red-100 text-red-800 border border-red-200'
                    : 'bg-gray-100 text-gray-700 border border-gray-200'
                }`}
                title={c.rule_keyword ? `매칭 키워드: ${c.rule_keyword}` : undefined}
              >
                <span className="font-semibold">{CERT_LABEL[c.cert_type] ?? c.cert_type}</span>
                {c.est_cost_krw != null && (
                  <span className="opacity-70">
                    · {Math.round(c.est_cost_krw / 10_000)}만 · {c.est_lead_weeks ?? '?'}주
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </section>

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
