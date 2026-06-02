import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeAlphaRanking, type AlphaRow, type CategoryIndex } from '@/lib/trend-radar/alpha'

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

  const product = prodRes.data as ProductRow

  // 카테고리 인덱스 대비 제품 궤적 분해 (고유알파)
  let alphaRow: AlphaRow | null = null
  let catIndex: CategoryIndex | null = null
  try {
    const { rows, categories } = await computeAlphaRanking(sb, {
      days: 14,
      category: product.category_top,
    })
    alphaRow = rows.find((r) => r.id === id) ?? null
    catIndex = categories[product.category_top] ?? null
  } catch {
    // 분해 실패해도 상세 페이지는 정상 노출
  }

  return {
    product,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    alphaRow,
    catIndex,
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
  const { product, aliases, scoreHistory, alphaRow, catIndex } = data
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

      {/* 카테고리 인덱스 대비 제품 궤적 (고유알파 분해) */}
      {alphaRow && catIndex && (
        <AlphaOverlay row={alphaRow} catIndex={catIndex} />
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
 * 카테고리 공통추세지수(베타) 대비 제품 trend_score 궤적을 SVG 라인으로 오버레이.
 * 두 선의 벌어짐 = 알파(잔차). 제 카테고리보다 빠르게/느리게 움직였는지 한눈에.
 */
function AlphaOverlay({ row, catIndex }: { row: AlphaRow; catIndex: CategoryIndex }) {
  const W = 640
  const H = 160
  const padX = 8
  const padY = 12
  const dates = row.series.map((p) => p.date)
  const prodVals = row.series.map((p) => p.score)
  const catByDate = new Map(catIndex.series.map((p) => [p.date, p.score]))
  const catVals = dates.map((d) => catByDate.get(d) ?? null)

  const nums = [...prodVals, ...catVals.filter((v): v is number => v != null)]
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const n = dates.length
  const x = (i: number) => padX + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * padX))
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - 2 * padY)

  const line = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ')

  return (
    <section>
      <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
        카테고리 인덱스 대비 궤적
        {row.label === 'alpha' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold">
            고유 상승
          </span>
        )}
        {row.label === 'beta' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
            베타 의존
          </span>
        )}
      </h2>
      <div className="rounded border border-gray-200 p-3">
        <div className="flex gap-4 text-xs mb-2">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-green-600" /> 이 제품 (총상승{' '}
            {row.totalDelta > 0 ? '+' : ''}
            {row.totalDelta})
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-amber-500" /> {row.category_top} 인덱스 (베타{' '}
            {row.beta > 0 ? '+' : ''}
            {row.beta})
          </span>
          <span
            className={`font-semibold ${
              row.alpha > 0 ? 'text-green-600' : row.alpha < 0 ? 'text-red-500' : 'text-gray-500'
            }`}
          >
            알파(잔차) {row.alpha > 0 ? '+' : ''}
            {row.alpha}
          </span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
          <path d={line(catVals)} fill="none" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 3" />
          <path d={line(prodVals)} fill="none" stroke="#16a34a" strokeWidth={2} />
          {prodVals.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill="#16a34a" />
          ))}
        </svg>
        <div className="flex justify-between text-[10px] text-gray-400 mt-1">
          <span>{dates[0]}</span>
          <span>{dates[dates.length - 1]}</span>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {row.alpha > 0.5
            ? '카테고리 평균을 초과해 단독으로 상승 중 — 1인 셀러가 노릴 엣지(알파) 후보.'
            : row.beta > 0.5 && row.alpha <= 0.5
              ? '상승의 대부분이 카테고리 동조(베타). 카테고리 전체가 뜬 레드오션일 수 있음.'
              : '뚜렷한 단독 상승 신호 없음.'}
        </p>
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
