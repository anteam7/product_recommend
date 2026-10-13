/**
 * 통합 주문 ↔ 매입 로더 — 세 마켓 테이블을 각각 읽어 UnifiedOrder 로 정규화한다(서버 전용).
 * 규모(2026-10-13: 쿠팡 246·네이버 15·토스 0건)가 작아 마켓·기간만 DB에서 거르고 나머지(매입 상태·검색·정렬·페이지)는 메모리.
 * 수백 건을 넘더라도 PostgREST 1,000행 상한을 range 루프로 넘긴다. 커지면 UNION 뷰로 옮길 것.
 */
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  MARKETS, normalizeCoupang, normalizeNaver, normalizeToss, periodCutoff,
  type CoupangListingRef, type CoupangOrderRow, type Market, type NaverListingRef, type NaverOrderRow, type TossOrderRow, type UnifiedOrder,
} from './model'

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
  return rows.map((r) => normalizeCoupang(r, r.seller_product_id ? lmap.get(r.seller_product_id) : null))
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

export interface MarketTodo { total: number; pending: number; awaiting: number; attention: number }
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
    out[m] = { total, pending, awaiting, attention }
  }))
  return out
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
