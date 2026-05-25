import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LadderRow {
  category_top: string
  bucket_idx: number
  bucket_label: string
  bucket_min: number
  bucket_max: number
  serp_count: number
  serp_median: number | null
  ggsan_count: number
  ggsan_wholesale_median: number | null
  ggsan_resale_median: number | null
  ggsan_wholesale_min: number | null
  ggsan_wholesale_max: number | null
  expected_margin_pct: number | null
  is_entry_slot: boolean
}

interface GgsanCandidate {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
}

interface SerpSample {
  product_id: string
  canonical_name: string | null
  supplier_source: string
  title: string | null
  price_krw: number | null
  supplier_url: string | null
}

const CATEGORIES = ['health', 'living', 'digital'] as const
type CategoryTop = (typeof CATEGORIES)[number]

const DAYS_OPTIONS = [7, 14, 30, 60] as const
const MARKUP_OPTIONS = [50, 100, 150, 200] as const

async function fetchLadder(days: number, markup: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_category_price_ladder' as never, {
    days_window: days,
    sale_markup_pct: markup,
  } as never)
  if (error) {
    return { rows: [] as LadderRow[], error: error.message }
  }
  return { rows: (data ?? []) as LadderRow[], error: null as string | null }
}

async function fetchCellDetail(opts: {
  category: CategoryTop
  bucketMin: number
  bucketMax: number
  markup: number
  days: number
}): Promise<{ ggsan: GgsanCandidate[]; serp: SerpSample[] }> {
  const sb = createAdminClient()

  // ggsan 후보 — resale_krw = price_krw * (1 + markup/100) 가 버킷에 떨어지는 SKU
  // health 카테고리만 ggsan 데이터 보유 (다른 카테고리는 빈 배열)
  let ggsan: GgsanCandidate[] = []
  if (opts.category === 'health') {
    const factor = 1 + opts.markup / 100
    // 역산: price_krw 범위 = [bucketMin / factor, bucketMax / factor)
    const wholesaleMin = Math.floor(opts.bucketMin / factor)
    const wholesaleMax = Math.ceil(opts.bucketMax / factor)
    const { data: gData } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, cate_cd, cate_label, price_krw, is_imminent, image_url, detail_url, status')
      .gte('price_krw', wholesaleMin)
      .lt('price_krw', wholesaleMax)
      .neq('status', 'removed')
      .order('is_imminent', { ascending: false })
      .order('price_krw', { ascending: true })
      .limit(30)
    ggsan = ((gData ?? []) as unknown as GgsanCandidate[])
  }

  // SERP 샘플 — 같은 카테고리·버킷에 떨어진 supplier listing
  const sinceIso = new Date(Date.now() - opts.days * 86_400_000).toISOString()
  const { data: sData } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, supplier_source, title, price_krw, supplier_url, collected_at, jimscanner_trends_products!inner(canonical_name, category_top)')
    .eq('jimscanner_trends_products.category_top', opts.category)
    .gte('price_krw', opts.bucketMin)
    .lt('price_krw', opts.bucketMax)
    .gte('collected_at', sinceIso)
    .order('price_krw', { ascending: true })
    .limit(30)
  const serp: SerpSample[] = ((sData ?? []) as unknown as Array<{
    product_id: string
    supplier_source: string
    title: string | null
    price_krw: number | null
    supplier_url: string | null
    jimscanner_trends_products: { canonical_name: string | null } | { canonical_name: string | null }[]
  }>).map((r) => {
    const p = Array.isArray(r.jimscanner_trends_products)
      ? r.jimscanner_trends_products[0]
      : r.jimscanner_trends_products
    return {
      product_id: r.product_id,
      canonical_name: p?.canonical_name ?? null,
      supplier_source: r.supplier_source,
      title: r.title,
      price_krw: r.price_krw,
      supplier_url: r.supplier_url,
    }
  })

  return { ggsan, serp }
}

function buildHref(
  current: Record<string, string>,
  override: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/price-ladder' + (qs ? `?${qs}` : '')
}

// SERP 카운트를 색 농도로 인코딩 (배경)
function serpHueClass(count: number, maxCount: number): string {
  if (count === 0) return 'bg-white'
  if (maxCount === 0) return 'bg-white'
  const ratio = count / maxCount
  if (ratio < 0.1) return 'bg-blue-50'
  if (ratio < 0.25) return 'bg-blue-100'
  if (ratio < 0.5) return 'bg-blue-200'
  if (ratio < 0.75) return 'bg-blue-300'
  return 'bg-blue-400'
}

function ggsanBorderClass(ggsanCount: number, isEntrySlot: boolean): string {
  if (isEntrySlot) return 'border-2 border-red-500 ring-2 ring-red-200'
  if (ggsanCount >= 10) return 'border-2 border-emerald-500'
  if (ggsanCount >= 3) return 'border-2 border-emerald-300'
  if (ggsanCount > 0) return 'border-2 border-emerald-200'
  return 'border border-gray-200'
}

function fmtKRW(n: number | null | undefined): string {
  if (n == null) return '—'
  return `₩${Math.round(n).toLocaleString()}`
}

export default async function PriceLadderPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; markup?: string; cat?: string; bucket?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays: number = (DAYS_OPTIONS as readonly number[]).includes(days) ? days : 30
  const markup = parseInt(sp.markup ?? '100', 10)
  const validMarkup: number = (MARKUP_OPTIONS as readonly number[]).includes(markup) ? markup : 100
  const selectedCat = (sp.cat ?? '') as CategoryTop | ''
  const selectedBucket = sp.bucket ? parseInt(sp.bucket, 10) : null

  const current: Record<string, string> = {
    days: String(validDays),
    markup: String(validMarkup),
    cat: selectedCat || '',
    bucket: selectedBucket ? String(selectedBucket) : '',
  }

  const { rows, error } = await fetchLadder(validDays, validMarkup)

  // 매트릭스 인덱싱: rows -> { category_top -> { bucket_idx -> row } }
  const matrix: Record<string, Record<number, LadderRow>> = {}
  for (const r of rows) {
    if (!matrix[r.category_top]) matrix[r.category_top] = {}
    matrix[r.category_top][r.bucket_idx] = r
  }

  const buckets: { idx: number; label: string }[] = []
  for (const r of rows) {
    if (!buckets.find((b) => b.idx === r.bucket_idx)) {
      buckets.push({ idx: r.bucket_idx, label: r.bucket_label })
    }
  }
  buckets.sort((a, b) => a.idx - b.idx)

  // SERP max per category for color scaling
  const serpMaxByCat: Record<string, number> = {}
  for (const cat of CATEGORIES) {
    const ms = (matrix[cat] ? Object.values(matrix[cat]) : []).map((r) => r.serp_count)
    serpMaxByCat[cat] = ms.length > 0 ? Math.max(...ms) : 0
  }

  const entrySlots = rows.filter((r) => r.is_entry_slot)
  const totalSerp = rows.reduce((a, r) => a + r.serp_count, 0)
  const totalGgsan = rows.reduce((a, r) => a + r.ggsan_count, 0)

  // 드릴다운: 셀 선택 시 후보 로드
  let detail: { ggsan: GgsanCandidate[]; serp: SerpSample[] } | null = null
  let detailCell: LadderRow | null = null
  if (selectedCat && selectedBucket && matrix[selectedCat]?.[selectedBucket]) {
    detailCell = matrix[selectedCat][selectedBucket]
    detail = await fetchCellDetail({
      category: selectedCat,
      bucketMin: detailCell.bucket_min,
      bucketMax: detailCell.bucket_max,
      markup: validMarkup,
      days: validDays,
    })
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📊 카테고리 × 가격사다리 커버리지</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리(health/living/digital) × 가격버킷 매트릭스. 셀 색조 = SERP 공급 밀도 · 테두리 = ggsan 후보 · 빨강 = 진입 우선 슬롯.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>해석 가이드</strong> · 셀 배경 진할수록 SERP 공급 밀도 높음(=레드오션) · 초록 테두리는 ggsan 후보가 있음 ·
        <strong className="text-red-700"> 빨간 셀</strong> = SERP 공급 &lt;5 × ggsan 후보 ≥1 × 기대마진 ≥35% (진입 우선).
        ggsan 카탈로그는 식품·건기식 도매라 현재 <code>health</code> 컬럼에만 후보 노출. resale 가격 = 도매가 × (1 + markup%).
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">SERP 기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d}
                href={buildHref(current, { days: String(d), cat: null, bucket: null })}
                className={`px-2 py-1 text-xs rounded ${
                  validDays === d
                    ? 'bg-blue-100 text-blue-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {d}일
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">ggsan 리세일 마크업</span>
            {MARKUP_OPTIONS.map((m) => (
              <Link
                key={m}
                href={buildHref(current, { markup: String(m), cat: null, bucket: null })}
                className={`px-2 py-1 text-xs rounded ${
                  validMarkup === m
                    ? 'bg-emerald-100 text-emerald-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                +{m}%
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="🔴 진입 우선 슬롯" value={entrySlots.length} highlight={entrySlots.length > 0} />
        <Kpi label="SERP listings (총)" value={totalSerp} />
        <Kpi label="ggsan 후보 (총, 리세일 매핑)" value={totalGgsan} />
        <Kpi label="셀 수" value={rows.length} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_category_price_ladder</code> 가 DB 에 적용 안 됐을 수 있음.{' '}
            <code>supabase/category_price_ladder_rpc.sql</code> 을 psql 로 적용.
          </p>
        </div>
      )}

      {/* 매트릭스 */}
      {!error && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse">
            <thead>
              <tr>
                <th className="p-2 text-xs text-gray-500 text-left w-24">카테고리 ＼ 가격대</th>
                {buckets.map((b) => (
                  <th key={b.idx} className="p-2 text-xs font-semibold text-gray-700">
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map((cat) => (
                <tr key={cat}>
                  <td className="p-2 text-sm font-semibold text-gray-700 align-top capitalize">{cat}</td>
                  {buckets.map((b) => {
                    const cell = matrix[cat]?.[b.idx]
                    if (!cell) {
                      return (
                        <td key={b.idx} className="p-1 align-top">
                          <div className="rounded p-3 bg-gray-50 border border-gray-200 text-xs text-gray-400 text-center">
                            —
                          </div>
                        </td>
                      )
                    }
                    const isSelected = selectedCat === cat && selectedBucket === b.idx
                    const bg = serpHueClass(cell.serp_count, serpMaxByCat[cat] ?? 0)
                    const border = ggsanBorderClass(cell.ggsan_count, cell.is_entry_slot)
                    return (
                      <td key={b.idx} className="p-1 align-top">
                        <Link
                          href={buildHref(current, {
                            cat: isSelected ? null : cat,
                            bucket: isSelected ? null : String(b.idx),
                          })}
                          className={`block rounded p-2 transition-shadow hover:shadow-md ${bg} ${border} ${
                            isSelected ? 'shadow-lg ring-2 ring-black' : ''
                          }`}
                          aria-label={`${cat} ${cell.bucket_label} 셀 상세`}
                        >
                          <div className="flex items-baseline justify-between gap-1">
                            <span
                              className={`text-base font-bold ${
                                cell.serp_count > 50 ? 'text-white' : 'text-gray-900'
                              }`}
                            >
                              {cell.serp_count}
                            </span>
                            <span className="text-[10px] text-gray-500">SERP</span>
                          </div>
                          <div className="flex items-baseline justify-between gap-1 mt-1">
                            <span
                              className={`text-sm font-semibold ${
                                cell.ggsan_count > 0 ? 'text-emerald-700' : 'text-gray-400'
                              }`}
                            >
                              {cell.ggsan_count}
                            </span>
                            <span className="text-[10px] text-gray-500">ggsan</span>
                          </div>
                          <div
                            className={`text-[11px] font-mono mt-1 ${
                              cell.expected_margin_pct == null
                                ? 'text-gray-400'
                                : cell.expected_margin_pct >= 35
                                ? 'text-red-700 font-bold'
                                : cell.expected_margin_pct >= 0
                                ? 'text-gray-700'
                                : 'text-gray-400'
                            }`}
                          >
                            {cell.expected_margin_pct == null
                              ? 'margin —'
                              : `margin ${Number(cell.expected_margin_pct).toFixed(0)}%`}
                          </div>
                          {cell.is_entry_slot && (
                            <div className="mt-1 text-[10px] text-red-700 font-bold">★ 진입</div>
                          )}
                        </Link>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 드릴다운 */}
      {detail && detailCell && (
        <section className="rounded border border-gray-300 bg-gray-50 p-4 space-y-4">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-lg font-bold">
              <span className="capitalize">{detailCell.category_top}</span> · {detailCell.bucket_label}
              {detailCell.is_entry_slot && (
                <span className="ml-2 text-sm text-red-700 font-bold">★ 진입 우선 슬롯</span>
              )}
            </h2>
            <Link
              href={buildHref(current, { cat: null, bucket: null })}
              className="text-xs text-gray-500 hover:text-black underline"
            >
              ✕ 닫기
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Kpi label="SERP 중위가" value={fmtKRW(detailCell.serp_median)} />
            <Kpi label="ggsan 도매 중위가" value={fmtKRW(detailCell.ggsan_wholesale_median)} />
            <Kpi label="ggsan 리세일 중위가" value={fmtKRW(detailCell.ggsan_resale_median)} />
            <Kpi
              label="기대마진"
              value={
                detailCell.expected_margin_pct == null
                  ? '—'
                  : `${Number(detailCell.expected_margin_pct).toFixed(1)}%`
              }
              highlight={(detailCell.expected_margin_pct ?? 0) >= 35}
            />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* ggsan 후보 */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-emerald-800">
                ggsan 후보 ({detail.ggsan.length})
              </h3>
              {detail.ggsan.length === 0 ? (
                <div className="rounded border border-dashed border-emerald-200 p-4 text-center text-xs text-gray-500">
                  이 카테고리·버킷에 매핑되는 ggsan SKU 없음
                </div>
              ) : (
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {detail.ggsan.map((g) => (
                    <a
                      key={g.goods_no}
                      href={g.detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className={`flex items-start gap-2 rounded border p-2 hover:bg-white transition-colors ${
                        g.is_imminent ? 'border-red-200 bg-red-50/40' : 'border-emerald-100 bg-white'
                      }`}
                    >
                      <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {g.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={g.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium leading-tight truncate" title={g.title}>
                          {g.title}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {g.cate_label ?? g.cate_cd} · {g.goods_no}
                          {g.is_imminent && <span className="ml-1 text-red-600 font-bold">임박</span>}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xs font-bold">{fmtKRW(g.price_krw)}</div>
                        <div className="text-[10px] text-gray-400">도매</div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>

            {/* SERP 샘플 */}
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-blue-800">
                SERP 비교 listings ({detail.serp.length})
              </h3>
              {detail.serp.length === 0 ? (
                <div className="rounded border border-dashed border-blue-200 p-4 text-center text-xs text-gray-500">
                  이 카테고리·버킷에 매핑되는 supplier listing 없음
                </div>
              ) : (
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {detail.serp.map((s, i) => (
                    <a
                      key={`${s.product_id}-${i}`}
                      href={s.supplier_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="flex items-start gap-2 rounded border border-blue-100 bg-white p-2 hover:bg-blue-50 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium leading-tight truncate" title={s.title ?? ''}>
                          {s.title || s.canonical_name || '(제목 없음)'}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {s.supplier_source}
                          {s.canonical_name && ` · ${s.canonical_name}`}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xs font-bold">{fmtKRW(s.price_krw)}</div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {!error && rows.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">데이터 없음</div>
          <div className="text-xs text-gray-400">
            jimscanner_trends_supplier 가 비어있거나 RPC 미적용. supabase/category_price_ladder_rpc.sql 적용 후 collector 누적.
          </div>
        </div>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          serp_count = COUNT(jimscanner_trends_supplier WHERE category_top, price_krw IN bucket, recent days_window)
          <br />
          ggsan_count = COUNT(jimscanner_ggsan_products WHERE price_krw × (1 + markup) IN bucket, status ≠ removed)
          <br />
          expected_margin_pct = (serp_median − ggsan_wholesale_median) / serp_median × 100
          <br />
          is_entry_slot = (serp_count &lt; 5) ∧ (ggsan_count &gt; 0) ∧ (margin ≥ 35%)
        </code>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
