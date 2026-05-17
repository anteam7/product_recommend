import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RefreshButton from './RefreshButton'

export const dynamic = 'force-dynamic'

interface ProductRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  price_text: string | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  last_seen_at: string
  last_changed_at: string
  volume_value: number | null
  volume_unit: string | null
  pack_count: number | null
  pack_unit: string | null
  unit_price: number | null
  unit_price_basis: string | null
}

interface UnitPriceViewRow {
  goods_no: string
  quantile_label: 'low' | 'mid' | 'high' | null
  p25: number | null
  p50: number | null
  p75: number | null
  pct_diff_from_median: number | null
  unit_price: number | null
  unit_price_basis: string | null
}

interface DistRow {
  cate_cd: string
  unit_price_basis: string
  sample_count: number
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
}

function formatUnitPrice(unitPrice: number | null, basis: string | null): string {
  if (unitPrice == null || !basis) return '—'
  const labelMap: Record<string, string> = {
    per_mg: '원/mg',
    per_g: '원/g',
    per_ml: '원/ml',
    per_tablet: '원/정',
    per_pack: '원/개',
  }
  const lbl = labelMap[basis] ?? basis
  // 작은 값(원/mg)은 소수점 2자리, 큰 값(원/정)은 정수
  const v = unitPrice < 10 ? unitPrice.toFixed(2) : Math.round(unitPrice).toLocaleString()
  return `${v} ${lbl}`
}

function quantileBadge(label: 'low' | 'mid' | 'high' | null, pctDiff: number | null) {
  if (!label) return null
  const cfg = {
    low: { bg: 'bg-emerald-100', text: 'text-emerald-700', kr: '저가' },
    mid: { bg: 'bg-gray-100', text: 'text-gray-600', kr: '중가' },
    high: { bg: 'bg-rose-100', text: 'text-rose-700', kr: '고가' },
  }[label]
  const diffTxt =
    pctDiff == null ? '' : ` ${pctDiff > 0 ? '+' : ''}${pctDiff.toFixed(0)}%`
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cfg.bg} ${cfg.text}`}>
      {cfg.kr}{diffTxt}
    </span>
  )
}

const CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '장건강' },
  { code: '002', label: '눈건강' },
  { code: '003', label: '간건강' },
  { code: '005', label: '혈행건강' },
  { code: '006', label: '관절건강' },
  { code: '007', label: '면역건강' },
  { code: '008', label: '체지방' },
  { code: '009', label: '건강기능식품기타' },
  { code: '010', label: '전통건강식품' },
  { code: '011', label: '전립선건강' },
  { code: '012', label: '식품분말' },
  { code: '013', label: '가공식품기타' },
  { code: '014', label: '신선식품' },
  { code: '015', label: '오프라인전용' },
  { code: '018', label: '반려동물용품' },
  { code: '019', label: '고객사은품' },
  { code: '020', label: '임박특가' },
  { code: '021', label: '카테고리21' },
  { code: '022', label: '카테고리22' },
]

const SORT_OPTIONS = [
  { v: 'recent', label: '최신 갱신순' },
  { v: 'price_asc', label: '가격 낮은순' },
  { v: 'price_desc', label: '가격 높은순' },
  { v: 'unit_asc', label: '단위가 낮은순' },
  { v: 'unit_desc', label: '단위가 높은순' },
  { v: 'title', label: '이름순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 60

async function fetchData(opts: {
  cat: string
  imminent: boolean
  q: string
  sort: SortKey
  page: number
}) {
  const sb = createAdminClient()

  let query = sb.from('jimscanner_ggsan_products').select('*', { count: 'exact' })
  if (opts.cat) query = query.eq('cate_cd', opts.cat)
  if (opts.imminent) query = query.eq('is_imminent', true)
  if (opts.q) query = query.ilike('title', `%${opts.q}%`)
  switch (opts.sort) {
    case 'price_asc':  query = query.order('price_krw', { ascending: true, nullsFirst: false }); break
    case 'price_desc': query = query.order('price_krw', { ascending: false, nullsFirst: false }); break
    case 'unit_asc':   query = (query as any).order('unit_price', { ascending: true, nullsFirst: false }); break
    case 'unit_desc':  query = (query as any).order('unit_price', { ascending: false, nullsFirst: false }); break
    case 'title':      query = query.order('title', { ascending: true }); break
    case 'recent':
    default:           query = query.order('last_changed_at', { ascending: false })
  }

  const offset = (opts.page - 1) * PAGE_SIZE
  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  const products = (data ?? []) as unknown as ProductRow[]

  // 같은 카테고리×basis 분위수 라벨을 view 에서 일괄 조회
  let viewRows: UnitPriceViewRow[] = []
  if (products.length > 0) {
    const ids = products.map((p) => p.goods_no)
    const { data: vData } = await (sb as any)
      .from('jimscanner_ggsan_unit_price_view')
      .select('goods_no, quantile_label, p25, p50, p75, pct_diff_from_median, unit_price, unit_price_basis')
      .in('goods_no', ids)
    viewRows = (vData ?? []) as UnitPriceViewRow[]
  }
  const byGoodsNo = new Map<string, UnitPriceViewRow>()
  for (const r of viewRows) byGoodsNo.set(r.goods_no, r)

  return { products, total: count ?? 0, viewByGoodsNo: byGoodsNo }
}

async function fetchDist(cat: string): Promise<DistRow[]> {
  if (!cat) return []
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_ggsan_unit_price_dist')
    .select('cate_cd, unit_price_basis, sample_count, p10, p25, p50, p75, p90')
    .eq('cate_cd', cat)
  return (data ?? []) as DistRow[]
}

async function fetchMeta() {
  const sb = createAdminClient()
  const [{ count: totalProducts }, { data: lastRun }, { data: queueRow }] = await Promise.all([
    sb.from('jimscanner_ggsan_products').select('*', { count: 'exact', head: true }),
    sb
      .from('jimscanner_trends_runs')
      .select('started_at, fetched_count, inserted_count, status')
      .eq('source', 'ggsan')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from('jimscanner_ggsan_refresh_queue')
      .select('id, status, requested_at, started_at, finished_at, fetched_count, inserted_count, error_message')
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  return { totalProducts: totalProducts ?? 0, lastRun, queueRow }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ggsan' + (qs ? `?${qs}` : '')
}

export default async function GgsanPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; imminent?: string; q?: string; sort?: string; page?: string }>
}) {
  const sp = await searchParams
  const cat = sp.cat ?? ''
  const imminent = sp.imminent === '1'
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'recent') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)

  const current: Record<string, string> = { cat, imminent: imminent ? '1' : '', q, sort, page: String(page) }

  const [{ products, total, viewByGoodsNo }, meta, distRows] = await Promise.all([
    fetchData({ cat, imminent, q, sort, page }),
    fetchMeta(),
    fetchDist(cat),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">ggsan 도매 카탈로그</h1>
          <p className="text-sm text-gray-500 mt-1">
            건강기능식품 위탁판매 도매몰 · 22 카테고리 · 누적 {meta.totalProducts.toLocaleString()}개 상품
          </p>
        </div>
        <RefreshButton
          initialActive={
            meta.queueRow && (meta.queueRow.status === 'pending' || meta.queueRow.status === 'running')
              ? meta.queueRow
              : null
          }
        />
      </header>

      {/* last sync 정보 */}
      {meta.lastRun && (
        <div className="rounded border border-gray-200 px-4 py-2 text-xs text-gray-600 flex justify-between">
          <span>
            마지막 자동 수집: <strong>{meta.lastRun.started_at?.slice(0, 16)?.replace('T', ' ')}</strong> · {meta.lastRun.status} ·
            fetched={meta.lastRun.fetched_count} inserted={meta.lastRun.inserted_count}
          </span>
          <span className="text-gray-400">매일 KST 02:00 자동 + 버튼으로 즉시 갱신</span>
        </div>
      )}

      {/* 필터: 카테고리 탭 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link
          href={buildHref(current, { cat: null, page: null })}
          className={`px-3 py-2 text-sm border-b-2 ${cat === '' ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
        >
          전체 <span className="text-xs text-gray-400">{meta.totalProducts}</span>
        </Link>
        {CATEGORIES.map((c) => (
          <Link
            key={c.code}
            href={buildHref(current, { cat: c.code, page: null })}
            className={`px-3 py-2 text-sm border-b-2 ${cat === c.code ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
          >
            {c.label}
          </Link>
        ))}
      </nav>

      {/* 보조 필터 */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={buildHref(current, { imminent: imminent ? null : '1', page: null })}
          className={`px-3 py-1 text-xs rounded ${imminent ? 'bg-red-100 text-red-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {imminent ? '✓ ' : ''}임박특가만
        </Link>

        <form className="flex-1 max-w-sm" action="/admin/trend-radar/ggsan">
          <input
            type="hidden"
            name="cat"
            value={cat}
          />
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="상품명 검색"
            className="w-full px-3 py-1 text-sm border border-gray-300 rounded"
          />
        </form>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">정렬</span>
          {SORT_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sort: s.v, page: null })}
              className={`px-2 py-1 text-xs rounded ${sort === s.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 카테고리 단위가 분포 (박스플롯 요약) — 카테고리 필터 적용 시 */}
      {distRows.length > 0 && (
        <section className="rounded border border-gray-200 p-3 bg-gray-50/50">
          <div className="text-xs font-semibold text-gray-700 mb-2">
            카테고리 단위가 분포 (저가/중가/고가 기준)
          </div>
          <div className="space-y-1">
            {distRows.map((d) => {
              const basisLabel = {
                per_mg: '원/mg',
                per_g: '원/g',
                per_ml: '원/ml',
                per_pack: '원/개',
              }[d.unit_price_basis] ?? d.unit_price_basis
              const fmt = (n: number) =>
                n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()
              return (
                <div key={d.unit_price_basis} className="grid grid-cols-12 items-center text-[11px] font-mono gap-2">
                  <div className="col-span-2 font-sans font-medium text-gray-700">{basisLabel}</div>
                  <div className="col-span-1 text-gray-400">n={d.sample_count}</div>
                  <div className="col-span-1 text-emerald-700">p10 {fmt(d.p10)}</div>
                  <div className="col-span-1 text-emerald-700">p25 {fmt(d.p25)}</div>
                  <div className="col-span-2 text-gray-800 font-semibold">중간값 {fmt(d.p50)}</div>
                  <div className="col-span-1 text-rose-700">p75 {fmt(d.p75)}</div>
                  <div className="col-span-1 text-rose-700">p90 {fmt(d.p90)}</div>
                  <div className="col-span-3">
                    <div className="relative h-1.5 bg-gradient-to-r from-emerald-200 via-gray-200 to-rose-200 rounded" />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 결과 카운트 */}
      <div className="text-xs text-gray-500">
        {total.toLocaleString()}건 · {page}/{totalPages} 페이지
      </div>

      {/* 카드 grid */}
      {products.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          조건에 맞는 상품 없음
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {products.map((p) => {
            const v = viewByGoodsNo.get(p.goods_no)
            return (
            <a
              key={p.goods_no}
              href={p.detail_url ?? '#'}
              target="_blank"
              rel="noopener"
              className="rounded border border-gray-200 hover:border-amber-400 hover:shadow-sm transition-all overflow-hidden"
            >
              <div className="aspect-square bg-gray-100 relative overflow-hidden">
                {p.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image_url}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                )}
                {p.is_imminent && (
                  <span className="absolute top-1 left-1 bg-red-600 text-white text-[10px] px-1.5 py-0.5 rounded">
                    임박특가
                  </span>
                )}
                {v?.quantile_label && (
                  <span className="absolute top-1 right-1">
                    {quantileBadge(v.quantile_label, v.pct_diff_from_median)}
                  </span>
                )}
              </div>
              <div className="p-2 space-y-1">
                <div className="text-xs text-gray-400 font-mono">{p.cate_label ?? p.cate_cd}</div>
                <div className="text-sm font-medium line-clamp-2 leading-snug" title={p.title}>
                  {p.title}
                </div>
                <div className="text-base font-bold">
                  {p.price_krw ? `${p.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                </div>
                {p.unit_price != null && p.unit_price_basis && (
                  <div className="text-[11px] font-mono text-gray-600">
                    {formatUnitPrice(p.unit_price, p.unit_price_basis)}
                    {p.volume_value && p.volume_unit && (
                      <span className="text-gray-400">
                        {' '}· {p.volume_value}{p.volume_unit}
                        {p.pack_count ? `×${p.pack_count}${p.pack_unit ?? ''}` : ''}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </a>
            )
          })}
        </div>
      )}

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-1 pt-4">
          {page > 1 && (
            <Link href={buildHref(current, { page: String(page - 1) })} className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">
              이전
            </Link>
          )}
          {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
            // 현재 페이지 근처 + 처음/끝 우선
            let n: number
            if (totalPages <= 7) n = i + 1
            else if (page <= 4) n = i + 1
            else if (page >= totalPages - 3) n = totalPages - 6 + i
            else n = page - 3 + i
            return (
              <Link
                key={n}
                href={buildHref(current, { page: String(n) })}
                className={`px-3 py-1 text-sm rounded ${n === page ? 'bg-black text-white' : 'border border-gray-200 hover:bg-gray-50'}`}
              >
                {n}
              </Link>
            )
          })}
          {page < totalPages && (
            <Link href={buildHref(current, { page: String(page + 1) })} className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">
              다음
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
