import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'
export const metadata = { title: '공급원 도매가 분산 · 트렌드 레이더' }

interface WindowRow {
  product_id: string
  latest_day: string | null
  days_30d: number | null
  days_60d: number | null
  days_90d: number | null
  cv_30d: number | null
  cv_60d: number | null
  cv_90d: number | null
  avg_n_suppliers_30d: number | null
  max_n_ggsan_sellers_30d: number | null
}

interface DailyRow {
  product_id: string
  captured_day: string
  n_suppliers: number
  n_ggsan_sellers: number
  n_domeggook_sellers: number
  n_1688_sellers: number
  price_min: number | null
  price_max: number | null
  price_mean: number | null
  price_p10: number | null
  price_p25: number | null
  price_median: number | null
  price_p75: number | null
  price_p90: number | null
  iqr: number | null
  price_stddev: number | null
  cv: number | null
}

interface ProductRow {
  id: string
  canonical_name: string
  brand: string | null
  category_top: string
  category_mid: string | null
}

const SORT_OPTIONS = [
  { v: 'cv_desc', label: 'CV 큰 순 (협상 우위)' },
  { v: 'cv_asc', label: 'CV 작은 순 (commoditization 임박)' },
  { v: 'suppliers_desc', label: '공급원 많은 순' },
  { v: 'recent', label: '최근 갱신순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const MIN_SUPPLIERS = 2
const PAGE_SIZE = 40

async function fetchData(opts: { sort: SortKey; minN: number }) {
  const sb = createAdminClient()

  const { data: windowRows } = await (sb as any)
    .from('jimscanner_trends_supplier_quotes_window')
    .select('*')
    .gte('avg_n_suppliers_30d', opts.minN)
    .limit(500)

  const windows = ((windowRows ?? []) as WindowRow[]).filter((w) => (w.days_30d ?? 0) > 0)
  const productIds = windows.map((w) => w.product_id)

  if (productIds.length === 0) {
    return { windows: [], productsById: new Map<string, ProductRow>(), latestDaily: new Map<string, DailyRow>(), history: new Map<string, DailyRow[]>() }
  }

  const [{ data: productRows }, { data: dailyRows }] = await Promise.all([
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, brand, category_top, category_mid')
      .in('id', productIds),
    (sb as any)
      .from('jimscanner_trends_supplier_quotes_daily')
      .select('*')
      .in('product_id', productIds)
      .gte('captured_day', new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      .order('captured_day', { ascending: false }),
  ])

  const productsById = new Map<string, ProductRow>()
  for (const p of (productRows ?? []) as ProductRow[]) productsById.set(p.id, p)

  const history = new Map<string, DailyRow[]>()
  const latestDaily = new Map<string, DailyRow>()
  for (const row of (dailyRows ?? []) as DailyRow[]) {
    const list = history.get(row.product_id) ?? []
    list.push(row)
    history.set(row.product_id, list)
    if (!latestDaily.has(row.product_id)) latestDaily.set(row.product_id, row)
  }

  // sort
  const sorted = [...windows]
  switch (opts.sort) {
    case 'cv_asc':
      sorted.sort((a, b) => (a.cv_30d ?? Infinity) - (b.cv_30d ?? Infinity))
      break
    case 'suppliers_desc':
      sorted.sort((a, b) => (b.avg_n_suppliers_30d ?? 0) - (a.avg_n_suppliers_30d ?? 0))
      break
    case 'recent':
      sorted.sort((a, b) => (b.latest_day ?? '').localeCompare(a.latest_day ?? ''))
      break
    case 'cv_desc':
    default:
      sorted.sort((a, b) => (b.cv_30d ?? -1) - (a.cv_30d ?? -1))
  }

  return { windows: sorted.slice(0, PAGE_SIZE), productsById, latestDaily, history }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/supplier-spread' + (qs ? `?${qs}` : '')
}

export default async function SupplierSpreadPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; min_n?: string }>
}) {
  const sp = await searchParams
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'cv_desc') as SortKey
  const minN = Math.max(MIN_SUPPLIERS, parseInt(sp.min_n ?? String(MIN_SUPPLIERS), 10) || MIN_SUPPLIERS)
  const current: Record<string, string> = { sort, min_n: String(minN) }

  const { windows, productsById, latestDaily, history } = await fetchData({ sort, minN })

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">공급원 도매가 분산 (Wholesaler Quote Dispersion)</h1>
        <p className="text-sm text-gray-500 mt-1">
          동일 canonical 상품에 매핑된 복수 도매 공급원 (ggsan 다중 셀러 · 도매꾹 · 1688) 견적 분포.
          CV 크면 같은 SKU 저가 셀러 발굴 여지가 큼 (협상 우위). CV 가 시간에 따라 줄면 commoditization/카르텔화 임박.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 pb-3">
        <span className="text-xs text-gray-500">정렬</span>
        {SORT_OPTIONS.map((s) => (
          <Link
            key={s.v}
            href={buildHref(current, { sort: s.v })}
            className={`px-2 py-1 text-xs rounded ${
              sort === s.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            {s.label}
          </Link>
        ))}
        <span className="ml-auto text-xs text-gray-500">최소 공급원 수 (30일 평균):</span>
        {[2, 3, 4, 5].map((n) => (
          <Link
            key={n}
            href={buildHref(current, { min_n: String(n) })}
            className={`px-2 py-1 text-xs rounded ${
              minN === n ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            ≥{n}
          </Link>
        ))}
      </div>

      <div className="text-xs text-gray-500">{windows.length}개 상품 (상위 {PAGE_SIZE} 노출)</div>

      {windows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-1">
          <div>아직 적재된 공급원 견적이 없습니다.</div>
          <div className="text-xs">
            scripts/ggsan-multi-seller-fetch.mjs (cron) 가 첫 실행되면 채워집니다.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {windows.map((w) => {
            const product = productsById.get(w.product_id)
            const latest = latestDaily.get(w.product_id)
            const series = history.get(w.product_id) ?? []
            return (
              <SpreadCard
                key={w.product_id}
                window={w}
                product={product}
                latest={latest}
                series={series}
              />
            )
          })}
        </div>
      )}

      <section className="rounded border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600 space-y-1">
        <div className="font-semibold text-gray-800">읽는 법</div>
        <div>• CV (변동계수) = stddev / mean. 같은 상품을 파는 셀러 간 가격이 얼마나 흩어져 있는지.</div>
        <div>• CV 30d &gt; 60d &gt; 90d → 분산이 커지는 중. 새 저가 셀러 진입 → 협상 카드 추가 확보.</div>
        <div>• CV 30d &lt; 60d &lt; 90d → 분산이 좁아지는 중. 가격이 한 점으로 수렴, 마지막 진입 윈도우.</div>
        <div>• p10/p90 박스 폭 = IQR 시각화. p10 근처 셀러를 직접 컨택하면 즉시 마진 +5~15%p.</div>
      </section>
    </div>
  )
}

function SpreadCard({
  window: w,
  product,
  latest,
  series,
}: {
  window: WindowRow
  product?: ProductRow
  latest?: DailyRow
  series: DailyRow[]
}) {
  const cv30 = w.cv_30d
  const cv60 = w.cv_60d
  const cv90 = w.cv_90d
  const cvDelta30v90 = cv30 != null && cv90 != null ? cv30 - cv90 : null
  const trendBadge = cvTrendBadge(cvDelta30v90)

  return (
    <div className="rounded border border-gray-200 hover:border-amber-400 transition-colors p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          {product ? (
            <Link
              href={`/admin/trend-radar/products/${product.id}`}
              className="text-base font-bold text-black hover:underline"
            >
              {product.canonical_name}
            </Link>
          ) : (
            <span className="text-base font-bold text-gray-500">(상품 정보 없음)</span>
          )}
          <div className="text-xs text-gray-500 mt-0.5">
            {product?.brand ? <span className="text-black font-medium">{product.brand}</span> : null}
            {product?.brand ? ' · ' : ''}
            {product?.category_top}
            {product?.category_mid ? ` / ${product.category_mid}` : ''}
            {' · 마지막 적재 '}
            {w.latest_day ?? '—'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {trendBadge}
        </div>
      </div>

      {/* CV / supplier count grid */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
        <StatCell label="CV 30d" value={fmtCV(cv30)} highlight />
        <StatCell label="CV 60d" value={fmtCV(cv60)} />
        <StatCell label="CV 90d" value={fmtCV(cv90)} />
        <StatCell label="평균 공급원" value={fmtNum(w.avg_n_suppliers_30d, 1)} />
        <StatCell label="ggsan 셀러" value={w.max_n_ggsan_sellers_30d?.toString() ?? '—'} />
        <StatCell label="활성 일수 30/60/90" value={`${w.days_30d ?? 0}·${w.days_60d ?? 0}·${w.days_90d ?? 0}`} />
      </div>

      {/* 박스플롯 (최신일) */}
      {latest && latest.price_min != null && latest.price_max != null && (
        <div>
          <div className="text-xs text-gray-500 mb-1">
            오늘({latest.captured_day}) 견적 분포 · n={latest.n_suppliers}
            {latest.n_ggsan_sellers ? ` · ggsan ${latest.n_ggsan_sellers}` : ''}
            {latest.n_domeggook_sellers ? ` · 도매꾹 ${latest.n_domeggook_sellers}` : ''}
            {latest.n_1688_sellers ? ` · 1688 ${latest.n_1688_sellers}` : ''}
          </div>
          <BoxPlot row={latest} />
        </div>
      )}

      {/* CV sparkline (최근 30일 daily) */}
      {series.length > 1 && (
        <div>
          <div className="text-xs text-gray-500 mb-1">CV 추이 (최근 {Math.min(90, series.length)}일)</div>
          <Sparkline values={series.slice(0, 90).map((d) => d.cv).reverse()} />
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded border ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'} px-2 py-1`}>
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className={`font-mono ${highlight ? 'font-bold text-amber-700' : 'text-gray-800'}`}>{value}</div>
    </div>
  )
}

function BoxPlot({ row }: { row: DailyRow }) {
  const min = row.price_min!
  const max = row.price_max!
  const range = Math.max(1, max - min)
  const pct = (v: number | null) => (v == null ? 0 : ((v - min) / range) * 100)

  const p10 = pct(row.price_p10)
  const p25 = pct(row.price_p25)
  const median = pct(row.price_median)
  const p75 = pct(row.price_p75)
  const p90 = pct(row.price_p90)

  return (
    <div className="space-y-1">
      <div className="relative h-8 bg-gray-50 rounded">
        {/* p10 - p90 whisker line */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-px bg-gray-400"
          style={{ left: `${p10}%`, width: `${Math.max(0, p90 - p10)}%` }}
        />
        {/* IQR box (p25-p75) */}
        <div
          className="absolute top-1 bottom-1 bg-amber-200 border border-amber-500 rounded"
          style={{ left: `${p25}%`, width: `${Math.max(0.5, p75 - p25)}%` }}
        />
        {/* median */}
        <div
          className="absolute top-0 bottom-0 w-px bg-black"
          style={{ left: `${median}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-500 font-mono">
        <span>{fmtKrw(min)}</span>
        <span className="text-amber-700 font-semibold">
          p25 {fmtKrw(row.price_p25)} · median {fmtKrw(row.price_median)} · p75 {fmtKrw(row.price_p75)}
        </span>
        <span>{fmtKrw(max)}</span>
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: (number | null)[] }) {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v))
  if (nums.length < 2) {
    return <div className="text-xs text-gray-400">데이터 부족</div>
  }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const range = Math.max(1e-9, max - min)
  const W = 600
  const H = 40
  const stepX = W / Math.max(1, values.length - 1)
  const points = values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return null
    const y = H - ((v - min) / range) * H
    return `${i * stepX},${y}`
  })
  const segments: string[][] = []
  let current: string[] = []
  for (const p of points) {
    if (p == null) {
      if (current.length > 1) segments.push(current)
      current = []
    } else {
      current.push(p)
    }
  }
  if (current.length > 1) segments.push(current)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10">
      {segments.map((seg, i) => (
        <polyline
          key={i}
          fill="none"
          stroke="#d97706"
          strokeWidth="1.5"
          points={seg.join(' ')}
        />
      ))}
    </svg>
  )
}

function cvTrendBadge(delta: number | null) {
  if (delta == null) {
    return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">추세 데이터 부족</span>
  }
  if (delta > 0.02) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
        ↑ 분산 확대 (협상 우위 증가)
      </span>
    )
  }
  if (delta < -0.02) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">
        ↓ 분산 축소 (commoditization 임박)
      </span>
    )
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">≈ 분산 유지</span>
}

function fmtCV(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(3)
}

function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function fmtKrw(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${Math.round(v).toLocaleString()}원`
}
