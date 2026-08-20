import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PurchaseCell } from './PurchaseCell'
import PurchaseButton from '../coupang-orders/PurchaseButton'

export const dynamic = 'force-dynamic'

// 토스쇼핑 주문 ↔ 매입 (쿠팡/네이버 페이지 미러 — P2)
// 수집·발주확인·ggsan 추적·송장 등록 = 로컬 크론(Toss-Orders-Sync, 매시간). 이 페이지는 추적/기록 UI.

type PurchaseStatus = 'PENDING' | 'AWAITING_DEPOSIT' | 'ORDERED' | 'SHIPPED' | 'RECEIVED' | 'CANCELLED'

interface OrderRow {
  id: string
  order_product_id: number
  order_id: number | null
  toss_product_id: number | null
  product_name: string | null
  option_name: string | null
  quantity: number
  price: number | null
  item_management_code: string | null
  order_status: string | null
  shipping_deadline_at: string | null
  acknowledged_at: string | null
  receiver_name: string | null
  receiver_phone: string | null
  receiver_address: string | null
  receiver_address_detail: string | null
  receiver_zip_code: string | null
  ordered_at: string | null
  purchase_status: PurchaseStatus
  purchase_ordered_at: string | null
  purchase_total_cost: number | null
  supplier_source: string | null
  supplier_goods_no: string | null
  ggsan_order_no: string | null
  ggsan_order_status: string | null
  ggsan_invoice_number: string | null
  ggsan_carrier_name: string | null
  toss_invoice_status: string
  needs_attention: boolean | null
  attention_reason: string | null
  // 조인 파생
  src?: string | null
  src_goods_no?: string | null
  src_url?: string | null
}

const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, { label: string; cls: string }> = {
  PENDING: { label: '미발주', cls: 'bg-rose-100 text-rose-700' },
  AWAITING_DEPOSIT: { label: '💰 입금대기', cls: 'bg-orange-100 text-orange-700' },
  ORDERED: { label: '발주완료', cls: 'bg-amber-100 text-amber-700' },
  SHIPPED: { label: '매입처발송', cls: 'bg-sky-100 text-sky-700' },
  RECEIVED: { label: '발송완료', cls: 'bg-emerald-100 text-emerald-700' },
  CANCELLED: { label: '취소', cls: 'bg-zinc-200 text-zinc-600' },
}

const ORDER_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  PAID: { label: '결제완료', cls: 'bg-blue-100 text-blue-700' },
  PREPARING_PRODUCT: { label: '상품준비중', cls: 'bg-indigo-100 text-indigo-700' },
  DELAY_SHIPPING: { label: '발송지연', cls: 'bg-amber-100 text-amber-700' },
  DELIVERING: { label: '배송중', cls: 'bg-sky-100 text-sky-700' },
  DELIVERED: { label: '배송완료', cls: 'bg-emerald-100 text-emerald-700' },
  CONFIRMED_ORDER: { label: '구매확정', cls: 'bg-emerald-200 text-emerald-800' },
  CANCELED_PAYMENT: { label: '결제취소', cls: 'bg-zinc-200 text-zinc-600' },
}

const SUPPLIER_LABELS: Record<string, string> = { ggsan: '건강산', upickb2b: '유픽B2B' }

function supplierUrl(source: string | null, goodsNo: string | null): string | null {
  if (!source || !goodsNo) return null
  const g = encodeURIComponent(goodsNo)
  if (source === 'ggsan') return `https://www.ggsan.com/goods/goods_view.php?goodsNo=${g}`
  if (source === 'upickb2b') return `https://upickb2b.com/product/x/${g}/category/1/display/1/`
  return null
}

const TOSS_FEE_RATE = 0.11 // 판매 8% + 결제 3% (VAT 별도)

function fmt(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}
function fmtDate(s: string | null) {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

async function fetchData(purchase: PurchaseStatus | '', page: number) {
  const sb = createAdminClient() as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  let q = sb.from('jimscanner_toss_orders').select('*', { count: 'exact' })
  if (purchase) q = q.eq('purchase_status', purchase)
  q = q.order('ordered_at', { ascending: false }).range((page - 1) * 50, page * 50 - 1)
  const { data, count, error } = await q
  if (error) throw new Error('토스 주문 조회 실패: ' + error.message) // DB 장애를 빈 목록으로 위장하지 않음
  const rows = (data ?? []) as OrderRow[]
  for (const r of rows) {
    // 매입처: 주문별 오버라이드 > item_management_code("{source}:{goods_no}")
    if (r.supplier_source && r.supplier_goods_no) {
      r.src = r.supplier_source; r.src_goods_no = r.supplier_goods_no
    } else {
      const m = /^([a-z0-9]+):(.+)$/i.exec(r.item_management_code || '')
      r.src = m?.[1] ?? null; r.src_goods_no = m?.[2] ?? null
    }
    r.src_url = supplierUrl(r.src ?? null, r.src_goods_no ?? null)
  }
  return { rows, total: count ?? rows.length }
}

async function fetchMeta() {
  const sb = createAdminClient() as unknown as { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const statuses = Object.keys(PURCHASE_STATUS_LABELS)
  const [{ count: total, error: totalErr }, { count: attention }, runs, ...perStatus] = await Promise.all([
    sb.from('jimscanner_toss_orders').select('*', { count: 'exact', head: true }),
    sb.from('jimscanner_toss_orders').select('*', { count: 'exact', head: true }).eq('needs_attention', true),
    sb.from('jimscanner_toss_orders_sync_runs').select('started_at,status,total_fetched,acked_count,invoice_ok,invoice_err,error_message').order('started_at', { ascending: false }).limit(1),
    // 상태별 head-count — 전행 select 의 PostgREST 1,000행 상한 회피
    ...statuses.map((s) => sb.from('jimscanner_toss_orders').select('*', { count: 'exact', head: true }).eq('purchase_status', s)),
  ])
  const byPurchase = new Map<string, number>()
  statuses.forEach((s, i) => byPurchase.set(s, perStatus[i]?.count ?? 0))
  return { total: total ?? 0, byPurchase, attentionCount: attention ?? 0, lastRun: runs.data?.[0] ?? null, dbError: totalErr?.message ?? null }
}

export default async function TossOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string; page?: string }>
}) {
  const sp = await searchParams
  const purchase = (Object.keys(PURCHASE_STATUS_LABELS).includes(sp.purchase ?? '') ? sp.purchase : '') as PurchaseStatus | ''
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const [{ rows, total }, meta] = await Promise.all([fetchData(purchase, page), fetchMeta()])
  const totalPages = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">토스쇼핑 주문 ↔ 매입</h1>
        <p className="text-sm text-gray-500 mt-1">
          매시간 크론이 주문 수집 → <strong>발주확인 자동</strong> → 발주(결제진행) → ggsan 송장 감지 → <strong>토스 송장 자동 등록</strong> · 누적 <strong>{meta.total.toLocaleString()}</strong>건
        </p>
        {meta.lastRun && (
          <p className="text-[11px] text-gray-400 mt-0.5">
            마지막 동기화 {fmtDate(meta.lastRun.started_at)} · {meta.lastRun.status} · 조회 {meta.lastRun.total_fetched ?? 0} · 발주확인 {meta.lastRun.acked_count ?? 0} · 송장등록 {meta.lastRun.invoice_ok ?? 0}건{meta.lastRun.invoice_err ? ` (실패 ${meta.lastRun.invoice_err})` : ''}
            {meta.lastRun.error_message ? ` · ${String(meta.lastRun.error_message).slice(0, 80)}` : ''}
          </p>
        )}
      </header>

      {meta.dbError && (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">DB 오류: {meta.dbError}</div>
      )}
      {meta.attentionCount > 0 && (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          ⚠ <strong>{meta.attentionCount}건</strong>이 사람 확인이 필요합니다 (매입처 취소/반품·택배사 미매핑·송장등록 실패 등).
        </div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link href="/admin/toss-orders" className={`px-3 py-1.5 text-sm rounded-t ${purchase === '' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}>
          전체 {meta.total}
        </Link>
        {(Object.entries(PURCHASE_STATUS_LABELS) as [PurchaseStatus, { label: string }][]).map(([k, v]) => (
          <Link key={k} href={`/admin/toss-orders?purchase=${k}`} className={`px-3 py-1.5 text-sm rounded-t ${purchase === k ? 'bg-blue-600 text-white font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}>
            {v.label} {meta.byPurchase.get(k) ?? 0}
          </Link>
        ))}
      </nav>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="px-3 py-2 text-left font-semibold">주문</th>
              <th className="px-3 py-2 text-left font-semibold">상품</th>
              <th className="px-3 py-2 text-right font-semibold">결제액</th>
              <th className="px-3 py-2 text-center font-semibold">토스 상태</th>
              <th className="px-3 py-2 text-center font-semibold">발송기한</th>
              <th className="px-3 py-2 text-center font-semibold">매입 상태</th>
              <th className="px-3 py-2 text-left font-semibold">매입처 추적</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400">주문이 없습니다</td></tr>
            )}
            {rows.map((r) => {
              const os = ORDER_STATUS_LABELS[r.order_status ?? ''] ?? { label: r.order_status ?? '—', cls: 'bg-gray-100 text-gray-600' }
              const deadlineSoon = r.shipping_deadline_at && !['DELIVERING', 'DELIVERED', 'CONFIRMED_ORDER', 'CANCELED_PAYMENT'].includes(r.order_status ?? '') && new Date(r.shipping_deadline_at) <= new Date(Date.now() + 24 * 3600 * 1000)
              const netEst = (r.price ?? 0) - (r.purchase_total_cost ?? 0) - Math.round((r.price ?? 0) * TOSS_FEE_RATE)
              return (
                <tr key={r.id} className="border-b border-gray-100 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                    <div className="tabular-nums">{fmtDate(r.ordered_at)}</div>
                    <div className="text-[10px] text-gray-400 tabular-nums">#{r.order_product_id}</div>
                  </td>
                  <td className="px-3 py-2 max-w-[320px]">
                    <div className="font-medium text-gray-900 line-clamp-2">{r.product_name ?? '—'}</div>
                    {r.option_name && <div className="text-[11px] text-gray-500">{r.option_name}</div>}
                    <div className="text-[11px] text-gray-500 mt-0.5">x{r.quantity}</div>
                    {(r.receiver_name || r.receiver_address) && (
                      <div className="text-[11px] text-gray-600 mt-1">
                        📦 <span className="font-medium text-gray-800">{r.receiver_name ?? '-'}</span>
                        {r.receiver_zip_code ? ` (${r.receiver_zip_code})` : ''} {r.receiver_address ?? ''} {r.receiver_address_detail ?? ''}
                        {r.receiver_phone ? ` · ${r.receiver_phone}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    <div>{fmt(r.price)}원</div>
                    {r.purchase_total_cost != null && (
                      <div className={`text-[11px] ${netEst >= 0 ? 'text-emerald-600' : 'text-rose-600'}`} title="결제액 − 매입합계 − 수수료 11%(추정)">
                        실익 {fmt(netEst)}원
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${os.cls}`}>{os.label}</span>
                    {r.acknowledged_at && <div className="text-[10px] text-gray-400 mt-0.5">발주확인 {fmtDate(r.acknowledged_at)}</div>}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <span className={`text-xs tabular-nums ${deadlineSoon ? 'text-rose-600 font-bold' : 'text-gray-600'}`}>
                      {r.shipping_deadline_at ?? '—'}{deadlineSoon ? ' ⚠' : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <PurchaseCell
                      id={r.id}
                      status={r.purchase_status}
                      orderedAt={r.purchase_ordered_at}
                      ggsanOrderNo={r.ggsan_order_no}
                      needsAttention={!!r.needs_attention}
                      attentionReason={r.attention_reason}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1 text-xs">
                      {r.src_url && (
                        <a href={r.src_url} target="_blank" rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold hover:bg-amber-200"
                          title={`매입처(${SUPPLIER_LABELS[r.src ?? ''] ?? r.src ?? '미상'}) 상세페이지`}>
                          🛒 {SUPPLIER_LABELS[r.src ?? ''] ?? r.src ?? '매입처'} {r.src_goods_no} →
                        </a>
                      )}
                      {r.purchase_status === 'PENDING' && r.src_goods_no && ['ggsan', 'upickb2b'].includes(r.src ?? '') && (
                        <PurchaseButton orderId={r.order_product_id} />
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1 space-y-0.5">
                      {r.ggsan_order_status && <div>매입처 상태: {r.ggsan_order_status}</div>}
                      {r.ggsan_invoice_number && (
                        <div>송장 {r.ggsan_carrier_name ?? '?'} {r.ggsan_invoice_number}{' '}
                          {r.toss_invoice_status === 'registered' ? <span className="text-emerald-600">✓토스등록</span>
                            : r.toss_invoice_status === 'failed' ? <span className="text-rose-600">✗등록실패</span>
                            : <span className="text-amber-600">등록대기</span>}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex gap-2 text-sm">
          {page > 1 && <Link className="px-2 py-1 rounded bg-gray-100" href={`/admin/toss-orders?${purchase ? `purchase=${purchase}&` : ''}page=${page - 1}`}>← 이전</Link>}
          <span className="px-2 py-1 text-gray-500">{page} / {totalPages}</span>
          {page < totalPages && <Link className="px-2 py-1 rounded bg-gray-100" href={`/admin/toss-orders?${purchase ? `purchase=${purchase}&` : ''}page=${page + 1}`}>다음 →</Link>}
        </div>
      )}

      <footer className="text-[11px] text-gray-400 border-t border-gray-100 pt-3 leading-relaxed">
        ℹ️ 흐름: 토스 주문 자동 수집·<strong>발주확인 자동</strong>(매시간, 로컬 크론) → 💳 결제진행(건강산/유픽 자동주문) → 발주완료 후 <strong>매입처 주문번호 입력</strong> → 크론이 ggsan 송장 감지 시 <strong>토스에 자동 등록</strong>(배송중 전환).
        <br />※ 발송기한(영업일) 초과는 토스 페널티(1점/건, 30일 10점 = 이용정지) — ⚠ 표시가 뜨면 우선 처리하세요. 토스 API는 IP 허용제라 크론은 집 PC에서만 동작합니다.
      </footer>
    </div>
  )
}
