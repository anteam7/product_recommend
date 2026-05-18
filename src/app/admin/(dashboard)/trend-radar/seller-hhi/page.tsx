import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const SORTS = ['hhi_asc', 'hhi_desc', 'top1_desc'] as const
type Sort = (typeof SORTS)[number]

const SORT_LABEL: Record<Sort, string> = {
  hhi_asc: 'HHI 낮은순 (분산시장)',
  hhi_desc: 'HHI 높은순 (과점)',
  top1_desc: 'Top1 점유율 높은순',
}

interface HhiRow {
  product_id: string
  hhi: number
  top1_share: number
  top3_share: number
  seller_count_effective: number
  total_listings: number
  top1_seller: string | null
  snapshot_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

function classify(hhi: number): { label: string; color: string; bg: string; border: string } {
  if (hhi < 0.15) return { label: '분산시장', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200' }
  if (hhi <= 0.25) return { label: '중간', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' }
  return { label: '과점', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' }
}

async function fetchHhi() {
  const sb = createAdminClient()
  // 각 product 의 최신 snapshot 만
  const { data: rows } = await (sb as any)
    .from('jimscanner_trends_seller_hhi')
    .select('product_id, hhi, top1_share, top3_share, seller_count_effective, total_listings, top1_seller, snapshot_at')
    .order('snapshot_at', { ascending: false })
    .limit(2000)

  const latest = new Map<string, HhiRow>()
  for (const r of (rows ?? []) as HhiRow[]) {
    if (!latest.has(r.product_id)) latest.set(r.product_id, r)
  }
  const ids = [...latest.keys()]
  if (ids.length === 0) return { latest, products: new Map<string, ProductRow>() }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const pMap = new Map<string, ProductRow>()
  for (const p of (prods ?? []) as ProductRow[]) pMap.set(p.id, p)

  return { latest, products: pMap }
}

export default async function SellerHhiPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>
}) {
  const sp = await searchParams
  const sort = (SORTS.includes(sp.sort as Sort) ? sp.sort : 'hhi_asc') as Sort

  const { latest, products } = await fetchHhi()

  const merged = [...latest.values()]
    .map((r) => ({ r, p: products.get(r.product_id) }))
    .filter((x) => x.p)

  merged.sort((a, b) => {
    if (sort === 'hhi_asc') return a.r.hhi - b.r.hhi
    if (sort === 'hhi_desc') return b.r.hhi - a.r.hhi
    return b.r.top1_share - a.r.top1_share
  })

  // 카운트
  const bucket = { low: 0, mid: 0, high: 0 }
  for (const x of merged) {
    if (x.r.hhi < 0.15) bucket.low++
    else if (x.r.hhi <= 0.25) bucket.mid++
    else bucket.high++
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">Seller HHI — 판매자 집중도 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            Naver Shopping SERP 상위 20 listing 의 mallName 기반 점유율 → Herfindahl–Hirschman Index.
            <br />
            HHI &lt; 0.15 = 분산시장 (위탁 진입 용이) · 0.15~0.25 = 중간 · &gt; 0.25 = 과점 (마진 압박).
          </p>
        </div>
      </header>

      {/* 3구간 KPI */}
      <section className="grid grid-cols-3 gap-4">
        <Bucket label="분산시장" hint="HHI < 0.15" value={bucket.low} color="text-green-700" bg="bg-green-50" border="border-green-200" />
        <Bucket label="중간" hint="0.15~0.25" value={bucket.mid} color="text-amber-700" bg="bg-amber-50" border="border-amber-200" />
        <Bucket label="과점" hint="HHI > 0.25" value={bucket.high} color="text-red-700" bg="bg-red-50" border="border-red-200" />
      </section>

      {/* sort 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {SORTS.map((s) => (
          <Link
            key={s}
            href={`/admin/trend-radar/seller-hhi?sort=${s}`}
            className={`px-3 py-2 text-sm ${
              sort === s
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {SORT_LABEL[s]}
          </Link>
        ))}
      </nav>

      {merged.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-4">상품명</div>
            <div className="col-span-1 text-right">HHI</div>
            <div className="col-span-2">시장</div>
            <div className="col-span-1 text-right">Top1 %</div>
            <div className="col-span-2">Top1 판매자</div>
            <div className="col-span-1 text-right">유효셀러</div>
          </div>
          {merged.slice(0, 200).map(({ r, p }, i) => {
            const cls = classify(r.hhi)
            return (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors items-center"
              >
                <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium text-sm">{p!.canonical_name}</div>
                  <div className="text-xs text-gray-500">{p!.category_top}</div>
                </div>
                <div className="col-span-1 text-right font-mono font-bold">{r.hhi.toFixed(3)}</div>
                <div className="col-span-2">
                  <span className={`text-xs px-2 py-0.5 rounded border ${cls.bg} ${cls.color} ${cls.border}`}>
                    {cls.label}
                  </span>
                </div>
                <div className="col-span-1 text-right font-mono text-gray-700">{(r.top1_share * 100).toFixed(1)}%</div>
                <div className="col-span-2 text-xs text-gray-600 truncate">{r.top1_seller ?? '—'}</div>
                <div className="col-span-1 text-right text-xs text-gray-500">{r.seller_count_effective.toFixed(1)}</div>
              </Link>
            )
          })}
        </div>
      )}

      <p className="text-xs text-gray-400">
        수집: <code className="px-1 bg-gray-100 rounded">node scripts/fetch-seller-hhi.mjs</code> · 일 1회
      </p>
    </div>
  )
}

function Bucket({
  label,
  hint,
  value,
  color,
  bg,
  border,
}: {
  label: string
  hint: string
  value: number
  color: string
  bg: string
  border: string
}) {
  return (
    <div className={`rounded border p-4 ${bg} ${border}`}>
      <div className={`text-xs ${color}`}>{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-1 font-mono">{hint}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 HHI 스냅샷이 없습니다</p>
      <p className="text-sm mt-2">
        Naver SERP 상위 20 listing 의 mallName 점유율로 HHI 를 산출합니다.
        <br />
        <code className="px-1 bg-gray-100 rounded">node scripts/fetch-seller-hhi.mjs</code>
      </p>
    </div>
  )
}
