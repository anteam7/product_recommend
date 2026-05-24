import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PinBundleButton from './PinBundleButton'

export const dynamic = 'force-dynamic'

interface BundleRow {
  id: string
  product_a_id: string
  product_b_id: string
  co_mention_count: number
  co_search_score: number
  complementarity_score: number
  expected_aov_lift: number | null
  combined_supplier_cost: number | null
  both_in_ggsan: boolean
  relation_type: string | null
  pinned: boolean
  pinned_notes: string | null
  last_seen_at: string
  listing_copy: { title?: string; bullet_points?: string[]; description?: string } | null
}

interface ProductLite {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
}

interface SupplierLite {
  product_id: string
  price_krw: number | null
  url_image: string | null
}

const SHIPPING_FLAT_KRW = 3000 // 단품 배송비 가정 (묶음 시 1회 분담 절감액)

async function fetchData(opts: {
  filter: 'all' | 'pinned' | 'ggsan' | 'complement'
  limit: number
}) {
  const sb = createAdminClient()

  // 신규 테이블 — supabase types 재생성 전이라 raw client 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSb = sb as any
  let q = rawSb
    .from('jimscanner_trends_bundle_candidates')
    .select(
      'id, product_a_id, product_b_id, co_mention_count, co_search_score, complementarity_score, expected_aov_lift, combined_supplier_cost, both_in_ggsan, relation_type, pinned, pinned_notes, last_seen_at, listing_copy',
    )

  if (opts.filter === 'pinned') q = q.eq('pinned', true)
  if (opts.filter === 'ggsan') q = q.eq('both_in_ggsan', true)
  if (opts.filter === 'complement') q = q.eq('relation_type', 'complement')

  q = q
    .order('complementarity_score', { ascending: false })
    .order('co_mention_count', { ascending: false })
    .limit(opts.limit)

  const { data } = (await q) as { data: BundleRow[] | null }
  const bundles = (data ?? []) as BundleRow[]

  if (bundles.length === 0) return { bundles, products: new Map<string, ProductLite>(), suppliers: new Map<string, SupplierLite>() }

  const productIds = Array.from(new Set(bundles.flatMap((b) => [b.product_a_id, b.product_b_id])))

  const [{ data: prodRows }, { data: supplierRows }] = await Promise.all([
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid, brand')
      .in('id', productIds),
    sb
      .from('jimscanner_trends_supplier')
      .select('product_id, price_krw, url_image, collected_at')
      .in('product_id', productIds)
      .order('collected_at', { ascending: false }),
  ])

  const products = new Map<string, ProductLite>()
  for (const p of (prodRows ?? []) as ProductLite[]) products.set(p.id, p)

  // 최신 supplier row 만 (collected_at desc 정렬되어 있음)
  const suppliers = new Map<string, SupplierLite>()
  for (const s of (supplierRows ?? []) as SupplierLite[]) {
    if (!suppliers.has(s.product_id)) suppliers.set(s.product_id, s)
  }

  return { bundles, products, suppliers }
}

async function fetchTotals() {
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSb = sb as any
  const tbl = 'jimscanner_trends_bundle_candidates'
  const counts = await Promise.all([
    rawSb.from(tbl).select('id', { count: 'exact', head: true }) as Promise<{ count: number | null }>,
    rawSb.from(tbl).select('id', { count: 'exact', head: true }).eq('pinned', true) as Promise<{ count: number | null }>,
    rawSb.from(tbl).select('id', { count: 'exact', head: true }).eq('both_in_ggsan', true) as Promise<{ count: number | null }>,
    rawSb.from(tbl).select('id', { count: 'exact', head: true }).eq('relation_type', 'complement') as Promise<{ count: number | null }>,
  ])
  return {
    total: counts[0]?.count ?? 0,
    pinned: counts[1]?.count ?? 0,
    ggsan: counts[2]?.count ?? 0,
    complement: counts[3]?.count ?? 0,
  }
}

function formatKrw(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Math.round(v).toLocaleString()}원`
}

function bundleMarginSim(combinedCost: number | null, expectedLift: number | null) {
  // 묶음 단위 절감 = 배송비 1회 분담 (단품 2번 배송 → 묶음 1번)
  const shippingSaved = SHIPPING_FLAT_KRW
  const baseCost = combinedCost ?? 0
  // 가상 판매가: 도매 cost × 1.6 (위탁 평균 마크업) 또는 lift 적용
  const baseRetail = baseCost > 0 ? Math.round(baseCost * 1.6) : 0
  const liftedRetail =
    expectedLift && baseRetail > 0 ? Math.round(baseRetail * (1 + expectedLift / 100)) : baseRetail
  return { shippingSaved, baseRetail, liftedRetail }
}

const FILTERS: { v: 'all' | 'pinned' | 'ggsan' | 'complement'; label: string }[] = [
  { v: 'all', label: '전체' },
  { v: 'complement', label: '보완 페어만' },
  { v: 'ggsan', label: 'ggsan 양쪽 보유' },
  { v: 'pinned', label: '핀' },
]

export default async function BundlesPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>
}) {
  const sp = await searchParams
  const filter = (FILTERS.some((f) => f.v === sp.f) ? sp.f : 'all') as 'all' | 'pinned' | 'ggsan' | 'complement'

  const [{ bundles, products, suppliers }, totals] = await Promise.all([
    fetchData({ filter, limit: 60 }),
    fetchTotals(),
  ])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">AOV 묶음 시너지 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            함께 사는 상품 페어 발굴 · 코멘션 + 함께 본 상품 + 보완성 LLM 분류 · 묶음 마진 시뮬
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">총 후보</div>
          <div className="text-xl font-bold">{totals.total.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">보완 페어</div>
          <div className="text-xl font-bold text-emerald-600">{totals.complement.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">ggsan 양쪽</div>
          <div className="text-xl font-bold text-amber-600">{totals.ggsan.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">핀</div>
          <div className="text-xl font-bold">{totals.pinned.toLocaleString()}</div>
        </div>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {FILTERS.map((f) => (
          <Link
            key={f.v}
            href={f.v === 'all' ? '/admin/trend-radar/bundles' : `/admin/trend-radar/bundles?f=${f.v}`}
            className={`px-3 py-2 text-sm border-b-2 ${filter === f.v ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {bundles.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">후보 페어 없음</p>
          <p className="text-sm mt-2">
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">scripts/mine-cobuy.mjs</code> 실행 후
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded ml-1">classify-trends-llm.mjs</code> 의 보완/대체 분류를 거치면 표시됩니다.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {bundles.map((b) => {
            const a = products.get(b.product_a_id)
            const bp = products.get(b.product_b_id)
            const supA = suppliers.get(b.product_a_id)
            const supB = suppliers.get(b.product_b_id)
            const sim = bundleMarginSim(b.combined_supplier_cost, b.expected_aov_lift)
            const relColor =
              b.relation_type === 'complement'
                ? 'bg-emerald-100 text-emerald-700'
                : b.relation_type === 'substitute'
                  ? 'bg-red-100 text-red-700'
                  : b.relation_type === 'neutral'
                    ? 'bg-gray-100 text-gray-600'
                    : 'bg-gray-50 text-gray-400'
            return (
              <div key={b.id} className="rounded border border-gray-200 p-4 grid grid-cols-12 gap-4 items-start">
                {/* a x b 썸네일 */}
                <div className="col-span-12 md:col-span-3 flex items-center gap-1">
                  <div className="aspect-square w-20 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                    {supA?.url_image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={supA.url_image} alt="" className="w-full h-full object-cover" loading="lazy" />
                    )}
                  </div>
                  <span className="text-xl font-bold text-gray-400">×</span>
                  <div className="aspect-square w-20 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                    {supB?.url_image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={supB.url_image} alt="" className="w-full h-full object-cover" loading="lazy" />
                    )}
                  </div>
                </div>

                {/* 페어 정보 */}
                <div className="col-span-12 md:col-span-5 space-y-1">
                  <div className="text-sm font-medium">
                    {a?.canonical_name ?? '?'}{' '}
                    <span className="text-gray-400">×</span> {bp?.canonical_name ?? '?'}
                  </div>
                  <div className="text-xs text-gray-500">
                    {a?.brand ?? '—'} / {bp?.brand ?? '—'} · {a?.category_mid ?? a?.category_top ?? ''} +{' '}
                    {bp?.category_mid ?? bp?.category_top ?? ''}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${relColor}`}>
                      {b.relation_type === 'complement'
                        ? '보완'
                        : b.relation_type === 'substitute'
                          ? '대체'
                          : b.relation_type === 'neutral'
                            ? '중립'
                            : '미분류'}
                    </span>
                    {b.both_in_ggsan && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                        ggsan 양쪽 보유
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                      코멘션 {b.co_mention_count}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                      보완성 {Math.round(b.complementarity_score)}
                    </span>
                  </div>
                  {b.listing_copy?.title && (
                    <div className="mt-2 p-2 bg-emerald-50 border border-emerald-100 rounded text-xs">
                      <div className="font-semibold text-emerald-800">결합 리스팅 카피</div>
                      <div className="mt-1 font-medium">{b.listing_copy.title}</div>
                      {b.listing_copy.bullet_points && (
                        <ul className="list-disc list-inside mt-1 text-gray-700">
                          {b.listing_copy.bullet_points.slice(0, 3).map((bp, i) => (
                            <li key={i}>{bp}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                {/* 묶음 마진 시뮬 */}
                <div className="col-span-12 md:col-span-3 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">결합 도매가</span>
                    <span className="font-mono">{formatKrw(b.combined_supplier_cost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">예상 판매가</span>
                    <span className="font-mono">{formatKrw(sim.liftedRetail)}</span>
                  </div>
                  <div className="flex justify-between text-emerald-700">
                    <span>배송비 절감(/묶음)</span>
                    <span className="font-mono">+{formatKrw(sim.shippingSaved)}</span>
                  </div>
                  {b.expected_aov_lift != null && (
                    <div className="flex justify-between text-emerald-700">
                      <span>AOV 리프트</span>
                      <span className="font-mono">+{b.expected_aov_lift.toFixed(1)}%</span>
                    </div>
                  )}
                </div>

                {/* 핀 액션 */}
                <div className="col-span-12 md:col-span-1 flex md:flex-col items-end justify-end gap-1">
                  <PinBundleButton bundleId={b.id} initialPinned={b.pinned} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
