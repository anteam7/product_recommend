import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MarginRow {
  listing_id: string
  registered_title: string
  display_category_code: number | null
  display_category_name: string | null
  brand: string | null
  dome_price_krw: number | null
  list_price_krw: number | null
  estimated_margin_krw: number | null
  estimated_margin_pct: number | null
  order_count: number
  return_count: number
  revenue_total_krw: number
  purchase_total_krw: number
  delivery_total_krw: number
  coupang_fee_total_krw: number
  return_loss_total_krw: number
  realized_margin_total_krw: number
  realized_margin_pct: number | null
  drift_pct: number | null
  delivery_share_pct: number | null
  coupang_fee_share_pct: number | null
  return_loss_share_pct: number | null
  last_ordered_at: string | null
}

const SORT_OPTIONS = [
  { v: 'drift_neg', label: '드리프트 큰 손실순' },
  { v: 'drift_pos', label: '드리프트 큰 이익순' },
  { v: 'drift_abs', label: '드리프트 절대값순' },
  { v: 'revenue_desc', label: '매출 높은순' },
  { v: 'orders_desc', label: '주문 많은순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 100
const WARN_DRIFT_THRESHOLD = -3 // 카테고리 평균 드리프트가 -3%p 미만이면 경고

async function fetchAll(): Promise<MarginRow[]> {
  // 신규 view — generated types 갱신 전까지 임시 캐스팅
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const { data } = await sb
    .from('jimscanner_coupang_margin_realized')
    .select('*')
    .limit(2000)
  return (data ?? []) as unknown as MarginRow[]
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString()
}

function fmtPct(n: number | null | undefined, digits = 1) {
  if (n == null) return '—'
  return `${n.toFixed(digits)}%`
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function driftClass(drift: number | null | undefined) {
  if (drift == null) return 'text-gray-400'
  if (drift <= -10) return 'text-rose-700 font-semibold'
  if (drift <= -3) return 'text-rose-600'
  if (drift >= 10) return 'text-emerald-700 font-semibold'
  if (drift >= 3) return 'text-emerald-600'
  return 'text-gray-700'
}

function inferHypothesis(r: MarginRow): { label: string; tone: string } | null {
  // 드리프트 outlier 의 비용 분해 비중을 보고 가장 그럴듯한 가설을 라벨로 붙인다.
  // (LLM 분류 잡으로 대체 가능하지만, 첫 패스는 룰베이스로 핀 라벨링.)
  if (r.drift_pct == null || r.drift_pct >= -3) return null
  const dShare = r.delivery_share_pct ?? 0
  const rShare = r.return_loss_share_pct ?? 0
  const cShare = r.coupang_fee_share_pct ?? 0
  const candidates: Array<{ v: number; label: string; tone: string }> = [
    { v: rShare, label: '반품 과다', tone: 'bg-rose-100 text-rose-700' },
    { v: dShare - 5, label: '아웃바운드 배송비 과소추정', tone: 'bg-amber-100 text-amber-700' },
    { v: cShare - 10, label: '쿠팡 카테고리 수수료 과소추정', tone: 'bg-indigo-100 text-indigo-700' },
  ]
  candidates.sort((a, b) => b.v - a.v)
  if (candidates[0].v <= 0) {
    return { label: '매입가 상승 / 판매가 하향', tone: 'bg-zinc-100 text-zinc-700' }
  }
  return { label: candidates[0].label, tone: candidates[0].tone }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/coupang-margin-drift' + (qs ? `?${qs}` : '')
}

export default async function CoupangMarginDriftPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; category?: string; warn_only?: string }>
}) {
  const sp = await searchParams
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'drift_neg') as SortKey
  const categoryFilter = sp.category ?? ''
  const warnOnly = sp.warn_only === '1'
  const current: Record<string, string> = { sort, category: categoryFilter, warn_only: warnOnly ? '1' : '' }

  const all = await fetchAll()

  // 카테고리 집계
  type CatAgg = {
    code: number | null
    name: string
    sku_count: number
    order_count: number
    revenue: number
    drifts: number[]
    realized_pcts: number[]
    estimated_pcts: number[]
  }
  const catMap = new Map<string, CatAgg>()
  for (const r of all) {
    const key = `${r.display_category_code ?? 0}|${r.display_category_name ?? '(미분류)'}`
    let agg = catMap.get(key)
    if (!agg) {
      agg = {
        code: r.display_category_code,
        name: r.display_category_name ?? '(미분류)',
        sku_count: 0,
        order_count: 0,
        revenue: 0,
        drifts: [],
        realized_pcts: [],
        estimated_pcts: [],
      }
      catMap.set(key, agg)
    }
    agg.sku_count += 1
    agg.order_count += r.order_count
    agg.revenue += r.revenue_total_krw
    if (r.drift_pct != null) agg.drifts.push(r.drift_pct)
    if (r.realized_margin_pct != null) agg.realized_pcts.push(r.realized_margin_pct)
    if (r.estimated_margin_pct != null) agg.estimated_pcts.push(r.estimated_margin_pct)
  }
  const categories = Array.from(catMap.values()).map((c) => {
    const avg = c.drifts.length > 0 ? c.drifts.reduce((a, b) => a + b, 0) / c.drifts.length : null
    const med = median(c.drifts)
    return {
      ...c,
      avg_drift_pct: avg != null ? Math.round(avg * 100) / 100 : null,
      median_drift_pct: med != null ? Math.round(med * 100) / 100 : null,
      warned: avg != null && avg < WARN_DRIFT_THRESHOLD,
    }
  })
  categories.sort((a, b) => {
    const av = a.avg_drift_pct ?? Number.POSITIVE_INFINITY
    const bv = b.avg_drift_pct ?? Number.POSITIVE_INFINITY
    return av - bv
  })

  // 행 필터 + 정렬
  let rows = all
  if (categoryFilter) {
    rows = rows.filter((r) => String(r.display_category_code ?? 0) === categoryFilter)
  }
  if (warnOnly) {
    rows = rows.filter((r) => r.drift_pct != null && r.drift_pct < WARN_DRIFT_THRESHOLD)
  }

  const sorter: Record<SortKey, (a: MarginRow, b: MarginRow) => number> = {
    drift_neg: (a, b) => (a.drift_pct ?? 0) - (b.drift_pct ?? 0),
    drift_pos: (a, b) => (b.drift_pct ?? 0) - (a.drift_pct ?? 0),
    drift_abs: (a, b) => Math.abs(b.drift_pct ?? 0) - Math.abs(a.drift_pct ?? 0),
    revenue_desc: (a, b) => b.revenue_total_krw - a.revenue_total_krw,
    orders_desc: (a, b) => b.order_count - a.order_count,
  }
  rows = [...rows].sort(sorter[sort])

  // KPI
  const skusWithOrders = all.filter((r) => r.order_count > 0)
  const driftValues = skusWithOrders.map((r) => r.drift_pct).filter((v): v is number => v != null)
  const avgDrift = driftValues.length > 0 ? driftValues.reduce((a, b) => a + b, 0) / driftValues.length : null
  const medDrift = median(driftValues)
  const warnedCategoryCount = categories.filter((c) => c.warned).length
  const totalRevenue = skusWithOrders.reduce((a, b) => a + b.revenue_total_krw, 0)
  const totalRealized = skusWithOrders.reduce((a, b) => a + b.realized_margin_total_krw, 0)

  // 산점도 좌표 (-50~+80% 구간으로 클램프)
  const scatterPoints = skusWithOrders
    .filter((r) => r.estimated_margin_pct != null && r.realized_margin_pct != null)
    .slice(0, 400)
    .map((r) => {
      const ex = Math.max(-50, Math.min(80, r.estimated_margin_pct as number))
      const ey = Math.max(-50, Math.min(80, r.realized_margin_pct as number))
      // x: estimated, y: realized. -50→0, 80→100
      const x = ((ex + 50) / 130) * 100
      const y = 100 - ((ey + 50) / 130) * 100
      return { x, y, drift: r.drift_pct, title: r.registered_title }
    })

  // outlier 테이블 (드리프트 |Δ| 큰 top 20, 주문 1+)
  const outliers = [...skusWithOrders]
    .filter((r) => r.drift_pct != null)
    .sort((a, b) => Math.abs(b.drift_pct as number) - Math.abs(a.drift_pct as number))
    .slice(0, 20)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">추정 vs 실현 마진 드리프트</h1>
          <p className="text-sm text-gray-500 mt-1">
            등록 시 추정 마진율(estimated_margin_pct)과 실제 주문·매입·배송·반품으로 산출한 실현 마진율의 격차를 SKU·카테고리 단위로 추적.{' '}
            <span className="text-rose-600">−3%p 초과 카테고리는 새 SKU 진입 경고.</span>
          </p>
        </div>
      </header>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white border rounded p-3">
          <div className="text-xs text-gray-500">실주문 SKU</div>
          <div className="text-xl font-semibold tabular-nums">{skusWithOrders.length.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400">전체 {all.length.toLocaleString()} 중</div>
        </div>
        <div className="bg-white border rounded p-3">
          <div className="text-xs text-gray-500">평균 드리프트</div>
          <div className={`text-xl font-semibold tabular-nums ${driftClass(avgDrift)}`}>{fmtPct(avgDrift, 2)}</div>
          <div className="text-[10px] text-gray-400">중앙값 {fmtPct(medDrift, 2)}</div>
        </div>
        <div className="bg-white border rounded p-3">
          <div className="text-xs text-gray-500">경고 카테고리</div>
          <div className="text-xl font-semibold tabular-nums text-rose-600">{warnedCategoryCount}</div>
          <div className="text-[10px] text-gray-400">평균 드리프트 &lt; {WARN_DRIFT_THRESHOLD}%p</div>
        </div>
        <div className="bg-white border rounded p-3">
          <div className="text-xs text-gray-500">실현 매출</div>
          <div className="text-xl font-semibold tabular-nums">{fmt(totalRevenue)}</div>
          <div className="text-[10px] text-gray-400">단위: 원</div>
        </div>
        <div className="bg-white border rounded p-3">
          <div className="text-xs text-gray-500">실현 마진 총합</div>
          <div className={`text-xl font-semibold tabular-nums ${totalRealized < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
            {fmt(totalRealized)}
          </div>
          <div className="text-[10px] text-gray-400">
            {totalRevenue > 0 ? `${((totalRealized / totalRevenue) * 100).toFixed(1)}%` : '—'}
          </div>
        </div>
      </div>

      {/* 산점도 */}
      <section className="bg-white border rounded p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-semibold text-gray-800">추정 vs 실현 산점도</h2>
          <div className="text-[11px] text-gray-500">x: 추정 마진율 · y: 실현 마진율 · 점선 = 일치선 (y=x)</div>
        </div>
        <div className="relative bg-gradient-to-br from-gray-50 to-white border rounded" style={{ height: 320 }}>
          {/* 격자 */}
          <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={v} y1={0} x2={v} y2={100} stroke="#e5e7eb" strokeWidth={0.2} />
                <line x1={0} y1={v} x2={100} y2={v} stroke="#e5e7eb" strokeWidth={0.2} />
              </g>
            ))}
            {/* 0%축 (= -50→0, 80→100 매핑에서 50 위치 / 100 * (50/130) = 38.46) */}
            <line x1={(50 / 130) * 100} y1={0} x2={(50 / 130) * 100} y2={100} stroke="#9ca3af" strokeWidth={0.3} strokeDasharray="1 1" />
            <line x1={0} y1={100 - (50 / 130) * 100} x2={100} y2={100 - (50 / 130) * 100} stroke="#9ca3af" strokeWidth={0.3} strokeDasharray="1 1" />
            {/* 일치선 y = x (점선) */}
            <line x1={0} y1={100} x2={100} y2={0} stroke="#3b82f6" strokeWidth={0.3} strokeDasharray="2 2" />
            {scatterPoints.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={0.9}
                fill={p.drift != null && p.drift < -3 ? '#dc2626' : p.drift != null && p.drift > 3 ? '#059669' : '#6b7280'}
                fillOpacity={0.6}
              >
                <title>{p.title} · drift {p.drift != null ? p.drift.toFixed(1) : '—'}%p</title>
              </circle>
            ))}
          </svg>
          {/* 축 라벨 */}
          <div className="absolute left-1 top-1 text-[10px] text-gray-400">실현 80%</div>
          <div className="absolute left-1 bottom-1 text-[10px] text-gray-400">실현 -50%</div>
          <div className="absolute right-1 bottom-1 text-[10px] text-gray-400">추정 80%</div>
          <div className="absolute left-1 bottom-1 ml-12 text-[10px] text-gray-400">추정 -50%</div>
        </div>
        {scatterPoints.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-8">아직 실주문 SKU 가 없어 산점도가 비어 있습니다.</div>
        )}
      </section>

      {/* 카테고리 랭킹 */}
      <section className="bg-white border rounded">
        <div className="px-4 py-3 border-b flex items-baseline justify-between">
          <h2 className="font-semibold text-gray-800">카테고리별 드리프트 랭킹</h2>
          <div className="flex items-center gap-2">
            <Link
              href={buildHref(current, { warn_only: warnOnly ? null : '1', category: null })}
              className={`text-xs px-2 py-1 rounded ${warnOnly ? 'bg-rose-100 text-rose-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {warnOnly ? '✓ ' : ''}경고만
            </Link>
            {categoryFilter && (
              <Link
                href={buildHref(current, { category: null })}
                className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700 font-semibold"
              >
                ✕ 카테고리 해제
              </Link>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">카테고리</th>
                <th className="px-3 py-2 text-right font-semibold">SKU</th>
                <th className="px-3 py-2 text-right font-semibold">주문</th>
                <th className="px-3 py-2 text-right font-semibold">매출</th>
                <th className="px-3 py-2 text-right font-semibold">평균 드리프트</th>
                <th className="px-3 py-2 text-right font-semibold">중앙값</th>
                <th className="px-3 py-2 text-center font-semibold">진입 경고</th>
              </tr>
            </thead>
            <tbody>
              {categories.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-gray-400 text-sm">
                    아직 카테고리별 데이터가 없습니다.
                  </td>
                </tr>
              )}
              {categories.map((c) => {
                const isActive = String(c.code ?? 0) === categoryFilter
                return (
                  <tr key={`${c.code}|${c.name}`} className={`border-t ${isActive ? 'bg-blue-50/40' : 'hover:bg-amber-50/30'}`}>
                    <td className="px-3 py-2">
                      <Link
                        href={buildHref(current, { category: String(c.code ?? 0) })}
                        className="text-gray-900 hover:text-blue-700"
                      >
                        {c.name} <span className="text-[10px] text-gray-400">#{c.code ?? '—'}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.sku_count.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.order_count.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(c.revenue)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${driftClass(c.avg_drift_pct)}`}>
                      {fmtPct(c.avg_drift_pct, 2)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${driftClass(c.median_drift_pct)}`}>
                      {fmtPct(c.median_drift_pct, 2)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {c.warned ? (
                        <span className="inline-block px-2 py-0.5 rounded text-xs bg-rose-100 text-rose-700 font-semibold">
                          ⚠ 신규 진입 경고
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* outlier 비용 분해 */}
      <section className="bg-white border rounded">
        <div className="px-4 py-3 border-b">
          <h2 className="font-semibold text-gray-800">드리프트 outlier SKU — 비용 분해 & 가설 라벨</h2>
          <p className="text-[11px] text-gray-500 mt-1">
            |드리프트| 큰 상위 20 SKU. 매출 대비 택배비/쿠팡수수료/반품손실 비중을 분해해 추정이 깨진 가장 유력한 사유를 라벨로 붙임.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">상품</th>
                <th className="px-3 py-2 text-right font-semibold">주문</th>
                <th className="px-3 py-2 text-right font-semibold">매출</th>
                <th className="px-3 py-2 text-right font-semibold">추정%</th>
                <th className="px-3 py-2 text-right font-semibold">실현%</th>
                <th className="px-3 py-2 text-right font-semibold">드리프트</th>
                <th className="px-3 py-2 text-right font-semibold">택배비%</th>
                <th className="px-3 py-2 text-right font-semibold">쿠팡수수료%</th>
                <th className="px-3 py-2 text-right font-semibold">반품%</th>
                <th className="px-3 py-2 text-left font-semibold">가설</th>
              </tr>
            </thead>
            <tbody>
              {outliers.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-gray-400 text-sm">
                    아직 outlier 가 충분히 누적되지 않았습니다.
                  </td>
                </tr>
              )}
              {outliers.map((r) => {
                const hyp = inferHypothesis(r)
                return (
                  <tr key={r.listing_id} className="border-t hover:bg-amber-50/30">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900 line-clamp-2">{r.registered_title}</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        {r.display_category_name ?? '—'} {r.brand ? `· ${r.brand}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.order_count}
                      {r.return_count > 0 && (
                        <div className="text-[10px] text-rose-600">반품 {r.return_count}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(r.revenue_total_krw)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.estimated_margin_pct, 1)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${(r.realized_margin_pct ?? 0) < 0 ? 'text-rose-700' : 'text-gray-700'}`}>
                      {fmtPct(r.realized_margin_pct, 1)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${driftClass(r.drift_pct)}`}>
                      {fmtPct(r.drift_pct, 1)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.delivery_share_pct, 1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.coupang_fee_share_pct, 1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.return_loss_share_pct, 1)}</td>
                    <td className="px-3 py-2">
                      {hyp ? (
                        <span className={`inline-block px-2 py-0.5 rounded text-xs ${hyp.tone}`}>{hyp.label}</span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 필터된 전체 SKU 테이블 */}
      <section className="bg-white border rounded">
        <div className="px-4 py-3 border-b flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-gray-800">
            SKU 전체 ({rows.length.toLocaleString()})
            {categoryFilter && (
              <span className="text-xs text-gray-500 ml-2">
                · 카테고리 #{categoryFilter} 필터 적용
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">정렬</span>
            {SORT_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sort: s.v })}
                className={`text-xs px-2 py-1 rounded ${
                  sort === s.v ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-semibold w-[34%]">상품</th>
                <th className="px-3 py-2 text-right font-semibold">주문</th>
                <th className="px-3 py-2 text-right font-semibold">매출</th>
                <th className="px-3 py-2 text-right font-semibold">실현 마진</th>
                <th className="px-3 py-2 text-right font-semibold">추정%</th>
                <th className="px-3 py-2 text-right font-semibold">실현%</th>
                <th className="px-3 py-2 text-right font-semibold">드리프트</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-gray-400 text-sm">
                    데이터 없음.
                  </td>
                </tr>
              )}
              {rows.slice(0, PAGE_SIZE).map((r) => (
                <tr key={r.listing_id} className="border-t hover:bg-amber-50/30">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">{r.registered_title}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {r.display_category_name ?? '—'} {r.brand ? `· ${r.brand}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.order_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.revenue_total_krw)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.realized_margin_total_krw < 0 ? 'text-rose-700' : 'text-gray-700'}`}>
                    {fmt(r.realized_margin_total_krw)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.estimated_margin_pct, 1)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${(r.realized_margin_pct ?? 0) < 0 ? 'text-rose-700' : 'text-gray-700'}`}>
                    {fmtPct(r.realized_margin_pct, 1)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${driftClass(r.drift_pct)}`}>
                    {fmtPct(r.drift_pct, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > PAGE_SIZE && (
            <div className="px-4 py-3 text-xs text-gray-400 border-t">
              ... +{(rows.length - PAGE_SIZE).toLocaleString()} 행 (정렬·필터로 좁히세요)
            </div>
          )}
        </div>
      </section>

      <div className="text-xs text-gray-400 border-t pt-3 leading-relaxed">
        ℹ️ 실현 마진 = 매출 − 매입 − 택배비 − 쿠팡수수료(10%) − 반품손실. 쿠팡수수료율은 카테고리별 실제 값으로 교체 예정.
        가설 라벨은 현재 룰베이스(비용 분해 비중 기반). 향후 <code className="px-1 bg-gray-100 rounded">classify-trends-llm</code> 옆에 LLM 가설 생성 잡 연결 예정.
      </div>
    </div>
  )
}
