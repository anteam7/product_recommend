import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PurchaseStatusCell } from './PurchaseStatusCell'
import { PurchaseCostCell } from './PurchaseCostCell'
import { InvoiceCell } from './InvoiceCell'

export const dynamic = 'force-dynamic'

type PurchaseStatus = 'PENDING' | 'ORDERED' | 'RECEIVED' | 'CANCELLED'
type ShippingStatus =
  | 'ACCEPT'
  | 'INSTRUCT'
  | 'DEPARTURE'
  | 'DELIVERING'
  | 'FINAL_DELIVERY'
  | 'NONE_TRACKING'
  | 'RETURNS'

interface OrderRow {
  id: string
  order_id: number
  order_item_id: number
  shipment_box_id: number | null
  listing_id: string | null
  seller_product_id: number | null
  product_name: string
  option_name: string | null
  shipping_count: number
  sale_price: number | null
  order_price: number | null
  discount_amount: number | null
  delivery_charge: number | null
  purchase_status: PurchaseStatus
  purchase_ordered_at: string | null
  purchase_received_at: string | null
  purchase_unit_cost: number | null
  purchase_total_cost: number | null
  purchase_note: string | null
  shipping_status: ShippingStatus
  invoice_number: string | null
  delivery_company: string | null
  shipped_at: string | null
  delivered_at: string | null
  receiver_name: string | null
  paid_at: string | null
  paid_amount: number | null
  ordered_at: string
  last_synced_at: string | null
  raw_payload?: { receiver?: { name?: string; postCode?: string; addr1?: string; addr2?: string; safeNumber?: string; receiverNumber?: string } } | null
  // 조인: 매입처(ggsan) 바로가기용
  ggsan_goods_no?: string | null
  ggsan_url?: string | null
  // raw_payload.receiver 에서 가공(목록 표시용)
  receiver_zip_code?: string | null
  receiver_phone?: string | null
  receiver_address_full?: string | null
}

// 드롭십(ggsan 직배송): 미발주 → 발주완료 → 발송완료(운송장 등록) → 취소 ("입고" 단계 없음)
const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, { label: string; cls: string }> = {
  PENDING: { label: '미발주', cls: 'bg-rose-100 text-rose-700' },
  ORDERED: { label: '발주완료', cls: 'bg-amber-100 text-amber-700' },
  RECEIVED: { label: '발송완료', cls: 'bg-emerald-100 text-emerald-700' },
  CANCELLED: { label: '취소', cls: 'bg-zinc-200 text-zinc-600' },
}

const SHIPPING_STATUS_LABELS: Record<ShippingStatus, { label: string; cls: string }> = {
  ACCEPT: { label: '주문확인', cls: 'bg-blue-100 text-blue-700' },
  INSTRUCT: { label: '상품준비', cls: 'bg-blue-100 text-blue-700' },
  DEPARTURE: { label: '배송지시', cls: 'bg-indigo-100 text-indigo-700' },
  DELIVERING: { label: '배송중', cls: 'bg-violet-100 text-violet-700' },
  FINAL_DELIVERY: { label: '배송완료', cls: 'bg-emerald-100 text-emerald-700' },
  NONE_TRACKING: { label: '추적불가', cls: 'bg-gray-100 text-gray-600' },
  RETURNS: { label: '반품', cls: 'bg-rose-100 text-rose-700' },
}

const SORT_OPTIONS = [
  { v: 'recent', label: '최근 주문순' },
  { v: 'oldest', label: '오래된 주문순' },
  { v: 'price_desc', label: '주문금액 높은순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 50

// 실수익 = 매출 − 매입원가 − 수수료 − 부가세 (price.ts FEE_RATE와 동일 유지)
const FEE_RATE = 0.106
const VAT_DIVISOR = 11
const PERIOD_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 30, label: '30일' },
  { v: 90, label: '90일' },
  { v: 0, label: '전체' },
] as const

function periodCutoff(days: number): string | null {
  return days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null
}

async function fetchData(opts: {
  purchase_status: PurchaseStatus | ''
  shipping_status: ShippingStatus | ''
  q: string
  sort: SortKey
  page: number
  days: number
}) {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  let query = sb.from('jimscanner_coupang_orders').select('*', { count: 'exact' })
  if (opts.purchase_status) query = query.eq('purchase_status', opts.purchase_status)
  if (opts.shipping_status) query = query.eq('shipping_status', opts.shipping_status)
  if (opts.q) query = query.ilike('product_name', `%${opts.q}%`)
  const cutoff = periodCutoff(opts.days)
  if (cutoff) query = query.gte('ordered_at', cutoff)

  switch (opts.sort) {
    case 'oldest': query = query.order('ordered_at', { ascending: true }); break
    case 'price_desc': query = query.order('order_price', { ascending: false, nullsFirst: false }); break
    case 'recent':
    default: query = query.order('ordered_at', { ascending: false })
  }
  const offset = (opts.page - 1) * PAGE_SIZE
  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  const rows = (data ?? []) as unknown as OrderRow[]

  // 매입처(ggsan) 바로가기: listing에서 goods_no / detail_url 조인
  const spids = [...new Set(rows.map((r) => r.seller_product_id).filter(Boolean))] as number[]
  if (spids.length > 0) {
    const { data: listings } = await sb
      .from('jimscanner_coupang_listings')
      .select('seller_product_id, source_goods_no, source_detail_url')
      .in('seller_product_id', spids)
    const lmap = new Map<number, { source_goods_no: string | null; source_detail_url: string | null }>(
      ((listings ?? []) as unknown as Array<{ seller_product_id: number; source_goods_no: string | null; source_detail_url: string | null }>)
        .map((l) => [l.seller_product_id, l]),
    )
    for (const r of rows) {
      const l = r.seller_product_id ? lmap.get(r.seller_product_id) : undefined
      const goodsNo = l?.source_goods_no ?? null
      r.ggsan_goods_no = goodsNo
      r.ggsan_url = l?.source_detail_url
        ?? (goodsNo ? `https://www.ggsan.com/goods/goods_view.php?goodsNo=${goodsNo}` : null)
    }
  }
  // 수령인(배송지) 가공: raw_payload.receiver → 우편번호/전체주소/연락처 (목록 표시 + 결제진행용)
  for (const r of rows) {
    const rc = r.raw_payload?.receiver
    r.receiver_zip_code = rc?.postCode ?? null
    r.receiver_phone = rc?.safeNumber ?? rc?.receiverNumber ?? null
    r.receiver_address_full = rc ? [rc.addr1, rc.addr2].filter(Boolean).join(' ') : null
  }
  return { rows, total: count ?? 0 }
}

async function fetchMeta() {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const [{ count: total }, pStat] = await Promise.all([
    sb.from('jimscanner_coupang_orders').select('*', { count: 'exact', head: true }),
    sb.from('jimscanner_coupang_orders').select('purchase_status'),
  ])
  const byPurchase = new Map<string, number>()
  for (const r of (pStat.data ?? []) as unknown as { purchase_status: string }[]) {
    byPurchase.set(r.purchase_status, (byPurchase.get(r.purchase_status) ?? 0) + 1)
  }
  return { total: total ?? 0, byPurchase }
}

/** 지정 기간 실수익 합산 (취소 제외). 실수익 = 매출 − 매입원가 − 수수료(10.6%) − 부가세(÷11) */
async function fetchSummary(days: number) {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  let q = sb.from('jimscanner_coupang_orders').select('order_price, purchase_total_cost, purchase_status')
  const cutoff = periodCutoff(days)
  if (cutoff) q = q.gte('ordered_at', cutoff)
  const { data } = await q
  const rows = (data ?? []) as unknown as Array<{ order_price: number | null; purchase_total_cost: number | null; purchase_status: string }>
  let count = 0, revenue = 0, cost = 0, fee = 0, vat = 0, costMissing = 0
  for (const r of rows) {
    if (r.purchase_status === 'CANCELLED') continue
    count++
    const rev = r.order_price ?? 0
    revenue += rev
    fee += Math.round(rev * FEE_RATE)
    vat += Math.round(rev / VAT_DIVISOR)
    if (r.purchase_total_cost != null) cost += r.purchase_total_cost
    else costMissing++
  }
  return { count, revenue, cost, fee, vat, net: revenue - cost - fee - vat, costMissing }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/coupang-orders' + (qs ? `?${qs}` : '')
}
function fmt(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}
function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

export default async function CoupangOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string; shipping?: string; q?: string; sort?: string; page?: string; days?: string }>
}) {
  const sp = await searchParams
  const purchase_status = (Object.keys(PURCHASE_STATUS_LABELS).includes(sp.purchase ?? '') ? sp.purchase : '') as PurchaseStatus | ''
  const shipping_status = (Object.keys(SHIPPING_STATUS_LABELS).includes(sp.shipping ?? '') ? sp.shipping : '') as ShippingStatus | ''
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'recent') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const daysRaw = parseInt(sp.days ?? '30', 10)
  const days = PERIOD_OPTIONS.some((p) => p.v === daysRaw) ? daysRaw : 30
  const current: Record<string, string> = { purchase: purchase_status, shipping: shipping_status, q, sort, page: String(page), days: String(days) }

  const [{ rows, total }, meta, summary] = await Promise.all([
    fetchData({ purchase_status, shipping_status, q, sort, page, days }),
    fetchMeta(),
    fetchSummary(days),
  ])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">주문 ↔ 매입 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            쿠팡 주문이 들어오면 매입처(ggsan)에 발주 → 매입 입고 → 발송 → 정산까지 한 화면에서 추적 · 누적{' '}
            <strong>{meta.total.toLocaleString()}</strong>건
          </p>
        </div>
      </header>

      {/* 기간별 실수익 요약 */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {PERIOD_OPTIONS.map((p) => (
            <Link
              key={p.v}
              href={buildHref(current, { days: String(p.v), page: null })}
              className={`px-2.5 py-1 text-xs rounded ${days === p.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              {p.label}
            </Link>
          ))}
          <span className="text-xs text-gray-400 ml-1">· 주문 {summary.count.toLocaleString()}건 (취소 제외)</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi label="총 매출" value={`${summary.revenue.toLocaleString()}원`} />
          <Kpi label="총 매입원가" value={`${summary.cost.toLocaleString()}원`} />
          <Kpi label="수수료" value={`${summary.fee.toLocaleString()}원`} sub="판매수수료 10.6%" />
          <Kpi label="총 실수익 (부가세 포함)" value={`${(summary.net + summary.vat).toLocaleString()}원`} sub={`부가세 차감 전 (부가세 ${summary.vat.toLocaleString()})`} />
          <Kpi label="총 실수익 (부가세 제외)" value={`${summary.net.toLocaleString()}원`} sub={`부가세 −${summary.vat.toLocaleString()} 차감`} highlight positive={summary.net >= 0} />
        </div>
        {summary.costMissing > 0 && (
          <p className="text-[11px] text-amber-600">
            ⚠ 매입원가 미입력 <strong>{summary.costMissing}건</strong>은 원가 0으로 계산되어 실수익이 과대 표시됩니다. 매입가를 입력하면 정확해집니다.
          </p>
        )}
      </section>

      {/* 매입 상태 필터 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link
          href={buildHref(current, { purchase: null, page: null })}
          className={`px-3 py-2 text-sm border-b-2 ${
            purchase_status === '' ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'
          }`}
        >
          전체 <span className="text-xs text-gray-400">{meta.total}</span>
        </Link>
        {(Object.keys(PURCHASE_STATUS_LABELS) as PurchaseStatus[]).map((s) => {
          const cnt = meta.byPurchase.get(s) ?? 0
          if (cnt === 0 && purchase_status !== s) return null
          return (
            <Link
              key={s}
              href={buildHref(current, { purchase: s, page: null })}
              className={`px-3 py-2 text-sm border-b-2 ${
                purchase_status === s ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'
              }`}
            >
              {PURCHASE_STATUS_LABELS[s].label} <span className="text-xs text-gray-400">{cnt}</span>
            </Link>
          )
        })}
      </nav>

      {/* 보조 필터 + 검색 + 정렬 */}
      <div className="flex flex-wrap items-center gap-3">
        <form className="flex-1 max-w-sm" action="/admin/coupang-orders">
          {purchase_status && <input type="hidden" name="purchase" value={purchase_status} />}
          {shipping_status && <input type="hidden" name="shipping" value={shipping_status} />}
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
              <th className="px-3 py-2 text-left font-semibold w-[28%]">상품 / 옵션</th>
              <th className="px-3 py-2 text-center font-semibold">수량</th>
              <th className="px-3 py-2 text-right font-semibold">주문금액</th>
              <th className="px-3 py-2 text-right font-semibold">매입가</th>
              <th className="px-3 py-2 text-center font-semibold">매입 상태</th>
              <th className="px-3 py-2 text-center font-semibold">배송 상태</th>
              <th className="px-3 py-2 text-left font-semibold">송장</th>
              <th className="px-3 py-2 text-center font-semibold">주문일</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-gray-400 text-sm">
                  아직 주문이 없습니다. 쿠팡에서 주문이 들어오면 자동으로 추가됩니다.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const ss = SHIPPING_STATUS_LABELS[r.shipping_status]
              return (
                <tr key={r.id} className="border-t hover:bg-amber-50/30">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">{r.product_name}</div>
                    {r.option_name && <div className="text-[11px] text-gray-500 mt-0.5">{r.option_name}</div>}
                    <div className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>order#{r.order_id} · item#{r.order_item_id}</span>
                      {r.ggsan_url && (
                        <a
                          href={r.ggsan_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold hover:bg-amber-200"
                          title="건강산(ggsan) 상세페이지에서 매입"
                        >
                          🛒 건강산 매입{r.ggsan_goods_no ? ` ${r.ggsan_goods_no}` : ''} →
                        </a>
                      )}
                    </div>
                    {(r.receiver_name || r.receiver_address_full) && (
                      <div className="text-[11px] text-gray-600 mt-1">
                        📦 <span className="font-medium text-gray-800">{r.receiver_name ?? '-'}</span>
                        {r.receiver_zip_code ? <span className="text-gray-400"> ({r.receiver_zip_code})</span> : null}
                        {r.receiver_address_full ? <span> · {r.receiver_address_full}</span> : null}
                        {r.receiver_phone ? <span className="text-gray-400"> · {r.receiver_phone}</span> : null}
                      </div>
                    )}
                    {r.purchase_status === 'PENDING' && r.ggsan_goods_no && (
                      <div className="mt-1">
                        <a
                          href={`http://127.0.0.1:39201/order?id=${r.order_id}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700"
                          title="로컬 헬퍼로 ggsan 주문서 자동작성 → 결제 직전 정지(결제는 직접)"
                        >
                          💳 결제진행
                        </a>
                        <span className="text-[10px] text-gray-400 ml-1">로컬 헬퍼 실행 필요</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.shipping_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmt(r.order_price)}</td>
                  <td className="px-3 py-2 text-right">
                    <PurchaseCostCell
                      id={r.id}
                      unitCost={r.purchase_unit_cost}
                      totalCost={r.purchase_total_cost}
                      shippingCount={r.shipping_count}
                      orderPrice={r.order_price}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <PurchaseStatusCell
                      id={r.id}
                      status={r.purchase_status}
                      orderedAt={r.purchase_ordered_at}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${ss.cls}`}>{ss.label}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <InvoiceCell
                      id={r.id}
                      invoiceNumber={r.invoice_number}
                      deliveryCompany={r.delivery_company}
                      shippedAt={r.shipped_at}
                    />
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-gray-500">{fmtDate(r.ordered_at)}</td>
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
              className={`px-3 py-1 rounded ${
                page === p ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}

      <div className="text-xs text-gray-400 border-t pt-3 leading-relaxed">
        ℹ️ 흐름: 쿠팡 주문 자동 수집(매시간) → 🛒 건강산 매입 → 발주 상태/매입원가 입력(실수익 표시) → ggsan 직배송 후 받은 <strong>송장번호를 여기 입력하면 자동으로 &lsquo;발송완료&rsquo; 처리·발송일 기록</strong>됩니다.
        <br />※ 송장의 <strong>쿠팡 등록은 자동이 아니라 Wing에서 직접</strong> 하세요. 이 화면은 발송 추적·관리용입니다.
        <br />※ <strong>💳 결제진행</strong>(미발주·매입처 연결 건): 로컬 헬퍼(<code>node --env-file=.env.local scripts/order-server.mjs</code>)가 PC에 떠 있어야 작동 — 클릭 시 ggsan 주문서를 자동 작성하고 <strong>결제 직전에 멈춥니다</strong>(실결제는 직접).
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, highlight = false, positive = true }: { label: string; value: string; sub?: string; highlight?: boolean; positive?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? (positive ? 'border-emerald-300 bg-emerald-50' : 'border-rose-300 bg-rose-50') : 'border-gray-200 bg-white'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${highlight ? (positive ? 'text-emerald-700' : 'text-rose-600') : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5 tabular-nums">{sub}</div>}
    </div>
  )
}
