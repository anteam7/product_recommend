/**
 * 통합 주문 ↔ 매입 모델 — 쿠팡·네이버·토스 주문을 한 화면에 합치기 위한 공통 형태 + 순수 함수(정규화·필터·정렬·집계).
 * DB 접근 없음(단위테스트 가능, model.test.ts). 로더는 data.ts, 화면은 page.tsx.
 *
 * 배경(2026-10-13 사용자 요청): 마켓별로 주문 메뉴가 나뉘어 있어 다른 마켓 주문을 놓치는 일이 반복 → 한 메뉴로 통합하고
 * 마켓 필터로 쿠팡만/네이버만/토스만 볼 수 있게. 매출·실수익 카드도 통합.
 */
import { netVat } from '@/lib/margin'
import { feeRateFor } from '@/lib/coupang/fee'
import { TOSS_FEE_RATE } from '@/lib/toss/fee'

// ─── 마켓 ───
export type Market = 'coupang' | 'naver' | 'toss'
export const MARKETS: readonly Market[] = ['coupang', 'naver', 'toss'] as const
export const MARKET_META: Record<Market, { label: string; icon: string; badgeCls: string; rowHover: string }> = {
  coupang: { label: '쿠팡', icon: '🅒', badgeCls: 'bg-amber-100 text-amber-800', rowHover: 'hover:bg-amber-50/40' },
  naver: { label: '네이버', icon: '🟢', badgeCls: 'bg-emerald-100 text-emerald-800', rowHover: 'hover:bg-emerald-50/40' },
  toss: { label: '토스', icon: '🔵', badgeCls: 'bg-blue-100 text-blue-800', rowHover: 'hover:bg-blue-50/40' },
}
export function isMarket(v: unknown): v is Market {
  return typeof v === 'string' && (MARKETS as readonly string[]).includes(v)
}

// ─── 매입(드롭십) 상태 — 세 마켓 공통 ───
// 미발주 → 입금대기(결제완주·무통장) → 발주완료(입금완료) → 매입처발송 → 발송완료 → 취소
export type PurchaseStatus = 'PENDING' | 'AWAITING_DEPOSIT' | 'ORDERED' | 'SHIPPED' | 'RECEIVED' | 'CANCELLED'
export const PURCHASE_STATUSES: readonly PurchaseStatus[] = ['PENDING', 'AWAITING_DEPOSIT', 'ORDERED', 'SHIPPED', 'RECEIVED', 'CANCELLED'] as const
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, { label: string; cls: string }> = {
  PENDING: { label: '미발주', cls: 'bg-rose-100 text-rose-700' },
  AWAITING_DEPOSIT: { label: '💰 입금대기', cls: 'bg-orange-100 text-orange-700' },
  ORDERED: { label: '발주완료', cls: 'bg-amber-100 text-amber-700' },
  SHIPPED: { label: '매입처발송', cls: 'bg-sky-100 text-sky-700' },
  RECEIVED: { label: '발송완료', cls: 'bg-emerald-100 text-emerald-700' },
  CANCELLED: { label: '취소', cls: 'bg-zinc-200 text-zinc-600' },
}
export function isPurchaseStatus(v: unknown): v is PurchaseStatus {
  return typeof v === 'string' && (PURCHASE_STATUSES as readonly string[]).includes(v)
}

// ─── 마켓별 주문 상태 라벨 (원문 코드 → 표시) ───
type Badge = { label: string; cls: string }
export const COUPANG_SHIPPING_LABELS: Record<string, Badge> = {
  ACCEPT: { label: '주문확인', cls: 'bg-blue-100 text-blue-700' },
  INSTRUCT: { label: '상품준비', cls: 'bg-blue-100 text-blue-700' },
  DEPARTURE: { label: '배송지시', cls: 'bg-indigo-100 text-indigo-700' },
  DELIVERING: { label: '배송중', cls: 'bg-violet-100 text-violet-700' },
  FINAL_DELIVERY: { label: '배송완료', cls: 'bg-emerald-100 text-emerald-700' },
  NONE_TRACKING: { label: '추적불가', cls: 'bg-gray-100 text-gray-600' },
  RETURNS: { label: '반품', cls: 'bg-rose-100 text-rose-700' },
  CANCEL: { label: '주문취소', cls: 'bg-zinc-200 text-zinc-600' }, // 목록 조회엔 안 나와 박스 단건 조회로 기록(2026-09-27)
}
export const NAVER_STATUS_LABELS: Record<string, Badge> = {
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
export const TOSS_STATUS_LABELS: Record<string, Badge> = {
  PAID: { label: '결제완료', cls: 'bg-blue-100 text-blue-700' },
  PREPARING_PRODUCT: { label: '상품준비중', cls: 'bg-indigo-100 text-indigo-700' },
  DELAY_SHIPPING: { label: '발송지연', cls: 'bg-amber-100 text-amber-700' },
  DELIVERING: { label: '배송중', cls: 'bg-sky-100 text-sky-700' },
  DELIVERED: { label: '배송완료', cls: 'bg-emerald-100 text-emerald-700' },
  CONFIRMED_ORDER: { label: '구매확정', cls: 'bg-emerald-200 text-emerald-800' },
  CANCELED_PAYMENT: { label: '결제취소', cls: 'bg-zinc-200 text-zinc-600' },
}
// 마켓 측 취소·반품 — 매출 집계에서 제외
const COUPANG_CANCELLED = new Set(['CANCEL', 'RETURNS'])
const NAVER_CANCELLED = new Set(['CANCELED', 'RETURNED', 'CANCELED_BY_NOPAYMENT'])
const TOSS_CANCELLED = new Set(['CANCELED_PAYMENT'])

const UNKNOWN_BADGE = (code: string | null): Badge => ({ label: code || '—', cls: 'bg-gray-100 text-gray-600' })
export function marketStatusBadge(o: UnifiedOrder): Badge {
  const code = o.marketStatus
  const table = o.market === 'coupang' ? COUPANG_SHIPPING_LABELS : o.market === 'naver' ? NAVER_STATUS_LABELS : TOSS_STATUS_LABELS
  return (code && table[code]) || UNKNOWN_BADGE(code)
}

// ─── 매입처 ───
export const SUPPLIER_LABELS: Record<string, string> = {
  ggsan: '건강산',
  upickb2b: '유픽B2B',
  domeggook: '도매꾹',
  bio77: '77바이오',
  wellroot: '웰루트',
  kwholesale: 'K홀세일',
  cmtstory: '화장품스토리',
  manual: '수동',
}
// order-server.mjs의 SUPPORTED_SOURCES와 반드시 동기화 — 여기 없으면 결제진행 버튼 자체가 안 그려짐
// (2026-09-02: bio77 추가 시 order-server.mjs만 고치고 여기를 안 고쳐서 버튼이 안 보이던 버그 재발 방지 메모)
export const PURCHASE_AUTOMATED_SOURCES: readonly string[] = ['ggsan', 'upickb2b', 'bio77', 'wellroot', 'kwholesale', 'cmtstory']

/** 매입처 상세 URL (listing.source_detail_url 없거나 주문별 오버라이드일 때) */
export function supplierUrl(source: string | null | undefined, goodsNo: string | null | undefined): string | null {
  if (!source || !goodsNo) return null
  const g = encodeURIComponent(goodsNo)
  if (source === 'ggsan') return `https://www.ggsan.com/goods/goods_view.php?goodsNo=${g}`
  if (source === 'upickb2b') return `https://upickb2b.com/product/x/${g}/category/1/display/1/`
  if (source === 'bio77') return `https://77bio.co.kr/goods/goods_view.php?goodsNo=${g}`
  if (source === 'wellroot') return `https://wellrootb2b.com/product/detail.html?product_no=${g}`
  if (source === 'kwholesale') return `https://kwholesale.co.kr/product/detail.html?product_no=${g}`
  if (source === 'cmtstory') return `https://www.cmtstory.com/goods/goods_view.php?goodsNo=${g}`
  return null
}

// ─── 통합 주문 ───
export type Fee = { kind: 'rate'; rate: number } | { kind: 'amount'; amount: number }

export interface Receiver {
  name: string | null
  zip: string | null
  address: string | null
  phone: string | null
}

/** 쿠팡 전용 셀 입력(GgsanTrackingCell·InvoiceCell·PurchaseStatusCell·DepositInfo) */
export interface CoupangExtra {
  orderId: number
  orderItemId: number
  ggsanOrderNo: string | null
  ggsanOrderStatus: string | null
  ggsanInvoiceNumber: string | null
  ggsanCarrierName: string | null
  ggsanShippedAt: string | null
  coupangInvoiceStatus: string | null
  invoiceNumber: string | null
  deliveryCompany: string | null
  shippedAt: string | null
}
/** 네이버 전용 셀 입력 */
export interface NaverExtra {
  productOrderId: string
  orderId: string | null
  placeOrderStatus: string | null
  claimStatus: string | null
  supplierOrderNo: string | null
  supplierOrderStatus: string | null
  supplierInvoiceNumber: string | null
  trackingNumber: string | null
  deliveryCompany: string | null
  shippedAt: string | null
  dispatchStatus: string | null
  dispatchError: string | null
}
/** 토스 전용 셀 입력 */
export interface TossExtra {
  orderProductId: number
  acknowledgedAt: string | null
  shippingDeadlineAt: string | null
  /** 발송기한 24h 이내(미발송 상태) — 토스 페널티 경고. 정규화 시점 기준(렌더 중 Date.now 금지) */
  deadlineSoon: boolean
  ggsanOrderNo: string | null
  ggsanOrderStatus: string | null
  ggsanInvoiceNumber: string | null
  ggsanCarrierName: string | null
  tossInvoiceStatus: string
}

export interface UnifiedOrder {
  market: Market
  /** 행 uuid — 각 마켓 update API의 id */
  id: string
  /** 결제진행·잡 키: 쿠팡 order_id / 네이버 product_order_id / 토스 order_product_id */
  orderKey: string
  /** 표기용 주문 식별 문자열 */
  orderLabel: string
  productName: string
  optionName: string | null
  quantity: number
  /** 묶음 옵션 수(쿠팡) — 매입 수량 = 주문 수량 × 묶음 수 */
  bundleSize: number
  /** 고객 결제금액(이 라인) */
  revenue: number | null
  purchaseStatus: PurchaseStatus
  purchaseOrderedAt: string | null
  purchaseUnitCost: number | null
  purchaseTotalCost: number | null
  purchaseNote: string | null
  /** 마켓 측 주문 상태 원문 코드 */
  marketStatus: string | null
  /** 마켓 측 취소·반품 → 매출 집계 제외 */
  marketCancelled: boolean
  orderedAt: string
  supplierSource: string | null
  supplierGoodsNo: string | null
  supplierUrl: string | null
  /** 이 주문만 매입처 변경(리스팅 매칭과 다름) */
  supplierOverridden: boolean
  receiver: Receiver | null
  fee: Fee
  needsAttention: boolean
  attentionReason: string | null
  coupang?: CoupangExtra
  naver?: NaverExtra
  toss?: TossExtra
}

// ─── 원본 행(필요 컬럼만) ───
export interface CoupangOrderRow {
  id: string
  order_id: number
  order_item_id: number
  seller_product_id: number | null
  vendor_item_id?: number | string | null
  product_name: string
  option_name: string | null
  shipping_count: number
  order_price: number | null
  purchase_status: PurchaseStatus
  purchase_ordered_at: string | null
  purchase_unit_cost: number | null
  purchase_total_cost: number | null
  purchase_note: string | null
  shipping_status: string
  invoice_number: string | null
  delivery_company: string | null
  shipped_at: string | null
  receiver_name: string | null
  ordered_at: string
  raw_payload?: {
    receiver?: { name?: string; postCode?: string; addr1?: string; addr2?: string; safeNumber?: string; receiverNumber?: string }
    orderItems?: Array<{ vendorItemId?: number | string; externalVendorSkuCode?: string | null }>
  } | null
  supplier_source?: string | null
  supplier_goods_no?: string | null
  ggsan_order_no?: string | null
  ggsan_order_status?: string | null
  ggsan_invoice_number?: string | null
  ggsan_carrier_name?: string | null
  ggsan_shipped_at?: string | null
  coupang_invoice_status?: string | null
  needs_attention?: boolean | null
  attention_reason?: string | null
}
export interface CoupangListingRef { source: string | null; source_goods_no: string | null; source_detail_url: string | null }

export interface NaverOrderRow {
  id: string
  product_order_id: string
  order_id: string | null
  origin_product_no: number | null
  product_name: string
  option_name: string | null
  quantity: number
  total_payment_amount: number | null
  commission_amount: number | null
  product_order_status: string
  place_order_status: string | null
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
  purchase_note?: string | null
  supplier_order_no: string | null
  claim_status?: string | null
  naver_dispatch_status?: string | null
  naver_dispatch_error?: string | null
  supplier_invoice_number?: string | null
  supplier_order_status?: string | null
  needs_attention?: boolean | null
  attention_reason?: string | null
  raw_payload?: { content?: { productOrder?: { shippingAddress?: { zipCode?: string } } } } | null
  supplier_source?: string | null
  supplier_goods_no?: string | null
}
export interface NaverListingRef { source: string | null; source_goods_no: string | null }

export interface TossOrderRow {
  id: string
  order_product_id: number
  order_id: number | null
  product_name: string | null
  option_name: string | null
  quantity: number
  /** 판매가×수량 (라인 결제액) */
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
  purchase_unit_cost?: number | null
  purchase_total_cost: number | null
  purchase_note?: string | null
  supplier_source: string | null
  supplier_goods_no: string | null
  ggsan_order_no: string | null
  ggsan_order_status: string | null
  ggsan_invoice_number: string | null
  ggsan_carrier_name: string | null
  toss_invoice_status: string
  needs_attention: boolean | null
  attention_reason: string | null
}

// 묶음 옵션의 묶음 수 — 원본 주문의 업체상품코드 접미사("450-2" → 2, "1000001234-B3" → 3), 앞부분이 매입처 상품번호일 때만.
// 동기화 지점: scripts/order-server.mjs coupangBundleSize (결제진행 매입 수량 = 주문 수량 × 묶음 수)
export function coupangBundleSize(r: Pick<CoupangOrderRow, 'raw_payload' | 'vendor_item_id'>, goodsNo: string | null): number {
  const items = r.raw_payload?.orderItems ?? []
  const it = items.find((x) => String(x?.vendorItemId) === String(r.vendor_item_id)) ?? (items.length === 1 ? items[0] : undefined)
  const m = /^(.+?)-B?(\d+)$/.exec(String(it?.externalVendorSkuCode ?? ''))
  if (!m || !goodsNo || m[1] !== String(goodsNo)) return 1
  const n = Number(m[2])
  return n >= 1 && n <= 20 ? n : 1
}

/**
 * 쿠팡 주문 → 통합. 매입처는 주문별 오버라이드(supplier_source+goods_no 둘 다) 우선, 없으면 리스팅 조인 폴백.
 * 수수료는 매입처별 요율(fee.ts feeRateFor) — 리스팅 카테고리 컬럼이 없어 매입처로 근사.
 */
export function normalizeCoupang(r: CoupangOrderRow, listing?: CoupangListingRef | null): UnifiedOrder {
  const overridden = !!(r.supplier_source && r.supplier_goods_no)
  const source = overridden ? r.supplier_source! : (listing?.source ?? null)
  const goodsNo = overridden ? r.supplier_goods_no! : (listing?.source_goods_no ?? null)
  const url = overridden ? supplierUrl(source, goodsNo) : (listing?.source_detail_url ?? supplierUrl(source, goodsNo))
  const rc = r.raw_payload?.receiver
  const address = rc ? [rc.addr1, rc.addr2].filter(Boolean).join(' ') : ''
  const receiver: Receiver | null = (r.receiver_name || address)
    ? { name: r.receiver_name ?? rc?.name ?? null, zip: rc?.postCode ?? null, address: address || null, phone: rc?.safeNumber ?? rc?.receiverNumber ?? null }
    : null
  return {
    market: 'coupang',
    id: r.id,
    orderKey: String(r.order_id),
    orderLabel: `order#${r.order_id} · item#${r.order_item_id}`,
    productName: r.product_name,
    optionName: r.option_name,
    quantity: r.shipping_count,
    bundleSize: overridden ? 1 : coupangBundleSize(r, goodsNo),
    revenue: r.order_price,
    purchaseStatus: r.purchase_status,
    purchaseOrderedAt: r.purchase_ordered_at,
    purchaseUnitCost: r.purchase_unit_cost,
    purchaseTotalCost: r.purchase_total_cost,
    purchaseNote: r.purchase_note,
    marketStatus: r.shipping_status ?? null,
    marketCancelled: COUPANG_CANCELLED.has(r.shipping_status ?? ''),
    orderedAt: r.ordered_at,
    supplierSource: source,
    supplierGoodsNo: goodsNo,
    supplierUrl: url,
    supplierOverridden: overridden,
    receiver,
    fee: { kind: 'rate', rate: feeRateFor(source) },
    needsAttention: !!r.needs_attention,
    attentionReason: r.attention_reason ?? null,
    coupang: {
      orderId: r.order_id,
      orderItemId: r.order_item_id,
      ggsanOrderNo: r.ggsan_order_no ?? null,
      ggsanOrderStatus: r.ggsan_order_status ?? null,
      ggsanInvoiceNumber: r.ggsan_invoice_number ?? null,
      ggsanCarrierName: r.ggsan_carrier_name ?? null,
      ggsanShippedAt: r.ggsan_shipped_at ?? null,
      coupangInvoiceStatus: r.coupang_invoice_status ?? null,
      invoiceNumber: r.invoice_number,
      deliveryCompany: r.delivery_company,
      shippedAt: r.shipped_at,
    },
  }
}

/** 네이버 주문 → 통합. 수수료는 주문 API 실값(commission_amount). */
export function normalizeNaver(r: NaverOrderRow, listing?: NaverListingRef | null): UnifiedOrder {
  const overridden = !!(r.supplier_source && r.supplier_goods_no)
  const source = overridden ? r.supplier_source! : (listing?.source ?? null)
  const goodsNo = overridden ? r.supplier_goods_no! : (listing?.source_goods_no ?? null)
  const receiver: Receiver | null = (r.receiver_name || r.receiver_address)
    ? { name: r.receiver_name, zip: r.raw_payload?.content?.productOrder?.shippingAddress?.zipCode ?? null, address: r.receiver_address, phone: r.receiver_phone }
    : null
  return {
    market: 'naver',
    id: r.id,
    orderKey: r.product_order_id,
    orderLabel: `주문#${r.order_id ?? '—'} · 상품주문#${r.product_order_id}`,
    productName: r.product_name,
    optionName: r.option_name,
    quantity: r.quantity,
    bundleSize: 1,
    revenue: r.total_payment_amount,
    purchaseStatus: r.purchase_status,
    purchaseOrderedAt: r.purchase_ordered_at,
    purchaseUnitCost: r.purchase_unit_cost,
    purchaseTotalCost: r.purchase_total_cost,
    purchaseNote: r.purchase_note ?? null,
    marketStatus: r.product_order_status ?? null,
    marketCancelled: NAVER_CANCELLED.has(r.product_order_status ?? ''),
    orderedAt: r.order_date,
    supplierSource: source,
    supplierGoodsNo: goodsNo,
    supplierUrl: supplierUrl(source, goodsNo),
    supplierOverridden: overridden,
    receiver,
    fee: { kind: 'amount', amount: r.commission_amount ?? 0 },
    needsAttention: !!r.needs_attention,
    attentionReason: r.attention_reason ?? null,
    naver: {
      productOrderId: r.product_order_id,
      orderId: r.order_id,
      placeOrderStatus: r.place_order_status,
      claimStatus: r.claim_status ?? null,
      supplierOrderNo: r.supplier_order_no,
      supplierOrderStatus: r.supplier_order_status ?? null,
      supplierInvoiceNumber: r.supplier_invoice_number ?? null,
      trackingNumber: r.tracking_number,
      deliveryCompany: r.delivery_company,
      shippedAt: r.shipped_at,
      dispatchStatus: r.naver_dispatch_status ?? null,
      dispatchError: r.naver_dispatch_error ?? null,
    },
  }
}

const TOSS_SHIPPED_STATUSES = new Set(['DELIVERING', 'DELIVERED', 'CONFIRMED_ORDER', 'CANCELED_PAYMENT'])

/** 토스 주문 → 통합. 매입처는 주문별 오버라이드 > item_management_code("{source}:{goods_no}"). 수수료 11% 추정. */
export function normalizeToss(r: TossOrderRow, now: number = Date.now()): UnifiedOrder {
  const overridden = !!(r.supplier_source && r.supplier_goods_no)
  let source: string | null = null, goodsNo: string | null = null
  if (overridden) { source = r.supplier_source; goodsNo = r.supplier_goods_no }
  else {
    const m = /^([a-z0-9]+):(.+)$/i.exec(r.item_management_code || '')
    source = m?.[1] ?? null; goodsNo = m?.[2] ?? null
  }
  const address = [r.receiver_address, r.receiver_address_detail].filter(Boolean).join(' ')
  const receiver: Receiver | null = (r.receiver_name || address)
    ? { name: r.receiver_name, zip: r.receiver_zip_code, address: address || null, phone: r.receiver_phone }
    : null
  return {
    market: 'toss',
    id: r.id,
    orderKey: String(r.order_product_id),
    orderLabel: `주문#${r.order_id ?? '—'} · 상품주문#${r.order_product_id}`,
    productName: r.product_name ?? '—',
    optionName: r.option_name,
    quantity: r.quantity,
    bundleSize: 1,
    revenue: r.price,
    purchaseStatus: r.purchase_status,
    purchaseOrderedAt: r.purchase_ordered_at,
    purchaseUnitCost: r.purchase_unit_cost ?? null,
    purchaseTotalCost: r.purchase_total_cost,
    purchaseNote: r.purchase_note ?? null,
    marketStatus: r.order_status,
    marketCancelled: TOSS_CANCELLED.has(r.order_status ?? ''),
    orderedAt: r.ordered_at ?? '',
    supplierSource: source,
    supplierGoodsNo: goodsNo,
    supplierUrl: supplierUrl(source, goodsNo),
    supplierOverridden: overridden,
    receiver,
    fee: { kind: 'rate', rate: TOSS_FEE_RATE },
    needsAttention: !!r.needs_attention,
    attentionReason: r.attention_reason,
    toss: {
      orderProductId: r.order_product_id,
      acknowledgedAt: r.acknowledged_at,
      shippingDeadlineAt: r.shipping_deadline_at,
      deadlineSoon: !!r.shipping_deadline_at && !TOSS_SHIPPED_STATUSES.has(r.order_status ?? '')
        && new Date(r.shipping_deadline_at).getTime() <= now + 24 * 3600 * 1000,
      ggsanOrderNo: r.ggsan_order_no,
      ggsanOrderStatus: r.ggsan_order_status,
      ggsanInvoiceNumber: r.ggsan_invoice_number,
      ggsanCarrierName: r.ggsan_carrier_name,
      tossInvoiceStatus: r.toss_invoice_status,
    },
  }
}

// ─── 집계 ───
/** 수수료 금액 — 쿠팡·토스는 요율×결제액, 네이버는 실값 */
export function feeAmount(o: Pick<UnifiedOrder, 'revenue' | 'fee'>): number {
  const rev = o.revenue ?? 0
  return o.fee.kind === 'rate' ? Math.round(rev * o.fee.rate) : o.fee.amount
}
/** 매출 집계 제외: 매입 취소 또는 마켓 측 취소·반품 */
export function isExcludedFromRevenue(o: Pick<UnifiedOrder, 'purchaseStatus' | 'marketCancelled'>): boolean {
  return o.purchaseStatus === 'CANCELLED' || o.marketCancelled
}

export interface Agg {
  count: number
  revenue: number
  cost: number
  fee: number
  vat: number
  net: number
  /** net / revenue × 100 (revenue 0이면 0) */
  netPct: number
  /** 매입원가 미입력 건수 — 원가 0으로 계산되어 실수익 과대 */
  costMissing: number
}
const emptyAgg = (): Agg => ({ count: 0, revenue: 0, cost: 0, fee: 0, vat: 0, net: 0, netPct: 0, costMissing: 0 })
function finish(a: Agg): Agg {
  a.net = a.revenue - a.cost - a.fee - a.vat
  a.netPct = a.revenue > 0 ? +((a.net / a.revenue) * 100).toFixed(1) : 0
  return a
}

/**
 * 기간 실수익 합산(취소·반품 제외). 실수익 = 결제금액 − 매입원가 − 수수료 − 납부부가세((결제금액−매입원가)÷11, margin.ts).
 * 전체 합계 + 마켓별 분해.
 */
export function summarize(orders: UnifiedOrder[]): { total: Agg; byMarket: Record<Market, Agg> } {
  const total = emptyAgg()
  const byMarket: Record<Market, Agg> = { coupang: emptyAgg(), naver: emptyAgg(), toss: emptyAgg() }
  for (const o of orders) {
    if (isExcludedFromRevenue(o)) continue
    const rev = o.revenue ?? 0
    const fee = feeAmount(o)
    const vat = netVat(rev, o.purchaseTotalCost)
    for (const a of [total, byMarket[o.market]]) {
      a.count++
      a.revenue += rev
      a.fee += fee
      a.vat += vat
      if (o.purchaseTotalCost != null) a.cost += o.purchaseTotalCost
      else a.costMissing++
    }
  }
  finish(total)
  for (const m of MARKETS) finish(byMarket[m])
  return { total, byMarket }
}

export function countByPurchase(orders: UnifiedOrder[]): Map<PurchaseStatus, number> {
  const m = new Map<PurchaseStatus, number>()
  for (const o of orders) m.set(o.purchaseStatus, (m.get(o.purchaseStatus) ?? 0) + 1)
  return m
}

// ─── 목록 파라미터·필터·정렬·페이지 ───
export const SORT_OPTIONS = [
  { v: 'recent', label: '최근 주문순' },
  { v: 'oldest', label: '오래된 주문순' },
  { v: 'price_desc', label: '결제금액 높은순' },
] as const
export type SortKey = (typeof SORT_OPTIONS)[number]['v']

export const PERIOD_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 30, label: '30일' },
  { v: 90, label: '90일' },
  { v: 0, label: '전체' },
] as const
export const DEFAULT_DAYS = 30
export const PAGE_SIZE = 50
export const ORDERS_PATH = '/admin/orders'

export function periodCutoff(days: number, now = Date.now()): string | null {
  return days > 0 ? new Date(now - days * 86400000).toISOString() : null
}

export interface ListParams {
  market: Market | ''
  purchase: PurchaseStatus | ''
  q: string
  sort: SortKey
  page: number
  days: number
}
export type RawSearchParams = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

export function parseParams(sp: RawSearchParams): ListParams {
  const market = first(sp.market)
  const purchase = first(sp.purchase)
  const sort = first(sp.sort)
  const daysRaw = parseInt(first(sp.days) || String(DEFAULT_DAYS), 10)
  return {
    market: isMarket(market) ? market : '',
    purchase: isPurchaseStatus(purchase) ? purchase : '',
    q: first(sp.q).trim(),
    sort: SORT_OPTIONS.some((s) => s.v === sort) ? (sort as SortKey) : 'recent',
    page: Math.max(1, parseInt(first(sp.page) || '1', 10) || 1),
    days: PERIOD_OPTIONS.some((p) => p.v === daysRaw) ? daysRaw : DEFAULT_DAYS,
  }
}

/** 목록 필터(매입 상태·상품명 검색). 마켓·기간은 로더에서 DB 측 적용. */
export function filterOrders(orders: UnifiedOrder[], p: Pick<ListParams, 'purchase' | 'q'>): UnifiedOrder[] {
  const q = p.q.toLowerCase()
  return orders.filter((o) => (!p.purchase || o.purchaseStatus === p.purchase) && (!q || o.productName.toLowerCase().includes(q)))
}

export function sortOrders(orders: UnifiedOrder[], sort: SortKey): UnifiedOrder[] {
  const arr = [...orders]
  switch (sort) {
    case 'oldest': return arr.sort((a, b) => a.orderedAt.localeCompare(b.orderedAt))
    case 'price_desc': return arr.sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.orderedAt.localeCompare(a.orderedAt))
    case 'recent':
    default: return arr.sort((a, b) => b.orderedAt.localeCompare(a.orderedAt))
  }
}

export function paginate<T>(items: T[], page: number, size = PAGE_SIZE): { rows: T[]; page: number; totalPages: number; total: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / size))
  const p = Math.min(Math.max(1, page), totalPages)
  return { rows: items.slice((p - 1) * size, p * size), page: p, totalPages, total: items.length }
}

/** 현재 파라미터 + 덮어쓰기 → 링크. null/''/기본값은 생략. */
export function buildHref(current: ListParams, override: Partial<Record<keyof ListParams, string | number | null>> = {}): string {
  const merged: Record<string, string | number | null> = { ...current, ...override }
  const params = new URLSearchParams()
  for (const k of ['market', 'purchase', 'q', 'sort', 'days', 'page'] as const) {
    const v = merged[k]
    if (v == null || v === '') continue
    if (k === 'sort' && v === 'recent') continue
    if (k === 'days' && Number(v) === DEFAULT_DAYS) continue
    if (k === 'page' && Number(v) <= 1) continue
    params.set(k, String(v))
  }
  const qs = params.toString()
  return ORDERS_PATH + (qs ? `?${qs}` : '')
}

/** 옛 마켓별 주문 페이지(/admin/{coupang,naver,toss}-orders) → 통합 페이지 링크. 기존 필터 파라미터 보존. */
export function legacyRedirectHref(market: Market, sp: RawSearchParams): string {
  const p = parseParams({ ...sp, market })
  return buildHref(p)
}

// ─── 표시 유틸 ───
export function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString()
}
export function fmtDate(s: string | null | undefined): string {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}
