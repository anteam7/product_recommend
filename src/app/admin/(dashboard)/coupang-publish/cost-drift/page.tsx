import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface DriftRow {
  id: string
  source_goods_no: string
  registered_title: string
  brand: string | null
  display_category_name: string | null
  status: string
  displayable: boolean
  dome_price_registered_krw: number | null
  dome_price_current_krw: number | null
  dome_price_delta_krw: number | null
  dome_price_delta_pct: number | null
  msp_price_krw: number | null
  list_price_krw: number | null
  estimated_margin_pct: number | null
  recalculated_margin_krw: number | null
  recalculated_margin_pct: number | null
  status_current: string | null
  status_churn_30d: number
  last_observed_at: string | null
  registered_at: string | null
  product_id: number | null
  source_detail_url: string | null
  cost_drift_alert: boolean
  recommended_action: 'raise_msp' | 'hold' | 'delist'
}

const ACTION_LABELS: Record<DriftRow['recommended_action'], { label: string; cls: string }> = {
  raise_msp: { label: 'MSP 인상', cls: 'bg-rose-100 text-rose-700' },
  hold: { label: '유지', cls: 'bg-gray-100 text-gray-600' },
  delist: { label: '판매 중지', cls: 'bg-zinc-800 text-white' },
}

const SORT_OPTIONS = [
  { v: 'drift_desc', label: '도매가 인상↑' },
  { v: 'margin_collapse', label: '마진 붕괴' },
  { v: 'churn_desc', label: 'status churn↑' },
  { v: 'recent', label: '최근 등록순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 50

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString()
}

function fmtPct(n: number | null | undefined, digits = 1) {
  if (n == null) return '—'
  return `${n.toFixed(digits)}%`
}

async function fetchDrift(opts: { alertOnly: boolean; sort: SortKey; page: number }) {
  // jimscanner_v_listing_cost_drift 뷰 — generated types 갱신 전까지 임시 캐스팅
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  let query = sb.from('jimscanner_v_listing_cost_drift').select('*', { count: 'exact' })
  if (opts.alertOnly) query = query.eq('cost_drift_alert', true)

  switch (opts.sort) {
    case 'margin_collapse':
      query = query.order('recalculated_margin_pct', { ascending: true, nullsFirst: false })
      break
    case 'churn_desc':
      query = query.order('status_churn_30d', { ascending: false })
      break
    case 'recent':
      query = query.order('registered_at', { ascending: false, nullsFirst: false })
      break
    case 'drift_desc':
    default:
      query = query.order('dome_price_delta_pct', { ascending: false, nullsFirst: false })
  }

  const offset = (opts.page - 1) * PAGE_SIZE
  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  return { rows: (data ?? []) as unknown as DriftRow[], total: count ?? 0 }
}

async function fetchSummary() {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const [{ count: total }, { count: alertCount }, { data: actionData }] = await Promise.all([
    sb.from('jimscanner_v_listing_cost_drift').select('*', { count: 'exact', head: true }),
    sb
      .from('jimscanner_v_listing_cost_drift')
      .select('*', { count: 'exact', head: true })
      .eq('cost_drift_alert', true),
    sb.from('jimscanner_v_listing_cost_drift').select('recommended_action'),
  ])
  const byAction = new Map<string, number>()
  for (const r of (actionData ?? []) as unknown as { recommended_action: string }[]) {
    byAction.set(r.recommended_action, (byAction.get(r.recommended_action) ?? 0) + 1)
  }
  return {
    total: total ?? 0,
    alerts: alertCount ?? 0,
    raiseMsp: byAction.get('raise_msp') ?? 0,
    delist: byAction.get('delist') ?? 0,
  }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/coupang-publish/cost-drift' + (qs ? `?${qs}` : '')
}

function DeltaBar({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-gray-300">—</span>
  const capped = Math.max(-30, Math.min(30, pct))
  const width = Math.min(100, Math.abs(capped) * 3.33)
  const positive = pct >= 0
  return (
    <div className="flex items-center gap-2">
      <span
        className={`tabular-nums w-14 text-right ${
          positive && pct >= 5
            ? 'text-rose-700 font-semibold'
            : positive
              ? 'text-amber-700'
              : 'text-emerald-700'
        }`}
      >
        {positive ? '+' : ''}
        {pct.toFixed(1)}%
      </span>
      <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden relative max-w-[80px]">
        <div
          className={`absolute top-0 h-full ${positive ? 'bg-rose-500 left-1/2' : 'bg-emerald-500 right-1/2'}`}
          style={{ width: `${width / 2}%` }}
        />
        <div className="absolute top-0 left-1/2 h-full w-px bg-gray-300" />
      </div>
    </div>
  )
}

export default async function CostDriftPage({
  searchParams,
}: {
  searchParams: Promise<{ alert?: string; sort?: string; page?: string }>
}) {
  const sp = await searchParams
  const alertOnly = sp.alert === '1'
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'drift_desc') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const current: Record<string, string> = {
    alert: alertOnly ? '1' : '',
    sort,
    page: String(page),
  }

  const [{ rows, total }, summary] = await Promise.all([
    fetchDrift({ alertOnly, sort, page }),
    fetchSummary(),
  ])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">공급가 인상 추적 — 도매원가 재평가</h1>
          <p className="text-sm text-gray-500 mt-1">
            발행 SKU 의 등록 시 도매가 vs ggsan 현재 도매가 비교. 임계 초과 시 마진 즉시 마이너스 위험.
          </p>
          <div className="text-xs text-gray-500 mt-2 flex flex-wrap gap-4">
            <span>
              누적 SKU <strong>{summary.total.toLocaleString()}</strong>
            </span>
            <span className="text-rose-600">
              알람 <strong>{summary.alerts.toLocaleString()}</strong>
            </span>
            <span>
              MSP 인상 권장 <strong>{summary.raiseMsp.toLocaleString()}</strong>
            </span>
            <span>
              판매중지 권장 <strong>{summary.delist.toLocaleString()}</strong>
            </span>
          </div>
        </div>
        <Link
          href="/admin/coupang-publish"
          className="text-sm text-gray-500 hover:text-black underline"
        >
          ← 등록 상품 관리로
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={buildHref(current, { alert: alertOnly ? null : '1', page: null })}
          className={`px-3 py-1 text-xs rounded ${
            alertOnly
              ? 'bg-rose-100 text-rose-700 font-semibold'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {alertOnly ? '✓ ' : ''}알람만 보기
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">정렬</span>
          {SORT_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sort: s.v, page: null })}
              className={`text-xs px-2 py-1 rounded ${
                sort === s.v
                  ? 'bg-blue-100 text-blue-700 font-semibold'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-semibold w-[28%]">상품명</th>
              <th className="px-3 py-2 text-right font-semibold">등록 시 도매가</th>
              <th className="px-3 py-2 text-right font-semibold">현재 도매가</th>
              <th className="px-3 py-2 text-left font-semibold">Δ%</th>
              <th className="px-3 py-2 text-right font-semibold">등록 마진</th>
              <th className="px-3 py-2 text-right font-semibold">재산정 마진</th>
              <th className="px-3 py-2 text-center font-semibold">churn 30d</th>
              <th className="px-3 py-2 text-center font-semibold">권장 액션</th>
              <th className="px-3 py-2 text-center font-semibold">링크</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center text-gray-400 text-sm">
                  표시할 데이터가 없습니다. 뷰{' '}
                  <code className="bg-gray-100 px-1 rounded">jimscanner_v_listing_cost_drift</code>{' '}
                  가 적용됐는지 확인하세요.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const action = ACTION_LABELS[r.recommended_action]
              const marginCollapsed =
                r.recalculated_margin_pct != null &&
                r.estimated_margin_pct != null &&
                r.recalculated_margin_pct < r.estimated_margin_pct / 2
              const coupangUrl = r.product_id
                ? `https://www.coupang.com/vp/products/${r.product_id}`
                : null
              return (
                <tr
                  key={r.id}
                  className={`border-t hover:bg-amber-50/30 ${r.cost_drift_alert ? 'bg-rose-50/30' : ''}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">
                      {r.registered_title}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap gap-x-2">
                      {r.brand && <span>{r.brand}</span>}
                      {r.display_category_name && <span>· {r.display_category_name}</span>}
                      <span>· goods_no={r.source_goods_no}</span>
                      {r.status_current && r.status_current !== 'active' && (
                        <span className="text-rose-600">· {r.status_current}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                    {fmt(r.dome_price_registered_krw)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">
                    {fmt(r.dome_price_current_krw)}
                    {r.dome_price_delta_krw != null && r.dome_price_delta_krw !== 0 && (
                      <div
                        className={`text-[10px] ${r.dome_price_delta_krw > 0 ? 'text-rose-600' : 'text-emerald-600'}`}
                      >
                        {r.dome_price_delta_krw > 0 ? '+' : ''}
                        {fmt(r.dome_price_delta_krw)}원
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <DeltaBar pct={r.dome_price_delta_pct} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                    {fmtPct(r.estimated_margin_pct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span
                      className={
                        r.recalculated_margin_pct == null
                          ? 'text-gray-300'
                          : r.recalculated_margin_pct < 0
                            ? 'text-rose-700 font-bold'
                            : marginCollapsed
                              ? 'text-rose-600 font-semibold'
                              : 'text-gray-900 font-medium'
                      }
                    >
                      {fmtPct(r.recalculated_margin_pct)}
                    </span>
                    {r.recalculated_margin_krw != null && (
                      <div className="text-[10px] text-gray-400">
                        {fmt(r.recalculated_margin_krw)}원
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">
                    {r.status_churn_30d > 0 ? (
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-xs ${
                          r.status_churn_30d >= 3
                            ? 'bg-rose-100 text-rose-700 font-semibold'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {r.status_churn_30d}
                      </span>
                    ) : (
                      <span className="text-gray-300">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${action.cls}`}>
                      {action.label}
                    </span>
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

      {totalPages > 1 && (
        <div className="flex justify-center gap-1 text-sm">
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={buildHref(current, { page: String(p) })}
              className={`px-3 py-1 rounded ${
                page === p
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
