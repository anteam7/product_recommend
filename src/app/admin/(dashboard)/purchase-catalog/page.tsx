import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { CatalogTable, type CatalogRow } from './CatalogTable'
import { SOURCE_META, SOURCES } from './sources'

export const dynamic = 'force-dynamic'

// 매입 대상 상품 카탈로그 — 매입처(공급처) 5곳을 한 화면에서 비교하고, 미등록 상품을 골라 쿠팡에 일괄 등록한다.
// 데이터: public.jimscanner_purchase_catalog 뷰 (supabase/purchase_catalog.sql)
//   · 마진 = "최저판매가(MSP)로 팔았을 때" 기준. 원가 = 공급가(VAT포함) + 매입배송비 1건.
//   · 등록여부 = jimscanner_coupang_listings (source, source_goods_no) 조인 결과
// 일괄등록: /api/admin/register-jobs → jimscanner_register_jobs 큐 → 집 PC scripts/register-agent.mjs 가 실행

const VIEW = 'jimscanner_purchase_catalog'
const PAGE_SIZE = 50


const SORT_OPTIONS = [
  { v: 'margin_desc', label: '마진 높은순' },
  { v: 'margin_asc', label: '마진 낮은순' },
  { v: 'supply_desc', label: '공급가 높은순' },
  { v: 'supply_asc', label: '공급가 낮은순' },
  { v: 'title', label: '상품명순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const REG_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'no', label: '미등록' },
  { v: 'yes', label: '등록됨' },
] as const

interface Opts { source: string; reg: string; target: string; profit: string; q: string; sort: SortKey; page: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(query: any, o: Opts, opts: { withSource: boolean }) {
  let q = query
  if (opts.withSource && o.source) q = q.eq('source', o.source)
  if (o.reg === 'no') q = q.eq('is_registered', false)
  if (o.reg === 'yes') q = q.eq('is_registered', true)
  if (o.target === '1') q = q.eq('coupang_target', true)
  if (o.profit === '1') q = q.gt('msp_margin', 0)
  if (o.q) {
    // PostgREST or() 문법 보호 — 쉼표·괄호·% 는 필터 파싱을 깨뜨린다
    const safe = o.q.replace(/[,()%]/g, ' ').trim()
    if (safe) q = q.or(`title.ilike.%${safe}%,goods_no.ilike.%${safe}%,brand.ilike.%${safe}%`)
  }
  return q
}

async function fetchData(o: Opts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  let query = applyFilters(sb.from(VIEW).select('*', { count: 'exact' }), o, { withSource: true })
  switch (o.sort) {
    case 'margin_asc': query = query.order('msp_margin', { ascending: true, nullsFirst: false }); break
    case 'supply_desc': query = query.order('supply_price', { ascending: false, nullsFirst: false }); break
    case 'supply_asc': query = query.order('supply_price', { ascending: true, nullsFirst: false }); break
    case 'title': query = query.order('title', { ascending: true }); break
    default: query = query.order('msp_margin', { ascending: false, nullsFirst: false })
  }
  const offset = (o.page - 1) * PAGE_SIZE
  const { data, count, error } = await query.range(offset, offset + PAGE_SIZE - 1)
  if (error) return { rows: [] as CatalogRow[], total: 0, error: error.message }
  return { rows: (data ?? []) as CatalogRow[], total: count ?? 0, error: null as string | null }
}

async function fetchSourceCounts(o: Opts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const mk = (src: string | null) =>
    applyFilters(
      src ? sb.from(VIEW).select('goods_no', { count: 'exact', head: true }).eq('source', src)
          : sb.from(VIEW).select('goods_no', { count: 'exact', head: true }),
      o, { withSource: false },
    )
  const results = await Promise.all([mk(null), ...SOURCES.map((s) => mk(s))])
  const nums = results.map((r) => (r as { count: number | null }).count ?? 0)
  return { all: nums[0], bySource: Object.fromEntries(SOURCES.map((s, i) => [s, nums[i + 1]])) as Record<string, number> }
}

async function fetchQueue() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const { data } = await sb.from('jimscanner_register_jobs')
    .select('id, source, goods_no, status, error, seller_product_id, requested_at, finished_at')
    .order('requested_at', { ascending: false }).limit(20)
  return (data ?? []) as { id: string; source: string; goods_no: string; status: string; error: string | null; seller_product_id: number | null; requested_at: string; finished_at: string | null }[]
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) { if (v == null || v === '') params.delete(k); else params.set(k, v) }
  const qs = params.toString()
  return '/admin/purchase-catalog' + (qs ? `?${qs}` : '')
}

export default async function PurchaseCatalogPage({ searchParams }: {
  searchParams: Promise<{ source?: string; reg?: string; target?: string; profit?: string; q?: string; sort?: string; page?: string }>
}) {
  const sp = await searchParams
  const o: Opts = {
    source: SOURCES.includes(sp.source ?? '') ? (sp.source as string) : '',
    reg: ['no', 'yes'].includes(sp.reg ?? '') ? (sp.reg as string) : '',
    target: sp.target === '1' ? '1' : '',
    profit: sp.profit === '1' ? '1' : '',
    q: (sp.q ?? '').slice(0, 60),
    sort: (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'margin_desc') as SortKey,
    page: Math.max(1, parseInt(sp.page ?? '1', 10) || 1),
  }
  const current: Record<string, string> = { source: o.source, reg: o.reg, target: o.target, profit: o.profit, q: o.q, sort: o.sort, page: String(o.page) }

  const [{ rows, total, error }, counts, queue] = await Promise.all([fetchData(o), fetchSourceCounts(o), fetchQueue()])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const activeQueue = queue.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING')

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold">매입 대상 상품</h1>
        <p className="text-sm text-gray-500 mt-1">
          매입처별 공급가·최저판매가(MSP)·배송비와 <strong>MSP로 팔았을 때의 마진</strong>을 보고 등록할 상품을 고릅니다.
          미등록 상품을 체크해 쿠팡에 일괄 등록할 수 있습니다.
        </p>
      </div>

      {error && <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">조회 오류: {error}</div>}

      {/* 매입처 탭 */}
      <div className="flex flex-wrap gap-1 border-b">
        <Link href={buildHref(current, { source: null, page: null })}
          className={`px-3 py-2 text-sm border-b-2 ${!o.source ? 'border-gray-900 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
          전체 <span className="text-xs text-gray-400">{counts.all.toLocaleString()}</span>
        </Link>
        {SOURCES.map((s) => (
          <Link key={s} href={buildHref(current, { source: s, page: null })}
            className={`px-3 py-2 text-sm border-b-2 ${o.source === s ? 'border-gray-900 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
            {SOURCE_META[s].label} <span className="text-xs text-gray-400">{(counts.bySource[s] ?? 0).toLocaleString()}</span>
          </Link>
        ))}
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {REG_OPTIONS.map((r) => (
            <Link key={r.v} href={buildHref(current, { reg: r.v || null, page: null })}
              className={`px-2.5 py-1 rounded text-xs border ${o.reg === r.v ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {r.label}
            </Link>
          ))}
        </div>
        <Link href={buildHref(current, { target: o.target === '1' ? null : '1', page: null })}
          className={`px-2.5 py-1 rounded text-xs border ${o.target === '1' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          등록 가능한 것만
        </Link>
        <Link href={buildHref(current, { profit: o.profit === '1' ? null : '1', page: null })}
          className={`px-2.5 py-1 rounded text-xs border ${o.profit === '1' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
          MSP 마진 흑자만
        </Link>
        <form className="flex-1 min-w-[200px] max-w-sm" action="/admin/purchase-catalog">
          {o.source && <input type="hidden" name="source" value={o.source} />}
          {o.reg && <input type="hidden" name="reg" value={o.reg} />}
          {o.target && <input type="hidden" name="target" value={o.target} />}
          {o.profit && <input type="hidden" name="profit" value={o.profit} />}
          {o.sort !== 'margin_desc' && <input type="hidden" name="sort" value={o.sort} />}
          <input type="text" name="q" defaultValue={o.q} placeholder="상품명 · 상품번호 · 브랜드 검색"
            className="w-full rounded border px-3 py-1.5 text-sm" />
        </form>
        <div className="flex gap-1">
          {SORT_OPTIONS.map((s) => (
            <Link key={s.v} href={buildHref(current, { sort: s.v, page: null })}
              className={`px-2 py-1 rounded text-xs ${o.sort === s.v ? 'bg-gray-200 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 등록 큐 상태 */}
      {queue.length > 0 && (
        <div className="rounded border bg-gray-50 p-3 text-xs text-gray-600">
          <span className="font-medium">최근 등록 큐</span>
          {activeQueue.length > 0
            ? <span className="ml-2 text-amber-700">진행 중 {activeQueue.length}건 — 집 PC의 register-agent 가 처리합니다</span>
            : <span className="ml-2 text-gray-400">대기 중인 잡 없음</span>}
          <div className="mt-2 flex flex-wrap gap-1">
            {queue.slice(0, 12).map((j) => (
              <span key={j.id} title={j.error ?? ''}
                className={`px-1.5 py-0.5 rounded ${j.status === 'DONE' ? 'bg-emerald-100 text-emerald-700' : j.status === 'FAILED' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                {SOURCE_META[j.source]?.label ?? j.source} {j.goods_no} · {j.status}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="text-xs text-gray-500">
        {total.toLocaleString()}건 · {o.page}/{totalPages} 페이지
        <span className="ml-2 text-gray-400">
          마진 = MSP − (공급가 + 매입배송비) − 쿠팡수수료 − 순부가세. 수수료는 등록 카테고리별(영양제 7.6% / 그 외 식품 10.6%). 손익분기가 = 마진 0이 되는 판매가.
        </span>
      </div>

      <CatalogTable rows={rows} />

      {totalPages > 1 && (
        <div className="flex flex-wrap gap-1 pt-2">
          {o.page > 1 && (
            <Link href={buildHref(current, { page: String(o.page - 1) })} className="px-2 py-1 text-sm rounded border hover:bg-gray-50">이전</Link>
          )}
          {Array.from({ length: Math.min(totalPages, 12) }, (_, i) => {
            const start = Math.max(1, Math.min(o.page - 5, totalPages - 11))
            const p = start + i
            if (p > totalPages) return null
            return (
              <Link key={p} href={buildHref(current, { page: String(p) })}
                className={`px-2.5 py-1 text-sm rounded border ${p === o.page ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50'}`}>
                {p}
              </Link>
            )
          })}
          {o.page < totalPages && (
            <Link href={buildHref(current, { page: String(o.page + 1) })} className="px-2 py-1 text-sm rounded border hover:bg-gray-50">다음</Link>
          )}
        </div>
      )}
    </div>
  )
}
