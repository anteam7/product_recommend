import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

interface ElasticityRow {
  product_id: string
  epsilon: number | null
  std_err: number | null
  r2: number | null
  sample_n: number
  price_min: number | null
  price_max: number | null
  computed_at: string
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
}

type Band = 'elastic' | 'mid' | 'inelastic' | 'unknown'

function band(eps: number | null): Band {
  if (eps === null || !Number.isFinite(eps)) return 'unknown'
  if (eps < -1) return 'elastic'
  if (eps <= -0.3) return 'mid'
  return 'inelastic'
}

const BAND_META: Record<Band, { label: string; cls: string; hint: string }> = {
  elastic: { label: 'ε<-1 가격민감', cls: 'bg-red-100 text-red-700', hint: '가격↓ → 수요↑↑ — 프로모션·할인 효과 큼' },
  mid: { label: '-1≤ε≤-0.3 중간', cls: 'bg-amber-100 text-amber-700', hint: '가격 변동에 비례적 반응' },
  inelastic: { label: 'ε>-0.3 무감', cls: 'bg-emerald-100 text-emerald-700', hint: '가격 변경 영향 작음 — 마진 확대 우선' },
  unknown: { label: 'N/A', cls: 'bg-gray-100 text-gray-600', hint: '표본 부족' },
}

async function fetchData(category: Category) {
  const sb = createAdminClient()

  // RPC 산출물 — 타입 미반영이라 `as any` 캐스팅
  const { data: elasticityData } = await (sb as any)
    .from('jimscanner_trends_elasticity')
    .select('product_id, epsilon, std_err, r2, sample_n, price_min, price_max, computed_at')
    .order('sample_n', { ascending: false })
    .limit(500)

  const rows = (elasticityData ?? []) as ElasticityRow[]
  if (rows.length === 0) {
    return { rows: [] as Array<ElasticityRow & { product: ProductRow }>, categoryBands: {} }
  }

  const pq = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand')
    .in('id', rows.map((r) => r.product_id))

  if (category !== 'all') pq.eq('category_top', category)

  const { data: prods } = await pq
  const prodMap = new Map<string, ProductRow>(
    ((prods ?? []) as ProductRow[]).map((p) => [p.id, p]),
  )

  const enriched = rows
    .map((r) => ({ ...r, product: prodMap.get(r.product_id)! }))
    .filter((r) => r.product)

  // 카테고리별 band 분포 (전체 카테고리 기준 — 탭 미적용)
  const allRowsForBands = rows
    .map((r) => ({ r, p: prodMap.get(r.product_id) }))
    .filter((x) => x.p)

  const categoryBands: Record<string, Record<Band, number>> = {}
  for (const x of allRowsForBands) {
    const c = x.p!.category_top
    if (!categoryBands[c]) categoryBands[c] = { elastic: 0, mid: 0, inelastic: 0, unknown: 0 }
    categoryBands[c][band(x.r.epsilon)]++
  }

  return { rows: enriched, categoryBands }
}

export default async function ElasticityPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; band?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const bandFilter = (['elastic', 'mid', 'inelastic'].includes(sp.band ?? '') ? sp.band : null) as
    | Band
    | null

  const { rows, categoryBands } = await fetchData(category)

  const filtered = bandFilter ? rows.filter((r) => band(r.epsilon) === bandFilter) : rows

  // ε 분포 히스토그램 — bucket = 0.5
  const hist = new Map<number, number>()
  for (const r of rows) {
    if (r.epsilon === null || !Number.isFinite(r.epsilon)) continue
    const eps = Math.max(-4, Math.min(2, r.epsilon))
    const bucket = Math.floor(eps * 2) / 2
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1)
  }
  const histRows = [...hist.entries()].sort((a, b) => a[0] - b[0])
  const histMax = histRows.reduce((m, [, n]) => Math.max(m, n), 0)

  const totals: Record<Band, number> = { elastic: 0, mid: 0, inelastic: 0, unknown: 0 }
  for (const r of rows) totals[band(r.epsilon)]++

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">가격탄력성 ε 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            log-log 회귀 (ln Q = α + ε·ln P) — supplier 가격 시계열 × commerce_score 일별 매칭.
            일 1회 <code className="text-xs px-1 bg-gray-100 rounded">recompute_elasticity()</code> 재산출.
          </p>
        </div>
      </header>

      {/* 카테고리 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/elasticity?cat=${c}${bandFilter ? `&band=${bandFilter}` : ''}`}
            className={`px-3 py-2 text-sm ${
              category === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      {/* 3-band KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(['elastic', 'mid', 'inelastic', 'unknown'] as Band[]).map((b) => (
          <Link
            key={b}
            href={`/admin/trend-radar/elasticity?cat=${category}${b !== 'unknown' ? `&band=${b}` : ''}`}
            className={`rounded border p-3 ${
              bandFilter === b ? 'border-black bg-black text-white' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <div className={`text-xs ${bandFilter === b ? 'text-gray-300' : 'text-gray-500'}`}>
              {BAND_META[b].label}
            </div>
            <div className="text-2xl font-bold mt-1">{totals[b].toLocaleString()}</div>
            <div className={`text-[10px] mt-1 ${bandFilter === b ? 'text-gray-300' : 'text-gray-400'}`}>
              {BAND_META[b].hint}
            </div>
          </Link>
        ))}
      </section>

      {/* ε 히스토그램 */}
      {histRows.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">ε 분포 (bucket 0.5)</h2>
          <div className="rounded border border-gray-200 p-3 overflow-x-auto">
            <div className="flex items-end gap-1 h-32 min-w-[600px]">
              {histRows.map(([bucket, n]) => {
                const h = histMax > 0 ? (n / histMax) * 100 : 0
                const isElastic = bucket < -1
                const isMid = bucket >= -1 && bucket < -0.3
                const cls = isElastic ? 'bg-red-400' : isMid ? 'bg-amber-400' : 'bg-emerald-400'
                return (
                  <div key={bucket} className="flex-1 flex flex-col items-center gap-1 min-w-[24px]">
                    <div
                      className={`w-full ${cls} rounded-sm`}
                      style={{ height: `${h}%`, minHeight: n > 0 ? '4px' : '0' }}
                      title={`ε ≈ ${bucket.toFixed(1)} : ${n}건`}
                    />
                    <div className="text-[10px] text-gray-500 font-mono">{bucket.toFixed(1)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* 카테고리별 band 분포 */}
      {Object.keys(categoryBands).length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">카테고리별 band 분포</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">category</th>
                  <th className="px-3 py-2 text-right">ε&lt;-1</th>
                  <th className="px-3 py-2 text-right">-1≤ε≤-0.3</th>
                  <th className="px-3 py-2 text-right">ε&gt;-0.3</th>
                  <th className="px-3 py-2 text-right">N/A</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Object.entries(categoryBands).map(([cat, bands]) => (
                  <tr key={cat}>
                    <td className="px-3 py-1 font-medium">{cat}</td>
                    <td className="px-3 py-1 text-right text-red-700 font-mono">{bands.elastic}</td>
                    <td className="px-3 py-1 text-right text-amber-700 font-mono">{bands.mid}</td>
                    <td className="px-3 py-1 text-right text-emerald-700 font-mono">{bands.inelastic}</td>
                    <td className="px-3 py-1 text-right text-gray-500 font-mono">{bands.unknown}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 상품별 ε 리스트 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          상품별 ε ({filtered.length}건{bandFilter ? ` · band=${BAND_META[bandFilter].label}` : ''})
        </h2>
        {filtered.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">아직 추정된 ε 가 없습니다</p>
            <p className="text-sm mt-2">
              일 1회 <code className="text-xs px-1 bg-gray-100 rounded">/api/cron/recompute-elasticity</code> 가
              supplier × score 시계열을 매칭해 ε 을 산출합니다.
              <br />
              product 당 (P, Q) pair ≥ 3건이 누적되어야 회귀가 돌아갑니다.
            </p>
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">상품</th>
                  <th className="px-3 py-2 text-left">category</th>
                  <th className="px-3 py-2 text-right">ε</th>
                  <th className="px-3 py-2 text-right">SE</th>
                  <th className="px-3 py-2 text-right">R²</th>
                  <th className="px-3 py-2 text-right">n</th>
                  <th className="px-3 py-2 text-right">P 범위 (KRW)</th>
                  <th className="px-3 py-2 text-left">band</th>
                  <th className="px-3 py-2 text-left">시뮬레이션</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.slice(0, 200).map((r) => {
                  const b = band(r.epsilon)
                  return (
                    <tr key={r.product_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="font-medium text-black hover:underline"
                        >
                          {r.product.canonical_name}
                        </Link>
                        {r.product.brand && (
                          <span className="ml-2 text-xs text-gray-500">{r.product.brand}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{r.product.category_top}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">
                        {r.epsilon === null ? '—' : r.epsilon.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500 text-xs">
                        {r.std_err === null ? '—' : r.std_err.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500 text-xs">
                        {r.r2 === null ? '—' : r.r2.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600 text-xs">{r.sample_n}</td>
                      <td className="px-3 py-2 text-right text-xs text-gray-500 font-mono">
                        {r.price_min ? Math.round(r.price_min).toLocaleString() : '—'}–
                        {r.price_max ? Math.round(r.price_max).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${BAND_META[b].cls}`}>
                          {BAND_META[b].label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <SimulationHint
                          epsilon={r.epsilon}
                          priceMin={r.price_min}
                          priceMax={r.price_max}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500">
        <p>
          *ε &lt; -1 (가격민감): 1% 가격↓ → 1% 초과 수요↑. 추천판매가는 supplier P 의 하단 + 마진 최저 30%.
          할인폭 ≤ 30%, MOQ 협상 마진 큼.
        </p>
        <p>
          *-1 ≤ ε ≤ -0.3 (중간): 가격 변동에 비례적 반응. 추천판매가 = 표본 중앙값 × 1.4, 할인폭 10–20%.
        </p>
        <p>
          *ε &gt; -0.3 (무감): 가격 변경 영향 작음. 추천판매가는 supplier P 상단 × 1.6, 마진 확대 우선.
        </p>
      </section>
    </div>
  )
}

function SimulationHint({
  epsilon,
  priceMin,
  priceMax,
}: {
  epsilon: number | null
  priceMin: number | null
  priceMax: number | null
}) {
  if (epsilon === null || !Number.isFinite(epsilon) || !priceMin || !priceMax) {
    return <span className="text-gray-400">—</span>
  }
  const b = band(epsilon)
  const median = (priceMin + priceMax) / 2
  let recommended: number
  let discount: string
  let moq: string
  if (b === 'elastic') {
    recommended = priceMin * 1.3
    discount = '≤30%'
    moq = '협상 마진 大'
  } else if (b === 'mid') {
    recommended = median * 1.4
    discount = '10–20%'
    moq = '표준'
  } else {
    recommended = priceMax * 1.6
    discount = '≤5%'
    moq = '마진 확대'
  }
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-gray-700">
        판매가 ≈ {Math.round(recommended).toLocaleString()}
      </div>
      <div className="text-gray-500">할인 {discount} · MOQ {moq}</div>
    </div>
  )
}
