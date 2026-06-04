import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  computeMarginWaterfall,
  formatKRW,
  type MarginWaterfall,
} from '@/lib/coupang/margin-waterfall'

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
    product: prodRes.data as ProductRow,
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
  const waterfall = deriveWaterfall(latest?.score_components)

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

      {/* 순마진 워터폴 */}
      {waterfall && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            💰 순마진 워터폴 — 카테고리별 쿠팡 수수료 반영 실수령
          </h2>
          <div className="rounded border border-gray-200 p-4">
            <WaterfallChart w={waterfall} />
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
 * score_components.margin_waterfall (스코어 단계에서 기록) → MarginWaterfall.
 * 완성된 워터폴이 들어있으면 그대로 쓰고, 입력만 있으면(cost/price/cate_cd) 재계산한다.
 */
function deriveWaterfall(scoreComponents: any): MarginWaterfall | null {
  const mw = scoreComponents?.margin_waterfall
  if (!mw) return null
  if (typeof mw.netMargin === 'number' && typeof mw.salePrice === 'number') {
    return mw as MarginWaterfall
  }
  const cost = mw.cost ?? mw.dome_price_krw ?? mw.price_krw
  if (typeof cost !== 'number' || cost <= 0) return null
  return computeMarginWaterfall({
    cost,
    cateCd: mw.cate_cd ?? mw.category_code ?? null,
    salePrice: mw.salePrice ?? mw.sale_price ?? null,
    feeRate: mw.feeRate ?? mw.fee_rate,
  })
}

/** 판매가 → 수수료 → 배송 → 부가세 → 원가 → 순마진 SVG 워터폴 차트. */
function WaterfallChart({ w }: { w: MarginWaterfall }) {
  const steps = [
    { label: '예상판매가', delta: w.salePrice, kind: 'total' as const },
    { label: `수수료 ${(w.feeRate * 100).toFixed(1)}%`, delta: -w.fee, kind: 'sub' as const },
    { label: '배송', delta: -w.ship, kind: 'sub' as const },
    { label: '부가세', delta: -w.vat, kind: 'sub' as const },
    { label: '원가', delta: -w.cost, kind: 'sub' as const },
    { label: '순마진', delta: w.netMargin, kind: 'net' as const },
  ]

  const W = 680
  const H = 240
  const padL = 8
  const padR = 8
  const padTop = 16
  const padBottom = 44
  const n = steps.length
  const gap = 14
  const barW = (W - padL - padR - gap * (n - 1)) / n
  const plotH = H - padTop - padBottom
  const max = Math.max(w.salePrice, 1)
  const y = (v: number) => padTop + plotH - (v / max) * plotH

  // 누적 위치 계산 (워터폴)
  let running = 0
  const bars = steps.map((s, i) => {
    let top: number
    let bottom: number
    let color: string
    if (s.kind === 'total') {
      top = y(s.delta)
      bottom = y(0)
      running = s.delta
      color = '#0f766e' // teal-700
    } else if (s.kind === 'net') {
      top = y(Math.max(s.delta, 0))
      bottom = y(Math.min(s.delta, 0) >= 0 ? 0 : 0)
      // 순마진 막대는 0~delta
      const lo = Math.min(0, s.delta)
      const hi = Math.max(0, s.delta)
      top = y(hi)
      bottom = y(lo)
      color = s.delta >= 0 ? '#059669' : '#e11d48' // emerald-600 / rose-600
    } else {
      const before = running
      running = running + s.delta // delta 음수
      top = y(before)
      bottom = y(running)
      color = '#f43f5e' // rose-500 (차감)
    }
    const x = padL + i * (barW + gap)
    return { x, top, bottom, color, ...s }
  })

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="순마진 워터폴">
        {/* 0 기준선 */}
        <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} stroke="#e5e7eb" strokeWidth={1} />
        {bars.map((b, i) => {
          const h = Math.max(2, Math.abs(b.bottom - b.top))
          const yTop = Math.min(b.top, b.bottom)
          return (
            <g key={i}>
              <rect x={b.x} y={yTop} width={barW} height={h} fill={b.color} rx={2} />
              {/* 값 라벨 */}
              <text
                x={b.x + barW / 2}
                y={yTop - 4}
                textAnchor="middle"
                fontSize={11}
                fontFamily="monospace"
                fill={b.delta < 0 ? '#e11d48' : '#111827'}
              >
                {b.delta < 0 ? '−' : ''}
                {Math.abs(Math.round(b.delta)).toLocaleString()}
              </text>
              {/* 단계 라벨 */}
              <text
                x={b.x + barW / 2}
                y={H - padBottom + 16}
                textAnchor="middle"
                fontSize={10}
                fill="#6b7280"
              >
                {b.label}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-semibold">
          순마진{' '}
          <span className={w.netMargin >= 0 ? 'text-emerald-700' : 'text-rose-600'}>
            {w.netMargin >= 0 ? '+' : ''}
            {formatKRW(w.netMargin)}
          </span>
        </span>
        <span className="text-gray-500">
          마진율{' '}
          <span className={w.marginPct >= 0 ? 'text-emerald-600' : 'text-rose-500'}>{w.marginPct}%</span>
        </span>
        {w.killedByFee && (
          <span className="text-rose-600 font-semibold">💀 수수료·배송만으로 적자 — 등록 부적합</span>
        )}
        <span className="text-gray-400 font-mono">
          판매 {formatKRW(w.salePrice)} · 원가 {formatKRW(w.cost)}
        </span>
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
