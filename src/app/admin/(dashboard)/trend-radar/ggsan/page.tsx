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
  first_seen_at: string
}

interface LagRow {
  cate_cd: string | null
  cate_label: string | null
  price_band: string | null
  sample_count: number
  lag_p25: number | null
  lag_p50: number | null
  lag_p75: number | null
  lag_p90: number | null
  lag_mean: number | null
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
    case 'title':      query = query.order('title', { ascending: true }); break
    case 'recent':
    default:           query = query.order('last_changed_at', { ascending: false })
  }

  const offset = (opts.page - 1) * PAGE_SIZE
  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  return { products: (data ?? []) as ProductRow[], total: count ?? 0 }
}

function priceBand(price: number | null): string {
  if (price == null) return 'unknown'
  if (price < 10000) return '0-10k'
  if (price < 30000) return '10-30k'
  if (price < 50000) return '30-50k'
  if (price < 100000) return '50-100k'
  return '100k+'
}

async function fetchLagStats(): Promise<Map<string, LagRow>> {
  const sb = createAdminClient()
  // RPC는 supabase/trends_v4_supply_demand_lag.sql 적용 후 사용 가능
  const { data, error } = await sb.rpc('jimscanner_supply_demand_lag' as never, {
    days_window: 180,
    min_sim: 0.30,
    spike_threshold: 40,
    p_cate_cd: null,
    p_price_band: null,
  } as never)
  const map = new Map<string, LagRow>()
  if (error || !data) return map
  for (const r of data as LagRow[]) {
    map.set(`${r.cate_cd ?? ''}::${r.price_band ?? ''}`, r)
  }
  return map
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

  const [{ products, total }, meta, lagStats] = await Promise.all([
    fetchData({ cat, imminent, q, sort, page }),
    fetchMeta(),
    fetchLagStats(),
  ])

  const now = Date.now()
  function dDayInfo(p: ProductRow): { p50: number; p90: number; remain50: number; remain90: number; n: number } | null {
    if (!p.cate_cd) return null
    const key = `${p.cate_cd}::${priceBand(p.price_krw)}`
    let stat = lagStats.get(key)
    if (!stat || stat.sample_count < 3) {
      // 가격대 표본 부족 시 카테고리 전체 평균으로 폴백 — '::' 키 + p_cate_cd 매칭 row
      let agg: { sum50: number; sum90: number; n: number } | null = null
      for (const r of lagStats.values()) {
        if (r.cate_cd !== p.cate_cd) continue
        if (r.lag_p50 == null || r.lag_p90 == null) continue
        agg ??= { sum50: 0, sum90: 0, n: 0 }
        agg.sum50 += Number(r.lag_p50) * r.sample_count
        agg.sum90 += Number(r.lag_p90) * r.sample_count
        agg.n += r.sample_count
      }
      if (!agg || agg.n < 3) return null
      stat = {
        cate_cd: p.cate_cd,
        cate_label: p.cate_label,
        price_band: priceBand(p.price_krw),
        sample_count: agg.n,
        lag_p25: null,
        lag_p50: agg.sum50 / agg.n,
        lag_p75: null,
        lag_p90: agg.sum90 / agg.n,
        lag_mean: null,
      }
    }
    if (stat.lag_p50 == null || stat.lag_p90 == null) return null
    const ageDays = Math.max(0, (now - new Date(p.first_seen_at).getTime()) / 86400000)
    const p50 = Number(stat.lag_p50)
    const p90 = Number(stat.lag_p90)
    return {
      p50,
      p90,
      remain50: p50 - ageDays,
      remain90: p90 - ageDays,
      n: stat.sample_count,
    }
  }

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
            const d = dDayInfo(p)
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
              </div>
              <div className="p-2 space-y-1">
                <div className="text-xs text-gray-400 font-mono">{p.cate_label ?? p.cate_cd}</div>
                <div className="text-sm font-medium line-clamp-2 leading-snug" title={p.title}>
                  {p.title}
                </div>
                <div className="text-base font-bold">
                  {p.price_krw ? `${p.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                </div>
                {d && (
                  <div
                    className={`inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
                      d.remain50 > 0
                        ? 'bg-emerald-100 text-emerald-700'
                        : d.remain90 > 0
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-gray-100 text-gray-500'
                    }`}
                    title={`카테고리 표본 ${d.n}건 · 입고 후 검색 정점까지 P50=${d.p50.toFixed(1)}일, P90=${d.p90.toFixed(1)}일`}
                  >
                    {d.remain50 > 0
                      ? `정점 D+${Math.ceil(d.remain50)} (P90 +${Math.max(0, Math.ceil(d.remain90))})`
                      : d.remain90 > 0
                        ? `P50지남 · P90 D+${Math.ceil(d.remain90)}`
                        : '윈도우 종료'}
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
