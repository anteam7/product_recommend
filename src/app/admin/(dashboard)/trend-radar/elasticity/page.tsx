import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ElasticityRow {
  product_id: string
  elasticity_coef: number | null
  competitor_coef: number | null
  r_squared: number | null
  sample_days: number
  price_band_p10: number | null
  price_band_p50: number | null
  price_band_p90: number | null
  optimal_entry_price: number | null
  decision_label: string | null
  confidence: string
  computed_at: string
}

interface ProductMin {
  id: string
  canonical_name: string
  category_top: string
}

async function fetchLatest() {
  const sb = createAdminClient()
  // 각 product 의 가장 최근 elasticity row 만 — 단순화를 위해 최근 1000건 받아 in-memory dedupe
  const { data: elRows, error } = await sb
    .from('jimscanner_trends_elasticity' as never)
    .select(
      'product_id, elasticity_coef, competitor_coef, r_squared, sample_days, price_band_p10, price_band_p50, price_band_p90, optimal_entry_price, decision_label, confidence, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(1000)

  if (error) {
    return { rows: [] as Array<ElasticityRow & ProductMin>, error: error.message }
  }

  // dedupe by product_id keep latest
  const seen = new Set<string>()
  const latest: ElasticityRow[] = []
  for (const r of (elRows ?? []) as unknown as ElasticityRow[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }

  if (latest.length === 0) {
    return { rows: [] as Array<ElasticityRow & ProductMin>, error: null as string | null }
  }

  const ids = latest.map((r) => r.product_id)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const prodMap = new Map<string, ProductMin>()
  for (const p of (prods ?? []) as ProductMin[]) prodMap.set(p.id, p)

  const rows = latest.map((r) => {
    const p = prodMap.get(r.product_id)
    return {
      ...r,
      id: p?.id ?? r.product_id,
      canonical_name: p?.canonical_name ?? '(unknown)',
      category_top: p?.category_top ?? '-',
    }
  })

  // β 절댓값 큰 순으로 정렬 (null 은 뒤)
  rows.sort((a, b) => {
    const aa = a.elasticity_coef == null ? -1 : Math.abs(a.elasticity_coef)
    const bb = b.elasticity_coef == null ? -1 : Math.abs(b.elasticity_coef)
    return bb - aa
  })

  return { rows, error: null as string | null }
}

function decisionBadge(label: string | null, confidence: string) {
  if (confidence === 'low') {
    return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">신뢰도↓</span>
  }
  if (label === 'price_sensitive') {
    return <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700">가격민감</span>
  }
  if (label === 'differentiable') {
    return <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">차별화 가능</span>
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">혼합</span>
}

function quadrant(beta: number | null, confidence: string) {
  if (confidence === 'low' || beta == null) return '—'
  const abs = Math.abs(beta)
  if (abs >= 1.5) return '🔥 고탄력'
  if (abs <= 0.5) return '💎 저탄력'
  return '➖ 중간'
}

export default async function ElasticityPage() {
  const { rows, error } = await fetchLatest()

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">가격 탄력성</h1>
        <p className="text-sm text-gray-500 mt-1">
          각 product 의 log(volume) ~ log(price) + log(competitor) 회귀 결과. β 절댓값이
          클수록 가격에 민감(저가공세 필수), 작을수록 차별화·프리미엄 포지셔닝 가능.
          <span className="ml-2 text-gray-400">
            (R² &lt; 0.3 또는 n &lt; 30 은 회색)
          </span>
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          조회 오류: {error}
        </div>
      )}

      {/* 4분면 매트릭스 (간이 도식) */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-3">의사결정 매트릭스</h2>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded bg-emerald-50 border border-emerald-200 p-3">
            <div className="font-semibold text-emerald-800">💎 저탄력 (β ≤ 0.5)</div>
            <div className="text-emerald-700 mt-1">차별화·프리미엄 — p90 진입가 권장</div>
          </div>
          <div className="rounded bg-red-50 border border-red-200 p-3">
            <div className="font-semibold text-red-800">🔥 고탄력 (β ≥ 1.5)</div>
            <div className="text-red-700 mt-1">가격민감 — p10 저가공세 필수</div>
          </div>
          <div className="rounded bg-amber-50 border border-amber-200 p-3 col-span-2">
            <div className="font-semibold text-amber-800">➖ 중간 (0.5 &lt; |β| &lt; 1.5)</div>
            <div className="text-amber-700 mt-1">시장 중위값(p50) 부근에서 마진 최적화</div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">제품별 β (절댓값 정렬, 총 {rows.length})</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">product</th>
                <th className="px-3 py-2 text-left">분류</th>
                <th className="px-3 py-2 text-right">β</th>
                <th className="px-3 py-2 text-right">R²</th>
                <th className="px-3 py-2 text-right">n</th>
                <th className="px-3 py-2 text-right">p10</th>
                <th className="px-3 py-2 text-right">p50</th>
                <th className="px-3 py-2 text-right">p90</th>
                <th className="px-3 py-2 text-right">권장 진입가</th>
                <th className="px-3 py-2 text-left">결정</th>
                <th className="px-3 py-2 text-left">4분면</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const dim = r.confidence === 'low' ? 'text-gray-400' : 'text-gray-800'
                return (
                  <tr key={r.product_id} className={dim}>
                    <td className="px-3 py-1">
                      <Link
                        href={`/admin/trend-radar/products/${r.product_id}`}
                        className="hover:underline"
                      >
                        {r.canonical_name}
                      </Link>
                    </td>
                    <td className="px-3 py-1 text-gray-500">{r.category_top}</td>
                    <td className="px-3 py-1 text-right font-mono">
                      {r.elasticity_coef?.toFixed(2) ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {r.r_squared?.toFixed(2) ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">{r.sample_days}</td>
                    <td className="px-3 py-1 text-right font-mono">
                      {r.price_band_p10?.toLocaleString() ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {r.price_band_p50?.toLocaleString() ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {r.price_band_p90?.toLocaleString() ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono font-semibold">
                      {r.optimal_entry_price?.toLocaleString() ?? '—'}
                    </td>
                    <td className="px-3 py-1">{decisionBadge(r.decision_label, r.confidence)}</td>
                    <td className="px-3 py-1">{quadrant(r.elasticity_coef, r.confidence)}</td>
                  </tr>
                )
              })}
              {rows.length === 0 && !error && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-gray-500">
                    아직 계산된 데이터 없음. <code>scripts/compute-price-elasticity.mjs</code>{' '}
                    실행 필요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
