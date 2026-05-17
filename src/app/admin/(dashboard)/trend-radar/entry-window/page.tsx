import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import EntryWindowScatter from './EntryWindowScatter'

export const dynamic = 'force-dynamic'

interface WindowRow {
  product_id: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  supply_drop_pct_7d: number
  supply_in_stock_days: number
  price_now: number | null
  price_7d_ago: number | null
  demand_count_7d: number
  demand_count_prev7: number
  demand_count_28d: number
  demand_accel_7d: number
  demand_accel_28d: number
  demand_top_keyword: string
  demand_sources: string[]
  convergence_score: number
  window_d_remain: number
  first_signal_at: string | null
}

const MIN_SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

async function fetchWindow(opts: { minSim: number; minConv: number }) {
  const sb = createAdminClient()
  // RPC supply_demand_window 가 DB(supabase/supply_demand_window.sql)에 존재.
  // generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거.
  const { data, error } = await sb.rpc('jimscanner_supply_demand_window' as never, {
    result_limit: 200,
    min_sim: opts.minSim,
    min_convergence: opts.minConv,
  } as never)
  if (error) {
    return { rows: [] as WindowRow[], error: error.message }
  }
  return { rows: (data ?? []) as unknown as WindowRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/entry-window' + (qs ? `?${qs}` : '')
}

export default async function EntryWindowPage({
  searchParams,
}: {
  searchParams: Promise<{ sim?: string; min?: string; conv?: string }>
}) {
  const sp = await searchParams
  const simRaw = parseFloat(sp.sim ?? '0.2')
  const minSim = MIN_SIM_OPTIONS.some((s) => Math.abs(s.v - simRaw) < 0.001) ? simRaw : 0.2
  const convergeOnly = sp.conv === '1'
  const minConvergence = convergeOnly ? 0.05 : 0.0

  const current: Record<string, string> = {
    sim: String(minSim),
    conv: convergeOnly ? '1' : '',
  }

  const { rows, error } = await fetchWindow({ minSim, minConv: minConvergence })

  // KPI
  const totalRows = rows.length
  const convergeCount = rows.filter((r) => Number(r.convergence_score) >= 0.05).length
  const supplyOnly = rows.filter((r) => Number(r.supply_drop_pct_7d) > 0 && Number(r.demand_accel_7d) <= 0).length
  const demandOnly = rows.filter((r) => Number(r.demand_accel_7d) > 0 && Number(r.supply_drop_pct_7d) <= 0).length
  const expiringSoon = rows.filter(
    (r) => Number(r.convergence_score) >= 0.05 && r.window_d_remain != null && r.window_d_remain <= 3,
  ).length

  // 4분면 산점도 데이터
  const scatter = rows.map((r) => ({
    id: r.product_id,
    name: r.title,
    cate: r.cate_label ?? r.cate_cd ?? 'all',
    x: Number(r.supply_drop_pct_7d), // 공급개선속도 (%) — 우측 = 더 많이 떨어짐
    y: Number(r.demand_accel_7d) * 100, // 수요가속도(%) — 상단 = 가속
    score: Number(r.convergence_score),
    isImminent: r.is_imminent,
    dRemain: r.window_d_remain,
  }))

  const top30 = [...rows]
    .sort((a, b) => Number(b.convergence_score) - Number(a.convergence_score))
    .slice(0, 30)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⏱ 진입윈도우 감지 (공급↓ × 수요↑)</h1>
          <p className="text-sm text-gray-500 mt-1">
            도매가 7일 하락 + 검색·TV·쇼핑 수요 7일 가속도 동시 발생 — 골든 윈도우 3~10일.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">매칭 유사도 ≥</span>
          {MIN_SIM_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sim: String(s.v) })}
              className={`px-2 py-1 text-xs rounded ${
                Math.abs(minSim - s.v) < 0.001
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref(current, { conv: convergeOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${
            convergeOnly
              ? 'bg-emerald-100 text-emerald-700 font-semibold'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {convergeOnly ? '✓ ' : ''}convergence ≥ 0.05 만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="전체 후보" value={totalRows} />
        <Kpi label="🎯 동시발생" value={convergeCount} highlight={convergeCount > 0} />
        <Kpi label="공급만 ↓" value={supplyOnly} />
        <Kpi label="수요만 ↑" value={demandOnly} />
        <Kpi label="🔥 D-3 이하" value={expiringSoon} highlight={expiringSoon > 0} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_supply_demand_window</code> 가 DB에 적용 안 됐을 가능성.
            supabase/supply_demand_window.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 4분면 산점도 */}
      {!error && rows.length > 0 && (
        <EntryWindowScatter rows={scatter} />
      )}

      {/* Convergence Top 30 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">감지된 시그널 없음</div>
          <div className="text-xs text-gray-400">
            price_history 가 7일치 미만이거나, trends_keywords 매칭이 부족.
            <br />
            min_sim 을 0.15 로 낮춰서 매칭 확장 시도.
          </div>
        </div>
      ) : (
        !error && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold">🏆 Convergence Top 30</h2>
            <div className="rounded border border-gray-200 divide-y divide-gray-100">
              {top30.map((r, i) => {
                const score = Number(r.convergence_score)
                const isHot = score >= 0.1
                const isExpiring = r.window_d_remain != null && r.window_d_remain <= 3
                return (
                  <div
                    key={r.product_id}
                    className={`flex items-start gap-3 p-3 ${
                      isHot ? 'bg-emerald-50/40' : ''
                    } ${isExpiring ? 'border-l-4 border-l-red-500' : ''}`}
                  >
                    <div className="w-7 text-center text-xs font-mono text-gray-400 pt-1">
                      {i + 1}
                    </div>
                    <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                      {r.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                      )}
                      {r.is_imminent && (
                        <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                          임박
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <a
                        href={r.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className="text-sm font-medium leading-snug hover:underline"
                        title={r.title}
                      >
                        {r.title}
                      </a>
                      <div className="text-xs text-gray-500">
                        {r.cate_label ?? r.cate_cd} · {r.product_id}
                      </div>
                      <div className="flex flex-wrap gap-2 text-[11px] pt-1">
                        <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-mono">
                          공급 ↓ {Number(r.supply_drop_pct_7d).toFixed(1)}% · 재고{r.supply_in_stock_days}/7d
                        </span>
                        <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-mono">
                          수요 ↑ {(Number(r.demand_accel_7d) * 100).toFixed(0)}% (7d: {r.demand_count_7d} vs {r.demand_count_prev7})
                        </span>
                        {r.demand_top_keyword && (
                          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                            🔑 &quot;{r.demand_top_keyword}&quot;
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 space-y-1">
                      {r.price_now != null && r.price_7d_ago != null && r.price_now !== r.price_7d_ago && (
                        <div className="text-xs text-gray-500">
                          <span className="line-through">{r.price_7d_ago.toLocaleString()}</span>
                          <span className="ml-1">→ {r.price_now.toLocaleString()}원</span>
                        </div>
                      )}
                      <div className="text-2xl font-bold font-mono text-emerald-700">
                        {score.toFixed(3)}
                      </div>
                      {r.window_d_remain != null && (
                        <div
                          className={`text-[11px] font-mono ${
                            isExpiring ? 'text-red-700 font-bold' : 'text-gray-500'
                          }`}
                        >
                          {r.window_d_remain > 0 ? `D-${r.window_d_remain}` : 'EXPIRED'}
                        </div>
                      )}
                      <PinForm productId={r.product_id} keyword={r.demand_top_keyword} />
                    </div>
                  </div>
                )
              })}
              {top30.length === 0 && (
                <div className="p-6 text-sm text-gray-400 text-center">상위 후보 없음</div>
              )}
            </div>
          </section>
        )
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Convergence Score 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
{`convergence_score = clamp(supply_drop_pct_7d, 0..50) / 50
                  × clamp(demand_accel_7d, 0..3) / 3
                  × (1 + 0.2 × in_stock_days_7d / 7)

supply_drop_pct_7d = (price_7d_ago - price_now) / price_7d_ago × 100
demand_accel_7d    = (demand_7d - demand_prev7) / max(1, demand_prev7)
window_d_remain    = 10 - days_since_first_signal   (≥ 0)`}
        </code>
        <div className="pt-2">
          <strong>해석:</strong> 0.05 이상 = 동시발생 시그널, 0.1 이상 = 강한 진입 윈도우, D-3 이하 = 마감 임박.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

// Phase 0: 핀 토글은 기존 jimscanner_trends_pins(keyword 기반)에 keyword 단위로 등록.
// product 단위 핀 테이블은 후속 PR. 여기는 form action 으로 server action 호출.
function PinForm({ productId, keyword }: { productId: string; keyword: string }) {
  if (!keyword) return null
  return (
    <form action={pinKeywordAction} className="pt-1">
      <input type="hidden" name="keyword" value={keyword} />
      <input type="hidden" name="product_id" value={productId} />
      <button
        type="submit"
        className="text-[10px] px-2 py-0.5 rounded bg-gray-100 hover:bg-amber-100 text-gray-600 hover:text-amber-800"
      >
        📌 핀 큐
      </button>
    </form>
  )
}

async function pinKeywordAction(formData: FormData) {
  'use server'
  const keyword = String(formData.get('keyword') ?? '').trim()
  const productId = String(formData.get('product_id') ?? '').trim()
  if (!keyword) return
  const sb = createAdminClient()
  await sb.from('jimscanner_trends_pins').upsert(
    {
      keyword,
      source: 'entry_window',
      notes: productId ? `entry-window · ggsan goods_no=${productId}` : 'entry-window',
    } as never,
    { onConflict: 'keyword,source' } as never,
  )
}
