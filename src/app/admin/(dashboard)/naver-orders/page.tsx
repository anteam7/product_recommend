import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PurchaseStatusCell } from './PurchaseStatusCell'
import { PurchaseCostCell } from './PurchaseCostCell'
import { InvoiceCell } from './InvoiceCell'
import PurchaseButton from './PurchaseButton'

export const dynamic = 'force-dynamic'

type PurchaseStatus = 'PENDING' | 'ORDERED' | 'SHIPPED' | 'RECEIVED' | 'CANCELLED'

interface OrderRow {
  id: string
  product_order_id: string
  order_id: string | null
  channel_product_no: string | null
  origin_product_no: number | null
  product_name: string
  option_name: string | null
  quantity: number
  total_payment_amount: number | null
  commission_amount: number | null
  product_order_status: string
  place_order_status: string | null
  payment_date: string | null
  order_date: string
  receiver_name: string | null
  receiver_phone: string | null
  receiver_address: string | null
  delivery_company: string | null
  tracking_number: string | null
  shipped_at: string | null
  purchase_status: PurchaseStatus
  purchase_ordered_at: string | null
  purchase_unit_cost: number | null
  purchase_total_cost: number | null
  supplier_order_no: string | null
  raw_payload?: { content?: { productOrder?: { shippingAddress?: { zipCode?: string } } } } | null
  // 조인: 매입처 바로가기 (listings.source: upickb2b | ggsan | manual)
  supplier_source?: string | null
  supplier_goods_no?: string | null
  supplier_url?: string | null
  receiver_zip_code?: string | null
}

// 드롭십 매입 흐름(쿠팡과 동일): 미발주 → 발주완료 → 매입처발송 → 발송완료 → 취소
const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, { label: string; cls: string }> = {
  PENDING: { label: '미발주', cls: 'bg-rose-100 text-rose-700' },
  ORDERED: { label: '발주완료', cls: 'bg-amber-100 text-amber-700' },
  SHIPPED: { label: '매입처발송', cls: 'bg-sky-100 text-sky-700' },
  RECEIVED: { label: '발송완료', cls: 'bg-emerald-100 text-emerald-700' },
  CANCELLED: { label: '취소', cls: 'bg-zinc-200 text-zinc-600' },
}

// 네이버 productOrderStatus (주요값만 — 미지정은 회색 원문 표시)
const NAVER_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  PAYMENT_WAITING: { label: '결제대기', cls: 'bg-gray-100 text-gray-600' },
  PAYED: { label: '결제완료', cls: 'bg-blue-100 text-blue-700' },
  DELIVERING: { label: '배송중', cls: 'bg-violet-100 text-violet-700' },
  DELIVERED: { label: '배송완료', cls: 'bg-emerald-100 text-emerald-700' },
  PURCHASE_DECIDED: { label: '구매확정', cls: 'bg-emerald-100 text-emerald-700' },
  EXCHANGED: { label: '교환', cls: 'bg-orange-100 text-orange-700' },
  CANCELED: { label: '취소', cls: 'bg-rose-100 text-rose-700' },
  RETURNED: { label: '반품', cls: 'bg-rose-100 text-rose-700' },
  CANCELED_BY_NOPAYMENT: { label: '미결제취소', cls: 'bg-zinc-200 text-zinc-600' },
}

const SORT_OPTIONS = [
  { v: 'recent', label: '최근 주문순' },
  { v: 'oldest', label: '오래된 주문순' },
  { v: 'price_desc', label: '결제금액 높은순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const SUPPLIER_LABELS: Record<string, string> = {
  ggsan: '건강산',
  upickb2b: '유픽B2B',
  manual: '수동',
}

const PAGE_SIZE = 50
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

function supplierUrl(source: string | null, goodsNo: string | null): string | null {
  if (!source || !goodsNo) return null
  if (source === 'ggsan') return `https://www.ggsan.com/goods/goods_view.php?goodsNo=${goodsNo}`
  if (source === 'upickb2b') return `https://upickb2b.com/product/x/${goodsNo}/category/1/display/1/`
  return null
}

async function fetchData(opts: {
  purchase_status: PurchaseStatus | ''
  naver_status: string
  q: string
  sort: SortKey
  page: number
  days: number
}) {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  let query = sb.from('jimscanner_naver_orders').select('*', { count: 'exact' })
  if (opts.purchase_status) query = query.eq('purchase_status', opts.purchase_status)
  if (opts.naver_status) query = query.eq('product_order_status', opts.naver_status)
  if (opts.q) query = query.ilike('product_name', `%${opts.q}%`)
  const cutoff = periodCutoff(opts.days)
  if (cutoff) query = query.gte('order_date', cutoff)

  switch (opts.sort) {
    case 'oldest': query = query.order('order_date', { ascending: true }); break
    case 'price_desc': query = query.order('total_payment_amount', { ascending: false, nullsFirst: false }); break
    case 'recent':
    default: query = query.order('order_date', { ascending: false })
  }
  const offset = (opts.page - 1) * PAGE_SIZE
  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  const rows = (data ?? []) as unknown as OrderRow[]

  // 매입처 바로가기: listings에서 source / source_goods_no 조인 (origin_product_no 매칭)
  const opnos = [...new Set(rows.map((r) => r.origin_product_no).filter(Boolean))] as number[]
  if (opnos.length > 0) {
    const { data: listings } = await sb
      .from('jimscanner_naver_listings')
      .select('origin_product_no, source, source_goods_no')
      .in('origin_product_no', opnos)
    const lmap = new Map<number, { source: string | null; source_goods_no: string | null }>(
      ((listings ?? []) as unknown as Array<{ origin_product_no: number; source: string | null; source_goods_no: string | null }>)
        .map((l) => [l.origin_product_no, l]),
    )
    for (const r of rows) {
      const l = r.origin_product_no ? lmap.get(r.origin_product_no) : undefined
      r.supplier_source = l?.source ?? null
      r.supplier_goods_no = l?.source_goods_no ?? null
      r.supplier_url = supplierUrl(l?.source ?? null, l?.source_goods_no ?? null)
    }
  }
  // 우편번호: raw_payload 중첩 구조에서 가공 (결제진행/표시용)
  for (const r of rows) {
    r.receiver_zip_code = r.raw_payload?.content?.productOrder?.shippingAddress?.zipCode ?? null
  }
  return { rows, total: count ?? 0 }
}

async function fetchMeta() {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const [{ count: total }, pStat] = await Promise.all([
    sb.from('jimscanner_naver_orders').select('*', { count: 'exact', head: true }),
    sb.from('jimscanner_naver_orders').select('purchase_status'),
  ])
  const byPurchase = new Map<string, number>()
  for (const r of (pStat.data ?? []) as unknown as { purchase_status: string }[]) {
    byPurchase.set(r.purchase_status, (byPurchase.get(r.purchase_status) ?? 0) + 1)
  }
  return { total: total ?? 0, byPurchase }
}

/** 지정 기간 실수익 합산 (취소 제외). 실수익 = 결제금액 − 매입원가 − 수수료(실값) − 부가세 */
async function fetchSummary(days: number) {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  let q = sb.from('jimscanner_naver_orders').select('total_payment_amount, commission_amount, purchase_total_cost, purchase_status, product_order_status')
  const cutoff = periodCutoff(days)
  if (cutoff) q = q.gte('order_date', cutoff)
  const { data } = await q
  const rows = (data ?? []) as unknown as Array<{
    total_payment_amount: number | null
    commission_amount: number | null
    purchase_total_cost: number | null
    purchase_status: string
    product_order_status: string
  }>
  let count = 0, revenue = 0, cost = 0, fee = 0, vat = 0, costMissing = 0
  for (const r of rows) {
    if (r.purchase_status === 'CANCELLED') continue
    if (['CANCELED', 'RETURNED', 'CANCELED_BY_NOPAYMENT'].includes(r.product_order_status)) continue
    count++
    const rev = r.total_payment_amount ?? 0
    revenue += rev
    fee += r.commission_amount ?? 0
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
  return '/admin/naver-orders' + (qs ? `?${qs}` : '')
}
function fmt(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}
function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

export default async function NaverOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string; status?: string; q?: string; sort?: string; page?: string; days?: string }>
}) {
  const sp = await searchParams
  const purchase_status = (Object.keys(PURCHASE_STATUS_LABELS).includes(sp.purchase ?? '') ? sp.purchase : '') as PurchaseStatus | ''
  const naver_status = Object.keys(NAVER_STATUS_LABELS).includes(sp.status ?? '') ? (sp.status as string) : ''
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'recent') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const daysRaw = parseInt(sp.days ?? '30', 10)
  const days = PERIOD_OPTIONS.some((p) => p.v === daysRaw) ? daysRaw : 30
  const current: Record<string, string> = { purchase: purchase_status, status: naver_status, q, sort, page: String(page), days: String(days) }

  const [{ rows, total }, meta, summary] = await Promise.all([
    fetchData({ purchase_status, naver_status, q, sort, page, days }),
    fetchMeta(),
    fetchSummary(days),
  ])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">네이버 주문 ↔ 매입 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            스마트스토어 주문이 들어오면 발주확인 → 매입처(유픽/건강산) 발주 → 발송까지 한 화면에서 추적 · 누적{' '}
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
              className={`px-2.5 py-1 text-xs rounded ${days === p.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              {p.label}
            </Link>
          ))}
          <span className="text-xs text-gray-400 ml-1">· 주문 {summary.count.toLocaleString()}건 (취소·반품 제외)</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi label="총 매출" value={`${summary.revenue.toLocaleString()}원`} />
          <Kpi label="총 매입원가" value={`${summary.cost.toLocaleString()}원`} />
          <Kpi label="수수료" value={`${summary.fee.toLocaleString()}원`} sub="네이버 실수수료 합" />
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
            purchase_status === '' ? 'border-emerald-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'
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
                purchase_status === s ? 'border-emerald-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'
              }`}
            >
              {PURCHASE_STATUS_LABELS[s].label} <span className="text-xs text-gray-400">{cnt}</span>
            </Link>
          )
        })}
      </nav>

      {/* 검색 + 정렬 */}
      <div className="flex flex-wrap items-center gap-3">
        <form className="flex-1 max-w-sm" action="/admin/naver-orders">
          {purchase_status && <input type="hidden" name="purchase" value={purchase_status} />}
          {naver_status && <input type="hidden" name="status" value={naver_status} />}
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
              <th className="px-3 py-2 text-right font-semibold">결제금액</th>
              <th className="px-3 py-2 text-right font-semibold">매입가</th>
              <th className="px-3 py-2 text-center font-semibold">매입 상태</th>
              <th className="px-3 py-2 text-center font-semibold">네이버 상태</th>
              <th className="px-3 py-2 text-left font-semibold">송장</th>
              <th className="px-3 py-2 text-center font-semibold">주문일</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-gray-400 text-sm">
                  아직 주문이 없습니다. 스마트스토어에서 주문이 들어오면 자동으로 추가됩니다 (매시간 수집).
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const ns = NAVER_STATUS_LABELS[r.product_order_status] ?? { label: r.product_order_status || '—', cls: 'bg-gray-100 text-gray-600' }
              const needsConfirm = r.product_order_status === 'PAYED' && r.place_order_status !== 'OK'
              return (
                <tr key={r.id} className="border-t hover:bg-emerald-50/30">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">{r.product_name}</div>
                    {r.option_name && <div className="text-[11px] text-gray-500 mt-0.5">{r.option_name}</div>}
                    <div className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>주문#{r.order_id} · 상품주문#{r.product_order_id}</span>
                      {r.supplier_url && (
                        <a
                          href={r.supplier_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold hover:bg-emerald-200"
                          title={`매입처(${SUPPLIER_LABELS[r.supplier_source ?? ''] ?? r.supplier_source ?? '미상'}) 상세페이지에서 매입`}
                        >
                          🛒 {SUPPLIER_LABELS[r.supplier_source ?? ''] ?? r.supplier_source ?? '매입처'} 매입{r.supplier_goods_no ? ` ${r.supplier_goods_no}` : ''} →
                        </a>
                      )}
                    </div>
                    {(r.receiver_name || r.receiver_address) && (
                      <div className="text-[11px] text-gray-600 mt-1">
                        📦 <span className="font-medium text-gray-800">{r.receiver_name ?? '-'}</span>
                        {r.receiver_zip_code ? <span className="text-gray-400"> ({r.receiver_zip_code})</span> : null}
                        {r.receiver_address ? <span> · {r.receiver_address}</span> : null}
                        {r.receiver_phone ? <span className="text-gray-400"> · {r.receiver_phone}</span> : null}
                      </div>
                    )}
                    {r.purchase_status === 'PENDING' && r.supplier_goods_no && ['ggsan', 'upickb2b'].includes(r.supplier_source ?? '') && (
                      <div className="mt-1">
                        <PurchaseButton orderId={r.product_order_id} />
                        <span className="text-[10px] text-gray-400 ml-1">헬퍼 꺼져 있으면 자동 기동</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{r.quantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmt(r.total_payment_amount)}</td>
                  <td className="px-3 py-2 text-right">
                    <PurchaseCostCell
                      id={r.id}
                      unitCost={r.purchase_unit_cost}
                      totalCost={r.purchase_total_cost}
                      quantity={r.quantity}
                      paymentAmount={r.total_payment_amount}
                      commissionAmount={r.commission_amount}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <PurchaseStatusCell
                      id={r.id}
                      productOrderId={r.product_order_id}
                      status={r.purchase_status}
                      orderedAt={r.purchase_ordered_at}
                      supplierOrderNo={r.supplier_order_no}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex flex-col items-center gap-1">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${ns.cls}`}>{ns.label}</span>
                      {needsConfirm ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-semibold" title="발주확인 전 — 매입 상태를 '발주완료'로 바꾸면 자동으로 발주확인됩니다">
                          ⚠ 발주확인 필요
                        </span>
                      ) : r.place_order_status === 'OK' ? (
                        <span className="text-[10px] text-emerald-600">✓ 발주확인</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <InvoiceCell
                      id={r.id}
                      trackingNumber={r.tracking_number}
                      deliveryCompany={r.delivery_company}
                      shippedAt={r.shipped_at}
                    />
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-gray-500">{fmtDate(r.order_date)}</td>
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
        ℹ️ 흐름: 네이버 주문 자동 수집(매시간 07분) → 매입 상태를 <strong>발주완료</strong>로 바꾸면 <strong>네이버 발주확인이 자동 호출</strong>됩니다 (⚠ 발주확인 필요 표시가 ✓로 바뀜) → 🛒 매입처 발주 → 송장 입력(내부 기록).
        <br />※ 송장의 <strong>네이버 발송처리는 아직 수동</strong>입니다 — 스마트스토어센터에서 발송처리하세요 (API 연동은 후속 예정).
        <br />※ <strong>💳 결제진행</strong>(미발주·매입처 연결 건): 클릭 시 매입처 주문서를 자동 작성하고 <strong>결제 직전에 멈춥니다</strong>(실결제는 직접). 로컬 헬퍼(127.0.0.1:39201)가 꺼져 있으면 <code>jimorder://</code> 프로토콜로 자동 기동 — 이 PC에서만 작동.
        <br />※ 실수익 = 결제금액 − 매입원가 − <strong>네이버 실수수료</strong>(주문 API 값) − 부가세(결제금액÷11). 쿠팡(요율 추정)과 달리 수수료 실값을 씁니다.
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
