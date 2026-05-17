import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RefreshButton from './RefreshButton'
import ReliabilityBadge from './ReliabilityBadge'
import PriceSparkline from './PriceSparkline'

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
}

interface ReliabilityRow {
  goods_no: string
  reliability_score: number
  price_stability: number
  stock_stability: number
  ops_stability: number
  history_thickness: number
  history_rows: number
  price_cv: number | null
  stockout_events: number
  imminent_events: number
  active_days: number
  last_seen_age_hours: number
  change_events_30d: number
}

interface SparklinePoint {
  observed_at: string
  price_krw: number | null
  status: string | null
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
  { v: 'reliability_desc', label: '신뢰성 높은순' },
  { v: 'reliability_asc', label: '신뢰성 낮은순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 60

// DB 정렬키를 쓰는 sort 들 (reliability 는 메모리 정렬)
function isDbSort(s: SortKey) {
  return s === 'recent' || s === 'price_asc' || s === 'price_desc' || s === 'title'
}

async function fetchReliability(): Promise<Map<string, ReliabilityRow>> {
  const sb = createAdminClient()
  // RPC 는 supabase/trends_v4_supplier_reliability.sql 에 정의. generated types 미반영.
  const { data, error } = await sb.rpc('jimscanner_ggsan_supplier_reliability' as never, {
    lookback_days: 30,
    min_history: 2,
  } as never)
  const map = new Map<string, ReliabilityRow>()
  if (error || !data) return map
  for (const r of data as ReliabilityRow[]) {
    map.set(r.goods_no, r)
  }
  return map
}

async function fetchData(opts: {
  cat: string
  imminent: boolean
  q: string
  sort: SortKey
  page: number
  lowRel: boolean
  reliability: Map<string, ReliabilityRow>
}) {
  const sb = createAdminClient()

  // reliability 정렬·필터가 켜진 경우 DB 페이지네이션을 못 쓰므로 전수 조회 후 메모리에서 처리.
  const needsAll = !isDbSort(opts.sort) || opts.lowRel

  let query = sb.from('jimscanner_ggsan_products').select('*', { count: 'exact' })
  if (opts.cat) query = query.eq('cate_cd', opts.cat)
  if (opts.imminent) query = query.eq('is_imminent', true)
  if (opts.q) query = query.ilike('title', `%${opts.q}%`)
  switch (opts.sort) {
    case 'price_asc':  query = query.order('price_krw', { ascending: true, nullsFirst: false }); break
    case 'price_desc': query = query.order('price_krw', { ascending: false, nullsFirst: false }); break
    case 'title':      query = query.order('title', { ascending: true }); break
    case 'recent':
    case 'reliability_asc':
    case 'reliability_desc':
    default:           query = query.order('last_changed_at', { ascending: false })
  }

  if (!needsAll) {
    const offset = (opts.page - 1) * PAGE_SIZE
    query = query.range(offset, offset + PAGE_SIZE - 1)
    const { data, count } = await query
    return { products: (data ?? []) as ProductRow[], total: count ?? 0 }
  }

  // 전수 조회 한도 (성능 안전장치)
  query = query.range(0, 1999)
  const { data, count } = await query
  let rows = (data ?? []) as ProductRow[]

  if (opts.lowRel) {
    rows = rows.filter((p) => {
      const rel = opts.reliability.get(p.goods_no)
      return rel != null && rel.reliability_score < 40
    })
  }

  if (opts.sort === 'reliability_desc' || opts.sort === 'reliability_asc') {
    const dir = opts.sort === 'reliability_desc' ? -1 : 1
    rows.sort((a, b) => {
      const ra = opts.reliability.get(a.goods_no)?.reliability_score ?? -1
      const rb = opts.reliability.get(b.goods_no)?.reliability_score ?? -1
      return (ra - rb) * dir
    })
  }

  const filteredTotal = opts.lowRel ? rows.length : (count ?? rows.length)
  const offset = (opts.page - 1) * PAGE_SIZE
  return { products: rows.slice(offset, offset + PAGE_SIZE), total: filteredTotal }
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

async function fetchSparklines(goodsNos: string[]): Promise<Map<string, SparklinePoint[]>> {
  const map = new Map<string, SparklinePoint[]>()
  if (goodsNos.length === 0) return map
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_ggsan_price_history')
    .select('goods_no, observed_at, price_krw, status')
    .in('goods_no', goodsNos)
    .gte('observed_at', new Date(Date.now() - 30 * 86400 * 1000).toISOString())
    .order('observed_at', { ascending: false })
    .limit(2400)
  for (const row of (data ?? []) as Array<SparklinePoint & { goods_no: string }>) {
    const list = map.get(row.goods_no) ?? []
    if (list.length < 48) {
      list.push({ observed_at: row.observed_at, price_krw: row.price_krw, status: row.status })
      map.set(row.goods_no, list)
    }
  }
  return map
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

function buildWarning(rel: ReliabilityRow | undefined): string | null {
  if (!rel) return null
  if (rel.reliability_score >= 40) return null
  const parts: string[] = []
  if (rel.stockout_events >= 2) parts.push(`30일 내 품절 ${rel.stockout_events}회`)
  if (rel.price_cv != null && rel.price_cv > 0.1) parts.push(`도매가 변동계수 ${(rel.price_cv * 100).toFixed(0)}%`)
  if (rel.change_events_30d >= 3 && rel.price_stability < 50)
    parts.push(`도매가 7일 내 ${rel.change_events_30d}회 변동`)
  if (rel.imminent_events >= 2) parts.push(`임박특가 노출 ${rel.imminent_events}회`)
  if (parts.length === 0) parts.push(`이력 두께 ${rel.history_thickness}/100`)
  return parts.slice(0, 2).join(' · ')
}

export default async function GgsanPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; imminent?: string; q?: string; sort?: string; page?: string; lowrel?: string }>
}) {
  const sp = await searchParams
  const cat = sp.cat ?? ''
  const imminent = sp.imminent === '1'
  const lowRel = sp.lowrel === '1'
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'recent') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)

  const current: Record<string, string> = {
    cat,
    imminent: imminent ? '1' : '',
    lowrel: lowRel ? '1' : '',
    q,
    sort,
    page: String(page),
  }

  const reliability = await fetchReliability()
  const [{ products, total }, meta] = await Promise.all([
    fetchData({ cat, imminent, q, sort, page, lowRel, reliability }),
    fetchMeta(),
  ])

  const sparklines = await fetchSparklines(products.map((p) => p.goods_no))
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">ggsan 도매 카탈로그</h1>
          <p className="text-sm text-gray-500 mt-1">
            건강기능식품 위탁판매 도매몰 · 22 카테고리 · 누적 {meta.totalProducts.toLocaleString()}개 상품 · 신뢰성 {reliability.size}건 산출
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
        <Link
          href={buildHref(current, { lowrel: lowRel ? null : '1', page: null })}
          className={`px-3 py-1 text-xs rounded ${lowRel ? 'bg-red-100 text-red-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          title="신뢰성 점수 40 미만 SKU만"
        >
          {lowRel ? '✓ ' : ''}신뢰성 &lt; 40
        </Link>

        <form className="flex-1 max-w-sm" action="/admin/trend-radar/ggsan">
          <input type="hidden" name="cat" value={cat} />
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="상품명 검색"
            className="w-full px-3 py-1 text-sm border border-gray-300 rounded"
          />
        </form>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
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
        {reliability.size === 0 && (
          <span className="ml-2 text-amber-600">
            ⚠ 신뢰성 RPC 미적용 (supabase/trends_v4_supplier_reliability.sql 적용 필요)
          </span>
        )}
      </div>

      {/* 카드 grid */}
      {products.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          조건에 맞는 상품 없음
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {products.map((p) => {
            const rel = reliability.get(p.goods_no)
            const warning = buildWarning(rel)
            return (
              <div
                key={p.goods_no}
                className="rounded border border-gray-200 hover:border-amber-400 hover:shadow-sm transition-all overflow-hidden flex flex-col"
              >
                <a
                  href={p.detail_url ?? '#'}
                  target="_blank"
                  rel="noopener"
                  className="block"
                >
                  <div className="aspect-square bg-gray-100 relative overflow-hidden">
                    {p.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {p.is_imminent && (
                      <span className="absolute top-1 left-1 bg-red-600 text-white text-[10px] px-1.5 py-0.5 rounded">
                        임박특가
                      </span>
                    )}
                    {rel && (
                      <div className="absolute top-1 right-1">
                        <ReliabilityBadge score={rel.reliability_score} compact warning={warning} />
                      </div>
                    )}
                  </div>
                </a>
                <div className="p-2 space-y-1 flex-1 flex flex-col">
                  <div className="text-xs text-gray-400 font-mono">{p.cate_label ?? p.cate_cd}</div>
                  <a
                    href={p.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className="text-sm font-medium line-clamp-2 leading-snug hover:underline"
                    title={p.title}
                  >
                    {p.title}
                  </a>
                  <div className="text-base font-bold">
                    {p.price_krw
                      ? `${p.price_krw.toLocaleString()}원`
                      : <span className="text-gray-400 text-xs">가격 X</span>}
                  </div>

                  {rel && (
                    <div className="pt-1 space-y-1">
                      <ReliabilityBadge score={rel.reliability_score} warning={warning} />
                      <div className="grid grid-cols-4 text-[9px] text-gray-500 gap-0.5">
                        <div title="가격 안정"><span className="font-mono">{rel.price_stability}</span><span className="ml-0.5">가격</span></div>
                        <div title="재고 안정"><span className="font-mono">{rel.stock_stability}</span><span className="ml-0.5">재고</span></div>
                        <div title="운영 안정"><span className="font-mono">{rel.ops_stability}</span><span className="ml-0.5">운영</span></div>
                        <div title="이력 두께"><span className="font-mono">{rel.history_thickness}</span><span className="ml-0.5">이력</span></div>
                      </div>
                      <PriceSparkline points={sparklines.get(p.goods_no) ?? []} width={120} height={28} />
                    </div>
                  )}
                </div>
              </div>
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
