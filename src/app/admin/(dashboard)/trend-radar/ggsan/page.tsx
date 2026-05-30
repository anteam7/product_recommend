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

// ── 소싱 안정성 (셀스루 회전율 보드) ─────────────────────────────
interface SellthroughRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  current_status: string | null
  observation_days: number
  observation_count: number
  soldout_entries: number
  avg_stock_days: number | null
  sellthrough_velocity: number
  restock_count: number
  avg_restock_lead_days: number | null
  is_removed: boolean
  restock_reliability: number
}

async function fetchSellthrough(): Promise<{ rows: SellthroughRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_sellthrough_rpc.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_ggsan_sellthrough_rpc' as never, {
    days_window: 90,
    result_limit: 300,
  } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as SellthroughRow[], error: null }
}

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
  searchParams: Promise<{ cat?: string; imminent?: string; q?: string; sort?: string; page?: string; view?: string }>
}) {
  const sp = await searchParams
  const cat = sp.cat ?? ''
  const imminent = sp.imminent === '1'
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'recent') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const view = sp.view === 'sourcing' ? 'sourcing' : 'catalog'

  const current: Record<string, string> = { cat, imminent: imminent ? '1' : '', q, sort, page: String(page), view: view === 'sourcing' ? 'sourcing' : '' }

  const [{ products, total }, meta, sell] = await Promise.all([
    fetchData({ cat, imminent, q, sort, page }),
    fetchMeta(),
    view === 'sourcing' ? fetchSellthrough() : Promise.resolve({ rows: [] as SellthroughRow[], error: null as string | null }),
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

      {/* 뷰 토글: 카탈로그 ↔ 소싱 안정성 */}
      <nav className="flex gap-1 border-b border-gray-200">
        <Link
          href={buildHref(current, { view: null, page: null })}
          className={`px-4 py-2 text-sm border-b-2 ${view === 'catalog' ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
        >
          카탈로그
        </Link>
        <Link
          href={buildHref(current, { view: 'sourcing', page: null })}
          className={`px-4 py-2 text-sm border-b-2 ${view === 'sourcing' ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
        >
          소싱 안정성 <span className="text-[10px] text-amber-600">셀스루×재입고</span>
        </Link>
      </nav>

      {view === 'sourcing' ? (
        <SourcingBoard rows={sell.rows} error={sell.error} />
      ) : (
      <>
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
          {products.map((p) => (
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
              </div>
            </a>
          ))}
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
      </>
      )}
    </div>
  )
}

// ── 소싱 안정성 2D 보드 ─────────────────────────────────────────
// X축 = 셀스루 속도(빠른 소진 = 실수요), Y축 = 재입고 신뢰도(안정 재입고)
// 우상단: 빠른 소진 + 안정 재입고 = 최우선 소싱
// 우하단: 빠른 소진 + 불안정 재입고 = 주문폭주 시 미발송 리스크 (경고)
function SourcingBoard({ rows, error }: { rows: SellthroughRow[]; error: string | null }) {
  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        RPC 오류: {error}
        <p className="mt-1 text-xs text-red-500">
          supabase/ggsan_sellthrough_rpc.sql 을 DB에 적용했는지 확인하세요.
        </p>
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
        품절 이력이 있는 상품이 아직 없습니다 (price_history 누적 대기 중).
      </div>
    )
  }

  const maxVel = Math.max(1, ...rows.map((r) => r.sellthrough_velocity))
  const VEL_MID = maxVel / 2

  // 분류: 우상단(최우선) / 우하단(미발송 리스크) / 좌측(저회전)
  const priority = rows.filter((r) => r.sellthrough_velocity >= VEL_MID && r.restock_reliability >= 50)
  const risky = rows.filter((r) => r.sellthrough_velocity >= VEL_MID && r.restock_reliability < 50)

  const xPct = (v: number) => Math.min(98, Math.max(2, (v / maxVel) * 100))
  const yPct = (r: number) => Math.min(98, Math.max(2, 100 - r)) // reliability 100 → top

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-xs text-emerald-600">우상단 · 최우선 소싱</div>
          <div className="text-2xl font-bold text-emerald-700">{priority.length}</div>
          <div className="text-[11px] text-emerald-600">빠른 소진 + 안정 재입고</div>
        </div>
        <div className="rounded border border-red-200 bg-red-50 p-3">
          <div className="text-xs text-red-600">우하단 · 미발송 리스크</div>
          <div className="text-2xl font-bold text-red-700">{risky.length}</div>
          <div className="text-[11px] text-red-600">빠른 소진 + 불안정 재입고</div>
        </div>
        <div className="rounded border border-gray-200 bg-gray-50 p-3">
          <div className="text-xs text-gray-500">관측 대상</div>
          <div className="text-2xl font-bold text-gray-700">{rows.length}</div>
          <div className="text-[11px] text-gray-500">최근 90일 품절 이력 SKU</div>
        </div>
      </div>

      {/* 2D 산점도 보드 */}
      <div className="relative w-full rounded border border-gray-200 bg-white" style={{ height: 420 }}>
        {/* 사분면 배경 */}
        <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 pointer-events-none">
          <div className="border-r border-b border-dashed border-gray-200" />
          <div className="border-b border-dashed border-gray-200 bg-emerald-50/40" />
          <div className="border-r border-dashed border-gray-200" />
          <div className="bg-red-50/40" />
        </div>
        {/* 축 라벨 */}
        <span className="absolute top-1 right-2 text-[11px] font-semibold text-emerald-600">↑ 최우선 소싱</span>
        <span className="absolute bottom-1 right-2 text-[11px] font-semibold text-red-600">⚠ 미발송 리스크</span>
        <span className="absolute bottom-1 left-2 text-[11px] text-gray-400">셀스루 속도 →</span>
        <span className="absolute top-1 left-2 text-[11px] text-gray-400">재입고 신뢰도 ↑</span>

        {rows.map((r) => {
          const isRisk = r.sellthrough_velocity >= VEL_MID && r.restock_reliability < 50
          const isTop = r.sellthrough_velocity >= VEL_MID && r.restock_reliability >= 50
          const color = r.is_removed
            ? 'bg-gray-400'
            : isRisk
              ? 'bg-red-500'
              : isTop
                ? 'bg-emerald-500'
                : 'bg-amber-400'
          return (
            <a
              key={r.goods_no}
              href={r.detail_url ?? '#'}
              target="_blank"
              rel="noopener"
              title={`${r.title}\n셀스루 ${r.sellthrough_velocity}/30일 · 재입고신뢰도 ${r.restock_reliability}\n품절진입 ${r.soldout_entries}회 · 복귀 ${r.restock_count}회 · 리드 ${r.avg_restock_lead_days ?? '-'}일${r.is_removed ? '\n⚠ 영구이탈(removed)' : ''}`}
              className={`absolute -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${color} hover:ring-2 hover:ring-black/30 hover:scale-150 transition-transform`}
              style={{ left: `${xPct(r.sellthrough_velocity)}%`, top: `${yPct(r.restock_reliability)}%` }}
            />
          )
        })}
      </div>

      {/* 미발송 리스크 경고 테이블 */}
      {risky.length > 0 && (
        <div className="rounded border border-red-200 overflow-hidden">
          <div className="bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            ⚠ 미발송 리스크 — 주문 폭주 시 발송 불가 가능 ({risky.length})
          </div>
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-2 py-1 text-left">상품</th>
                <th className="px-2 py-1 text-right">셀스루/30일</th>
                <th className="px-2 py-1 text-right">재입고신뢰도</th>
                <th className="px-2 py-1 text-right">품절/복귀</th>
                <th className="px-2 py-1 text-right">평균리드</th>
              </tr>
            </thead>
            <tbody>
              {risky.slice(0, 30).map((r) => (
                <tr key={r.goods_no} className="border-t border-gray-100 hover:bg-red-50/50">
                  <td className="px-2 py-1">
                    <a href={r.detail_url ?? '#'} target="_blank" rel="noopener" className="hover:underline line-clamp-1" title={r.title}>
                      {r.is_removed && <span className="text-gray-400">[이탈] </span>}
                      {r.title}
                    </a>
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{r.sellthrough_velocity}</td>
                  <td className="px-2 py-1 text-right font-mono text-red-600">{r.restock_reliability}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.soldout_entries}/{r.restock_count}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.avg_restock_lead_days ?? '—'}일</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
