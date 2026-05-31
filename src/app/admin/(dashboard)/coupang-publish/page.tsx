import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PriceCell } from './PriceCell'

export const dynamic = 'force-dynamic'

type Status =
  | 'DRAFT'
  | 'TEMPORARY_SAVE'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'SELLING'
  | 'STOPPED'
  | 'FAILED'
  | 'SKIPPED'

interface ListingRow {
  id: string
  seller_product_id: number | null
  product_id: number | null
  vendor_id: string
  source: string
  source_goods_no: string
  source_detail_url: string | null
  registered_title: string
  display_category_code: number
  display_category_name: string | null
  brand: string | null
  dome_price_krw: number
  source_shipping_fee_krw: number | null
  outbound_shipping_fee_krw: number | null
  msp_price_krw: number
  list_price_krw: number
  estimated_margin_krw: number | null
  estimated_margin_pct: number | null
  status: Status
  displayable: boolean
  approval_status_name: string | null
  rejection_reason: string | null
  sold_count: number | null
  registered_at: string | null
  last_synced_at: string | null
  created_at: string
}

const STATUS_LABELS: Record<Status, { label: string; cls: string }> = {
  DRAFT: { label: '대기', cls: 'bg-gray-100 text-gray-600' },
  TEMPORARY_SAVE: { label: '임시저장', cls: 'bg-amber-100 text-amber-700' },
  PENDING_APPROVAL: { label: '승인대기', cls: 'bg-blue-100 text-blue-700' },
  APPROVED: { label: '승인완료', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { label: '거절', cls: 'bg-rose-100 text-rose-700' },
  SELLING: { label: '판매중', cls: 'bg-green-100 text-green-700' },
  STOPPED: { label: '판매중지', cls: 'bg-zinc-200 text-zinc-700' },
  FAILED: { label: '실패', cls: 'bg-red-100 text-red-700' },
  SKIPPED: { label: '제외', cls: 'bg-zinc-100 text-zinc-500' },
}

const SORT_OPTIONS = [
  { v: 'recent', label: '최근 등록순' },
  { v: 'margin_desc', label: '마진율 높은순' },
  { v: 'list_price_desc', label: '판매가 높은순' },
  { v: 'dome_price_asc', label: '매입가 낮은순' },
  { v: 'title', label: '상품명 가나다순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 50

async function fetchData(opts: {
  status: Status | ''
  displayable: '1' | '0' | ''
  q: string
  sort: SortKey
  page: number
}) {
  // 신규 테이블 — generated types 갱신 전까지 임시 캐스팅
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  let query = sb.from('jimscanner_coupang_listings').select('*', { count: 'exact' })
  if (opts.status) query = query.eq('status', opts.status)
  if (opts.displayable === '1') query = query.eq('displayable', true)
  if (opts.displayable === '0') query = query.eq('displayable', false)
  if (opts.q) query = query.ilike('registered_title', `%${opts.q}%`)

  switch (opts.sort) {
    case 'margin_desc':
      query = query.order('estimated_margin_pct', { ascending: false, nullsFirst: false })
      break
    case 'list_price_desc':
      query = query.order('list_price_krw', { ascending: false })
      break
    case 'dome_price_asc':
      query = query.order('dome_price_krw', { ascending: true })
      break
    case 'title':
      query = query.order('registered_title', { ascending: true })
      break
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false })
  }

  const offset = (opts.page - 1) * PAGE_SIZE
  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  return { rows: (data ?? []) as unknown as ListingRow[], total: count ?? 0 }
}

async function fetchCronStatus() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const [stockRun, ordersRun, ordersAggResp, ordersCountResp] = await Promise.all([
    sb
      .from('jimscanner_coupang_stock_sync_runs')
      .select('started_at, status, total_checked, sold_out_count, resumed_count, error_count, duration_ms')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from('jimscanner_coupang_orders_sync_runs')
      .select('started_at, status, total_fetched, inserted_count, error_count, duration_ms')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from('jimscanner_coupang_orders')
      .select('last_synced_at')
      .order('last_synced_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    sb.from('jimscanner_coupang_orders').select('*', { count: 'exact', head: true }),
  ])
  return {
    stock: stockRun.data,
    // orders_sync_runs 테이블 생성 전이면 null → 위젯이 최근주문시각 fallback
    ordersRun: ordersRun.data ?? null,
    ordersLastSync: ordersAggResp.data?.last_synced_at ?? null,
    ordersTotal: ordersCountResp.count ?? 0,
  }
}

async function fetchMeta() {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const [{ count: total }, statusCounts, displayableCount] = await Promise.all([
    sb.from('jimscanner_coupang_listings').select('*', { count: 'exact', head: true }),
    sb.from('jimscanner_coupang_listings').select('status'),
    sb
      .from('jimscanner_coupang_listings')
      .select('*', { count: 'exact', head: true })
      .eq('displayable', true),
  ])

  const byStatus = new Map<string, number>()
  for (const r of (statusCounts.data ?? []) as unknown as { status: string }[]) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
  }
  return { total: total ?? 0, byStatus, displayable: displayableCount.count ?? 0 }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/coupang-publish' + (qs ? `?${qs}` : '')
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString()
}
function fmtDate(s: string | null | undefined) {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

export default async function CoupangPublishPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; displayable?: string; q?: string; sort?: string; page?: string }>
}) {
  const sp = await searchParams
  const status = ((Object.keys(STATUS_LABELS).includes(sp.status ?? '') ? sp.status : '') ?? '') as Status | ''
  const displayable = (sp.displayable === '1' || sp.displayable === '0' ? sp.displayable : '') as '1' | '0' | ''
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'recent') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const current: Record<string, string> = { status, displayable, q, sort, page: String(page) }

  const [{ rows, total }, meta, cronStatus] = await Promise.all([
    fetchData({ status, displayable, q, sort, page }),
    fetchMeta(),
    fetchCronStatus(),
  ])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">쿠팡 등록 상품 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            자동 등록된 상품의 매입가·MSP·판매가·노출 상태 관리 · 누적{' '}
            <strong>{meta.total.toLocaleString()}</strong>건 · 노출중{' '}
            <strong>{meta.displayable.toLocaleString()}</strong>건
          </p>
        </div>
      </header>

      {/* cron 위젯 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Stock sync */}
        <div className="bg-white border rounded p-3">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500">⏱ Stock-Sync (시간당)</span>
            {cronStatus.stock?.status === 'success' ? (
              <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">정상</span>
            ) : cronStatus.stock?.status === 'error' ? (
              <span className="text-[10px] bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded">에러</span>
            ) : (
              <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">대기</span>
            )}
          </div>
          {cronStatus.stock ? (
            <div className="text-xs text-gray-700 space-y-0.5">
              <div>마지막 실행: <strong>{fmtDate(cronStatus.stock.started_at)}</strong> ({((cronStatus.stock.duration_ms ?? 0) / 1000).toFixed(1)}s)</div>
              <div>
                체크 <strong>{cronStatus.stock.total_checked ?? 0}</strong> · 품절 {cronStatus.stock.sold_out_count ?? 0} · 재개 {cronStatus.stock.resumed_count ?? 0} · 에러 {cronStatus.stock.error_count ?? 0}
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-400">아직 실행 기록 없음</div>
          )}
        </div>

        {/* Orders sync */}
        <div className="bg-white border rounded p-3">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500">📦 Orders-Sync (시간당)</span>
            {cronStatus.ordersRun?.status === 'error' ? (
              <span className="text-[10px] bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded">에러</span>
            ) : cronStatus.ordersRun || cronStatus.ordersLastSync ? (
              <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">정상</span>
            ) : (
              <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">대기</span>
            )}
          </div>
          <div className="text-xs text-gray-700 space-y-0.5">
            {cronStatus.ordersRun ? (
              <>
                <div>마지막 실행: <strong>{fmtDate(cronStatus.ordersRun.started_at)}</strong> ({((cronStatus.ordersRun.duration_ms ?? 0) / 1000).toFixed(1)}s)</div>
                <div>조회 <strong>{cronStatus.ordersRun.total_fetched ?? 0}</strong> · 신규 {cronStatus.ordersRun.inserted_count ?? 0} · 에러 {cronStatus.ordersRun.error_count ?? 0}</div>
              </>
            ) : (
              <div>최근 주문 동기화: <strong>{fmtDate(cronStatus.ordersLastSync)}</strong></div>
            )}
            <div>누적 주문: <strong>{cronStatus.ordersTotal.toLocaleString()}</strong> · <a href="/admin/coupang-orders" className="text-blue-600 hover:underline">→ 주문 관리</a></div>
          </div>
        </div>
      </div>

      {/* 상태 필터 탭 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link
          href={buildHref(current, { status: null, page: null })}
          className={`px-3 py-2 text-sm border-b-2 ${
            status === '' ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'
          }`}
        >
          전체 <span className="text-xs text-gray-400">{meta.total}</span>
        </Link>
        {(Object.keys(STATUS_LABELS) as Status[]).map((s) => {
          const cnt = meta.byStatus.get(s) ?? 0
          if (cnt === 0 && status !== s) return null
          return (
            <Link
              key={s}
              href={buildHref(current, { status: s, page: null })}
              className={`px-3 py-2 text-sm border-b-2 ${
                status === s ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'
              }`}
            >
              {STATUS_LABELS[s].label} <span className="text-xs text-gray-400">{cnt}</span>
            </Link>
          )
        })}
      </nav>

      {/* 보조 필터 */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={buildHref(current, { displayable: displayable === '1' ? null : '1', page: null })}
          className={`px-3 py-1 text-xs rounded ${
            displayable === '1' ? 'bg-green-100 text-green-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {displayable === '1' ? '✓ ' : ''}노출중만
        </Link>
        <Link
          href={buildHref(current, { displayable: displayable === '0' ? null : '0', page: null })}
          className={`px-3 py-1 text-xs rounded ${
            displayable === '0' ? 'bg-zinc-200 text-zinc-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {displayable === '0' ? '✓ ' : ''}비노출만
        </Link>

        <form className="flex-1 max-w-sm" action="/admin/coupang-publish">
          {status && <input type="hidden" name="status" value={status} />}
          {displayable && <input type="hidden" name="displayable" value={displayable} />}
          {sort && <input type="hidden" name="sort" value={sort} />}
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
              className={`text-xs px-2 py-1 rounded ${
                sort === s.v ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 테이블 */}
      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-semibold w-[34%]">상품명</th>
              <th className="px-3 py-2 text-right font-semibold">매입가</th>
              <th className="px-3 py-2 text-right font-semibold">MSP</th>
              <th className="px-3 py-2 text-right font-semibold">판매가</th>
              <th className="px-3 py-2 text-right font-semibold">마진율</th>
              <th className="px-3 py-2 text-center font-semibold">상태</th>
              <th className="px-3 py-2 text-center font-semibold">노출</th>
              <th className="px-3 py-2 text-center font-semibold">링크</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-gray-400 text-sm">
                  아직 등록된 상품이 없습니다. 에이전트가 쿠팡 등록을 수행하면 자동으로 추가됩니다.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const sLabel = STATUS_LABELS[r.status]
              const coupangUrl = r.product_id
                ? `https://www.coupang.com/vp/products/${r.product_id}`
                : null
              return (
                <tr key={r.id} className="border-t hover:bg-amber-50/30">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2 flex items-center gap-1.5">
                      {r.source === 'manual' && (
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-700 font-semibold flex-none">수동</span>
                      )}
                      <span>{r.registered_title}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap gap-x-2">
                      {r.brand && <span>{r.brand}</span>}
                      {r.display_category_name && <span>· {r.display_category_name}</span>}
                      {r.source !== 'manual' && r.source_goods_no && <span>· goods_no={r.source_goods_no}</span>}
                      {r.seller_product_id && <span>· sellerPID={r.seller_product_id}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <PriceCell
                      id={r.id}
                      field="dome"
                      value={r.dome_price_krw}
                      shipping={(r.source_shipping_fee_krw ?? 0) + (r.outbound_shipping_fee_krw ?? 0)}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-rose-600 font-medium">{fmt(r.msp_price_krw)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <PriceCell
                      id={r.id}
                      field="list"
                      value={r.list_price_krw}
                      msp={r.msp_price_krw}
                      canPushCoupang={r.seller_product_id != null && (r.status === 'APPROVED' || r.status === 'SELLING')}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.estimated_margin_pct != null ? (
                      <span className={r.estimated_margin_pct >= 40 ? 'text-emerald-700 font-semibold' : 'text-gray-700'}>
                        {r.estimated_margin_pct.toFixed(1)}%
                      </span>
                    ) : (
                      '—'
                    )}
                    {r.estimated_margin_krw != null && (
                      <div className="text-[10px] text-gray-400">{fmt(r.estimated_margin_krw)}원</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${sLabel.cls}`}>{sLabel.label}</span>
                    {r.rejection_reason && (
                      <div className="text-[10px] text-rose-600 mt-1 line-clamp-2">{r.rejection_reason}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.displayable ? (
                      <span className="inline-block px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">노출중</span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded text-xs bg-zinc-100 text-zinc-600">OFF</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center text-xs">
                    <div className="flex flex-col gap-0.5 items-center">
                      {r.source_detail_url && (
                        <a
                          href={r.source_detail_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-amber-700 hover:underline"
                        >
                          매입처
                        </a>
                      )}
                      {coupangUrl && (
                        <a
                          href={coupangUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-blue-700 hover:underline"
                        >
                          쿠팡
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-1 text-sm">
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={buildHref(current, { page: String(p) })}
              className={`px-3 py-1 rounded ${page === p ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
