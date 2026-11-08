/**
 * 통합 주문 ↔ 매입 로더 — 세 마켓 테이블을 각각 읽어 UnifiedOrder 로 정규화한다(서버 전용).
 * 규모(2026-10-13: 쿠팡 246·네이버 15·토스 0건)가 작아 마켓·기간만 DB에서 거르고 나머지(매입 상태·검색·정렬·페이지)는 메모리.
 * 수백 건을 넘더라도 PostgREST 1,000행 상한을 range 루프로 넘긴다. 커지면 UNION 뷰로 옮길 것.
 */
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  COUPANG_OPEN_CLAIM_STATUSES, COUPANG_STOP_REQUEST, MARKETS, coupangClaimBadge, coupangClaimTodo, normalizeCoupang, normalizeNaver, normalizeToss, periodCutoff,
  type CoupangClaimRow, type CoupangListingRef, type CoupangOrderRow, type InquiryRow, type Market, type NaverListingRef, type NaverOrderRow, type OpenClaim,
  type PeriodClaimRow, type PeriodCoupangActivity, type TossOrderRow, type UnifiedOrder,
} from './model'

/** 쿠팡 반품·취소 요청 — scripts/lib/coupang-orders-sync.mjs syncReturnRequests 가 주문 수집과 같은 회차에 갱신 */
const CLAIMS_TABLE = 'jimscanner_coupang_return_requests'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (t: string) => any }
const sb = (): Sb => createAdminClient() as unknown as Sb

const PG_PAGE = 1000
/** PostgREST 상한(1,000행) 우회 — 같은 쿼리를 range 로 끝까지 읽는다. */
async function fetchAll<T>(build: () => any, orderCol: string): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = []
  for (let from = 0; ; from += PG_PAGE) {
    const { data, error } = await build().order(orderCol, { ascending: false }).order('id', { ascending: true }).range(from, from + PG_PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PG_PAGE) break
  }
  return out
}

const ORDER_TABLE: Record<Market, { table: string; dateCol: string }> = {
  coupang: { table: 'jimscanner_coupang_orders', dateCol: 'ordered_at' },
  naver: { table: 'jimscanner_naver_orders', dateCol: 'order_date' },
  toss: { table: 'jimscanner_toss_orders', dateCol: 'ordered_at' },
}

async function loadCoupang(cutoff: string | null): Promise<UnifiedOrder[]> {
  const db = sb()
  const rows = await fetchAll<CoupangOrderRow>(() => {
    let q = db.from(ORDER_TABLE.coupang.table).select('*')
    if (cutoff) q = q.gte(ORDER_TABLE.coupang.dateCol, cutoff)
    return q
  }, ORDER_TABLE.coupang.dateCol)
  // 매입처 바로가기: 리스팅 조인(seller_product_id) — 주문별 오버라이드는 normalize 에서 우선 적용
  const spids = [...new Set(rows.map((r) => r.seller_product_id).filter(Boolean))] as number[]
  const lmap = new Map<number, CoupangListingRef>()
  if (spids.length > 0) {
    const { data, error } = await db.from('jimscanner_coupang_listings').select('seller_product_id, source, source_goods_no, source_detail_url').in('seller_product_id', spids)
    if (error) console.error('[orders] 쿠팡 listings 조인 실패 — 매입처 바로가기 생략:', error.message)
    for (const l of (data ?? []) as Array<CoupangListingRef & { seller_product_id: number }>) lmap.set(l.seller_product_id, l)
  }
  // 반품·취소 요청(출고중지요청 포함) — order_id 로 붙인다. 실패해도 주문 목록은 보여준다(배지·매출 제외만 빠짐)
  const claimsByOrder = new Map<string, CoupangClaimRow[]>()
  const orderIds = [...new Set(rows.map((r) => r.order_id).filter((v) => v != null))]
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await db.from(CLAIMS_TABLE)
      .select('receipt_id, order_id, receipt_type, receipt_status, release_stop_status, reason_category1, reason_category2, reason, cancel_count, fault_by_type, items, requested_at, completed_at')
      .in('order_id', orderIds.slice(i, i + 200))
    if (error) { console.error('[orders] 쿠팡 반품·취소 요청 조인 실패 — 배지 생략:', error.message); break }
    for (const c of (data ?? []) as CoupangClaimRow[]) {
      const k = String(c.order_id)
      if (!claimsByOrder.has(k)) claimsByOrder.set(k, [])
      claimsByOrder.get(k)!.push(c)
    }
  }
  return rows.map((r) => normalizeCoupang(r, r.seller_product_id ? lmap.get(r.seller_product_id) : null, claimsByOrder.get(String(r.order_id))))
}

async function loadNaver(cutoff: string | null): Promise<UnifiedOrder[]> {
  const db = sb()
  const rows = await fetchAll<NaverOrderRow>(() => {
    let q = db.from(ORDER_TABLE.naver.table).select('*')
    if (cutoff) q = q.gte(ORDER_TABLE.naver.dateCol, cutoff)
    return q
  }, ORDER_TABLE.naver.dateCol)
  const opnos = [...new Set(rows.map((r) => r.origin_product_no).filter(Boolean))] as number[]
  const lmap = new Map<number, NaverListingRef>()
  if (opnos.length > 0) {
    const { data, error } = await db.from('jimscanner_naver_listings').select('origin_product_no, source, source_goods_no').in('origin_product_no', opnos)
    if (error) console.error('[orders] 네이버 listings 조인 실패 — 매입처 바로가기 생략:', error.message)
    for (const l of (data ?? []) as Array<NaverListingRef & { origin_product_no: number }>) lmap.set(l.origin_product_no, l)
  }
  return rows.map((r) => normalizeNaver(r, r.origin_product_no ? lmap.get(r.origin_product_no) : null))
}

async function loadToss(cutoff: string | null): Promise<UnifiedOrder[]> {
  const db = sb()
  const rows = await fetchAll<TossOrderRow>(() => {
    let q = db.from(ORDER_TABLE.toss.table).select('*')
    if (cutoff) q = q.gte(ORDER_TABLE.toss.dateCol, cutoff)
    return q
  }, ORDER_TABLE.toss.dateCol)
  return rows.map(normalizeToss)
}

const LOADERS: Record<Market, (cutoff: string | null) => Promise<UnifiedOrder[]>> = { coupang: loadCoupang, naver: loadNaver, toss: loadToss }

/**
 * 선택 마켓의 기간 내 주문 전부(정규화). 한 마켓이 실패해도 나머지는 보여주고 errors 에 사유를 담는다
 * (DB 장애를 빈 목록으로 위장하지 않되, 토스 테이블 하나 때문에 쿠팡 주문까지 안 보이면 안 되므로).
 */
export async function loadOrders(markets: readonly Market[], days: number): Promise<{ orders: UnifiedOrder[]; errors: Partial<Record<Market, string>> }> {
  const cutoff = periodCutoff(days)
  const results = await Promise.allSettled(markets.map((m) => LOADERS[m](cutoff)))
  const orders: UnifiedOrder[] = []
  const errors: Partial<Record<Market, string>> = {}
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') orders.push(...r.value)
    else errors[markets[i]] = r.reason instanceof Error ? r.reason.message : String(r.reason)
  })
  return { orders, errors }
}

export interface MarketTodo {
  total: number; pending: number; awaiting: number; attention: number
  /** 쿠팡만: 진행 중 출고중지요청 / 그 밖의 반품 진행(반품접수·입고완료·쿠팡확인요청) 접수 수 */
  claimStop: number; claimReturn: number
}
/**
 * 마켓별 "처리 대기"(기간 무관, 전체 기간) — 미발주·입금대기·확인필요 건수. 기간 필터 밖의 미처리 주문을 놓치지 않기 위한 배너용.
 * head-count 쿼리라 1,000행 상한과 무관.
 */
export async function loadTodo(): Promise<Record<Market, MarketTodo>> {
  const db = sb()
  // 배너용 보조 수치라 실패해도 페이지를 죽이지 않는다(0으로 표시 + 서버 로그)
  const count = async (m: Market, apply?: (q: any) => any): Promise<number> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      let q = db.from(ORDER_TABLE[m].table).select('*', { count: 'exact', head: true })
      if (apply) q = apply(q)
      const { count: c, error } = await q
      if (error) { console.error(`[orders] ${m} 건수 조회 실패:`, error.message); return 0 }
      return c ?? 0
    } catch (e) {
      console.error(`[orders] ${m} 건수 조회 예외:`, e instanceof Error ? e.message : e)
      return 0
    }
  }
  const out = {} as Record<Market, MarketTodo>
  await Promise.all(MARKETS.map(async (m) => {
    const [total, pending, awaiting, attention] = await Promise.all([
      count(m),
      count(m, (q) => q.eq('purchase_status', 'PENDING')),
      count(m, (q) => q.eq('purchase_status', 'AWAITING_DEPOSIT')),
      count(m, (q) => q.eq('needs_attention', true)),
    ])
    out[m] = { total, pending, awaiting, attention, claimStop: 0, claimReturn: 0 }
  }))
  // 쿠팡 진행 중 반품·출고중지 접수(주문 기간과 무관)
  const claimCount = async (statuses: readonly string[]): Promise<number> => {
    try {
      const { count: c, error } = await db.from(CLAIMS_TABLE).select('*', { count: 'exact', head: true }).in('receipt_status', statuses as string[])
      if (error) { console.error('[orders] 쿠팡 반품·취소 요청 건수 조회 실패:', error.message); return 0 }
      return c ?? 0
    } catch (e) {
      console.error('[orders] 쿠팡 반품·취소 요청 건수 조회 예외:', e instanceof Error ? e.message : e)
      return 0
    }
  }
  const [stop, returning] = await Promise.all([
    claimCount([COUPANG_STOP_REQUEST]),
    claimCount(COUPANG_OPEN_CLAIM_STATUSES.filter((s) => s !== COUPANG_STOP_REQUEST)),
  ])
  out.coupang.claimStop = stop
  out.coupang.claimReturn = returning
  return out
}

/**
 * 진행 중 쿠팡 반품·출고중지 접수 + 주문 정보(상품명·매입 상태) — 관리자 상단 알림(/api/admin/coupang-claims)·주문 화면 패널.
 * 출고중지요청을 먼저, 그 안에서 최근 접수 순. 실패는 throw(호출부가 화면을 죽이지 않게 처리).
 */
export async function loadOpenClaims(limit = 50): Promise<{ stop: number; returning: number; items: OpenClaim[] }> {
  const db = sb()
  const { data, error } = await db.from(CLAIMS_TABLE)
    .select('receipt_id, order_id, receipt_type, receipt_status, reason_category1, reason_category2, reason, items, requested_at')
    .in('receipt_status', COUPANG_OPEN_CLAIM_STATUSES as string[])
    .order('requested_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  const claims = (data ?? []) as Array<Pick<CoupangClaimRow, 'receipt_id' | 'order_id' | 'receipt_type' | 'receipt_status' | 'reason_category1' | 'reason_category2' | 'reason' | 'items' | 'requested_at'>>
  const orderIds = [...new Set(claims.map((c) => c.order_id))]
  type O = { order_id: number; vendor_item_id: number | string | null; product_name: string | null; option_name: string | null; purchase_status: string | null }
  const byOrder = new Map<string, O[]>()
  if (orderIds.length > 0) {
    const { data: rows, error: oe } = await db.from('jimscanner_coupang_orders')
      .select('order_id, vendor_item_id, product_name, option_name, purchase_status').in('order_id', orderIds)
    if (oe) console.error('[orders] 반품·출고중지 주문 조인 실패 — 상품명 생략:', oe.message)
    for (const r of (rows ?? []) as O[]) {
      const k = String(r.order_id)
      if (!byOrder.has(k)) byOrder.set(k, [])
      byOrder.get(k)!.push(r)
    }
  }
  const items: OpenClaim[] = claims.map((c) => {
    const rows = byOrder.get(String(c.order_id)) ?? []
    const vids = new Set((c.items ?? []).map((i) => String(i.vendorItemId)))
    const o = rows.find((r) => vids.has(String(r.vendor_item_id))) ?? rows[0] ?? null
    const status = c.receipt_status ?? ''
    const b = coupangClaimBadge(c)
    return {
      receiptId: c.receipt_id,
      orderId: c.order_id,
      status,
      stop: status === COUPANG_STOP_REQUEST,
      label: b.label,
      cls: b.cls,
      productName: o?.product_name ?? null,
      optionName: o?.option_name ?? null,
      purchaseStatus: o?.purchase_status ?? null,
      reason: [c.reason_category1, c.reason_category2].filter(Boolean).join('/') || c.reason || '사유 없음',
      requestedAt: c.requested_at,
      todo: coupangClaimTodo(status, o?.purchase_status ?? null),
    }
  })
  items.sort((a, b) => Number(b.stop) - Number(a.stop) || String(b.requestedAt ?? '').localeCompare(String(a.requestedAt ?? '')))
  const stop = items.filter((i) => i.stop).length
  return { stop, returning: items.length - stop, items }
}

/**
 * 기간 카드용 쿠팡 반품·취소 접수(접수일 기준) + 고객문의(문의일 기준). 실패는 throw(호출부가 카드에 '조회 실패' 표시).
 * 문의는 scripts/lib/coupang-orders-sync.mjs syncInquiries 가 주문 수집과 같은 회차에 갱신.
 */
export async function loadPeriodCoupangActivity(days: number): Promise<PeriodCoupangActivity> {
  const db = sb()
  const cutoff = periodCutoff(days)
  const readAll = async <T,>(table: string, cols: string, dateCol: string, keyCols: string[]): Promise<T[]> => {
    const out: T[] = []
    for (let from = 0; ; from += PG_PAGE) {
      let q = db.from(table).select(cols)
      if (cutoff) q = q.gte(dateCol, cutoff)
      q = q.order(dateCol, { ascending: false })
      for (const k of keyCols) q = q.order(k, { ascending: true })
      const { data, error } = await q.range(from, from + PG_PAGE - 1)
      if (error) throw new Error(`${table}: ${error.message}`)
      const rows = (data ?? []) as T[]
      out.push(...rows)
      if (rows.length < PG_PAGE) break
    }
    return out
  }
  const [claims, inquiries] = await Promise.all([
    readAll<PeriodClaimRow>(CLAIMS_TABLE, 'receipt_id, receipt_type, receipt_status, items', 'requested_at', ['receipt_id']),
    readAll<InquiryRow>('jimscanner_coupang_inquiries', 'kind, inquiry_id, needs_answer', 'inquired_at', ['kind', 'inquiry_id']),
  ])
  return { claims, inquiries }
}

export interface SyncRun { started_at: string; status: string }
const SYNC_RUNS_TABLE: Record<Market, string> = {
  coupang: 'jimscanner_coupang_orders_sync_runs',
  naver: 'jimscanner_naver_orders_sync_runs',
  toss: 'jimscanner_toss_orders_sync_runs',
}
/** 마켓별 마지막 주문 수집 실행(헤더 표시용). 테이블 없음/실패는 null. */
export async function loadLastSync(): Promise<Record<Market, SyncRun | null>> {
  const db = sb()
  const out = {} as Record<Market, SyncRun | null>
  await Promise.all(MARKETS.map(async (m) => {
    try {
      const { data, error } = await db.from(SYNC_RUNS_TABLE[m]).select('started_at, status').order('started_at', { ascending: false }).limit(1)
      out[m] = error ? null : ((data?.[0] as SyncRun | undefined) ?? null)
    } catch { out[m] = null }
  }))
  return out
}
