import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  computeUnitEconomics,
  estimateSellPrice,
  gateColor,
  gateLabel,
  won,
  type UnitEconomics,
} from '@/lib/trend-radar/unit-economics'

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

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, supRes] = await Promise.all([
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
    sb
      .from('jimscanner_trends_supplier')
      .select('supplier_source, price_krw, raw_payload')
      .eq('product_id', id)
      .order('price_krw', { ascending: true }),
  ])

  if (prodRes.error || !prodRes.data) return null

  const scoreHistory = (scoreRes.data ?? []) as ScoreRow[]
  const suppliers = (supRes.data ?? []) as any[]
  const best = suppliers.find((s) => Number(s.price_krw) > 0)

  let econ: (UnitEconomics & { sellSource: 'observed' | 'heuristic' }) | null = null
  if (best) {
    const landed = Number(best.price_krw)
    const sell = estimateSellPrice({
      scoreComponents: scoreHistory[0]?.score_components,
      supplierRaw: best.raw_payload,
      landedCost: landed,
    })
    const u = sell ? computeUnitEconomics(sell.value, landed) : null
    if (u && sell) econ = { ...u, sellSource: sell.source }
  }

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory,
    econ,
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
  const { product, aliases, scoreHistory, econ } = data
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

      {/* 단위경제성 워터폴 */}
      {econ && <UnitEconomicsWaterfall econ={econ} />}

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

function UnitEconomicsWaterfall({
  econ,
}: {
  econ: UnitEconomics & { sellSource: 'observed' | 'heuristic' }
}) {
  const steps: { label: string; value: number; sign: '+' | '-' }[] = [
    { label: '추정 판매가', value: econ.estimatedSellPrice, sign: '+' },
    { label: '판매수수료 (10.6%)', value: -econ.fee, sign: '-' },
    { label: '부가세 (÷11)', value: -econ.vat, sign: '-' },
    { label: '출고 배송비', value: -econ.ship, sign: '-' },
    { label: '랜디드 원가', value: -econ.landedCost, sign: '-' },
  ]
  const max = econ.estimatedSellPrice || 1

  return (
    <section>
      <h2 className="text-sm font-semibold mb-2">
        단위경제성 워터폴{' '}
        <span className={`ml-1 text-xs font-medium ${gateColor(econ.gateStatus)}`}>
          · {gateLabel(econ.gateStatus)}
        </span>
        {econ.sellSource === 'heuristic' && (
          <span className="ml-1 text-[10px] font-normal text-amber-500" title="관찰 판매가 없음 — 랜디드원가 ×2.2 추정">
            (판매가 추정치)
          </span>
        )}
      </h2>
      <div className="rounded border border-gray-200 p-4 space-y-2">
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-3 text-sm">
            <div className="w-32 shrink-0 text-gray-600">{s.label}</div>
            <div className="flex-1">
              <div
                className={`h-4 rounded ${s.sign === '+' ? 'bg-gray-300' : 'bg-rose-200'}`}
                style={{ width: `${Math.min(100, (Math.abs(s.value) / max) * 100)}%` }}
              />
            </div>
            <div className={`w-28 shrink-0 text-right font-mono ${s.sign === '-' ? 'text-rose-600' : 'text-gray-700'}`}>
              {s.sign === '-' ? '−' : ''}
              {won(Math.abs(s.value))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-3 border-t border-gray-200 pt-2 text-sm">
          <div className="w-32 shrink-0 font-semibold">기대 순이익</div>
          <div className="flex-1">
            <div
              className={`h-5 rounded ${econ.expectedNetUnit >= 0 ? 'bg-emerald-300' : 'bg-rose-400'}`}
              style={{ width: `${Math.min(100, (Math.abs(econ.expectedNetUnit) / max) * 100)}%` }}
            />
          </div>
          <div className={`w-28 shrink-0 text-right font-mono font-bold ${gateColor(econ.gateStatus)}`}>
            {won(econ.expectedNetUnit)}
          </div>
        </div>
        <p className="pt-1 text-right text-xs text-gray-500">순마진 {econ.netMarginPct}%</p>
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
