import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ScissorsChart from './ScissorsChart'

export const dynamic = 'force-dynamic'

interface ScissorRow {
  product_id: string
  canonical_name: string
  category_top: string
  goods_no: string | null
  ggsan_title: string | null
  detail_url: string | null
  sim: number
  current_price: number | null
  price_first: number | null
  current_demand: number
  demand_first: number
  demand_slope: number
  price_slope: number | null
  demand_change_pct: number
  price_change_pct: number | null
  scissors_score: number
  has_sourcing: boolean
  demand_points: number
  price_points: number
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일 (기본)' },
  { v: 30, label: '30일' },
] as const

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/scissors' + (qs ? `?${qs}` : '')
}

async function fetchCandidates(days: number) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/scissors_candidates_rpc.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_scissors_candidates' as never, {
    days_window: days,
    min_sim: 0.2,
    result_limit: 150,
  } as never)
  if (error) return { rows: [] as ScissorRow[], error: error.message }
  return { rows: (data ?? []) as ScissorRow[], error: null as string | null }
}

async function fetchSeries(productId: string, goodsNo: string | null, days: number) {
  const sb = createAdminClient()
  const since = new Date(Date.now() - days * 86400_000).toISOString()

  const demandQ = sb
    .from('jimscanner_trends_scores')
    .select('final_score, computed_at')
    .eq('product_id', productId)
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })

  const priceQ = goodsNo
    ? sb
        .from('jimscanner_ggsan_price_history')
        .select('price_krw, observed_at')
        .eq('goods_no', goodsNo)
        .gte('observed_at', since)
        .order('observed_at', { ascending: true })
    : null

  const [demandRes, priceRes] = await Promise.all([demandQ, priceQ ?? Promise.resolve({ data: [] })])

  const demandSeries = ((demandRes.data ?? []) as { final_score: number; computed_at: string }[]).map((r) => ({
    t: r.computed_at,
    v: Number(r.final_score),
  }))
  const priceSeries = ((priceRes.data ?? []) as { price_krw: number | null; observed_at: string }[])
    .filter((r) => r.price_krw != null)
    .map((r) => ({ t: r.observed_at, v: Number(r.price_krw) }))

  return { demandSeries, priceSeries }
}

export default async function ScissorsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sel?: string }>
}) {
  const sp = await searchParams
  const daysParsed = parseInt(sp.days ?? '14', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === daysParsed) ? daysParsed : 14
  const current: Record<string, string> = { days: String(days), sel: sp.sel ?? '' }

  const { rows, error } = await fetchCandidates(days)

  const connected = rows.filter((r) => r.has_sourcing)
  const orphans = rows.filter((r) => !r.has_sourcing)

  // 선택 상품: sel 또는 연결된 1순위
  const selectedId = sp.sel || connected[0]?.product_id || rows[0]?.product_id || null
  const selected = rows.find((r) => r.product_id === selectedId) ?? null

  let series: { demandSeries: { t: string; v: number }[]; priceSeries: { t: string; v: number }[] } = {
    demandSeries: [],
    priceSeries: [],
  }
  if (selected) {
    series = await fetchSeries(selected.product_id, selected.goods_no, days)
  }

  // KPI
  const golden = connected.filter((r) => r.scissors_score > 0 && (r.price_change_pct ?? 0) < 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">✂️ 수요-공급 가위 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            도매가↓ × 수요↑ 가 동시에 벌어지는 골든 진입 타이밍. scissors_score = 수요기울기 − 도매가기울기 (마진 헤드룸 가중)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 기간 필터 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">회귀 기간</span>
        {DAYS_OPTIONS.map((d) => (
          <Link
            key={d.v}
            href={buildHref(current, { days: String(d.v), sel: null })}
            className={`px-2 py-1 text-xs rounded ${
              days === d.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            {d.label}
          </Link>
        ))}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 (수요 시계열 보유)" value={rows.length} />
        <Kpi label="소싱 연결 (도매가 이력)" value={connected.length} />
        <Kpi label="🟢 골든 (가위>0 & 도매가↓)" value={golden} highlight={golden > 0} />
        <Kpi label="소싱 미연결" value={orphans.length} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_scissors_candidates</code> 미적용 가능성. supabase/scissors_candidates_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">수요 시계열 후보 없음</div>
          <div className="text-xs text-gray-400">
            jimscanner_trends_scores 가 product_id 당 2점 이상 누적돼야 회귀 가능. cron 누적 후 자동 등장.
          </div>
        </div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* 좌: 랭킹 테이블 */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">📊 scissors_score 랭킹 (소싱 연결)</h2>
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-2 text-left">상품</th>
                    <th className="px-2 py-2 text-right">현재가</th>
                    <th className="px-2 py-2 text-right">도매가 Δ</th>
                    <th className="px-2 py-2 text-right">수요 Δ</th>
                    <th className="px-2 py-2 text-right">가위</th>
                  </tr>
                </thead>
                <tbody>
                  {connected.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-6 text-center text-gray-400">
                        소싱 연결 후보 없음 — 도매가 이력 누적 또는 trigram 매칭 대기
                      </td>
                    </tr>
                  )}
                  {connected.map((r) => {
                    const isSel = r.product_id === selectedId
                    const golden = r.scissors_score > 0 && (r.price_change_pct ?? 0) < 0
                    return (
                      <tr
                        key={r.product_id}
                        className={`border-t border-gray-100 ${isSel ? 'bg-emerald-50' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-2 py-2">
                          <Link
                            href={buildHref(current, { sel: r.product_id })}
                            className="block max-w-[180px]"
                          >
                            <div className="font-medium truncate" title={r.canonical_name}>
                              {golden && <span className="mr-1">🟢</span>}
                              {r.canonical_name}
                            </div>
                            <div className="text-[10px] text-gray-400 truncate" title={r.ggsan_title ?? ''}>
                              ↳ {r.ggsan_title} (sim {r.sim.toFixed(2)})
                            </div>
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-right font-mono">
                          {r.current_price != null ? r.current_price.toLocaleString() : '—'}
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono ${
                            (r.price_change_pct ?? 0) < 0 ? 'text-blue-600' : 'text-gray-400'
                          }`}
                        >
                          {r.price_change_pct != null ? `${r.price_change_pct.toFixed(1)}%` : '—'}
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono ${
                            r.demand_change_pct > 0 ? 'text-amber-600' : 'text-gray-400'
                          }`}
                        >
                          {r.demand_change_pct >= 0 ? '+' : ''}
                          {r.demand_change_pct.toFixed(1)}%
                        </td>
                        <td className="px-2 py-2 text-right font-mono font-bold text-emerald-700">
                          {r.scissors_score.toFixed(1)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* 소싱 미연결 */}
            {orphans.length > 0 && (
              <details className="rounded border border-gray-200">
                <summary className="px-3 py-2 text-xs text-gray-600 cursor-pointer">
                  ⚠️ 소싱 미연결 {orphans.length}건 (도매가 이력 없음 — 수요만 추적)
                </summary>
                <div className="px-3 py-2 space-y-1 max-h-60 overflow-y-auto">
                  {orphans.slice(0, 40).map((r) => (
                    <div key={r.product_id} className="flex justify-between text-xs">
                      <span className="truncate max-w-[200px]" title={r.canonical_name}>
                        {r.canonical_name}
                      </span>
                      <span
                        className={`font-mono ${r.demand_change_pct > 0 ? 'text-amber-600' : 'text-gray-400'}`}
                      >
                        수요 {r.demand_change_pct >= 0 ? '+' : ''}
                        {r.demand_change_pct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          {/* 우: 이중축 차트 */}
          <div className="space-y-2">
            {selected ? (
              <>
                <ScissorsChart
                  priceSeries={series.priceSeries}
                  demandSeries={series.demandSeries}
                  productName={selected.canonical_name}
                />
                <div className="text-xs text-gray-500 grid grid-cols-2 gap-2 px-1">
                  <div>
                    도매가 기울기:{' '}
                    <span className="font-mono">
                      {selected.price_slope != null ? `${selected.price_slope.toFixed(1)} 원/일` : '이력 없음'}
                    </span>
                  </div>
                  <div>
                    수요 기울기:{' '}
                    <span className="font-mono">{selected.demand_slope.toFixed(2)} pt/일</span>
                  </div>
                  <div>
                    현재가:{' '}
                    <span className="font-mono">
                      {selected.current_price != null ? `${selected.current_price.toLocaleString()}원` : '—'}
                    </span>
                  </div>
                  <div>
                    14일 전 도매가:{' '}
                    <span className="font-mono">
                      {selected.price_first != null ? `${selected.price_first.toLocaleString()}원` : '—'}
                    </span>
                  </div>
                  {selected.detail_url && (
                    <a
                      href={selected.detail_url}
                      target="_blank"
                      rel="noopener"
                      className="col-span-2 text-emerald-700 underline"
                    >
                      ggsan 상세 →
                    </a>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-400 text-sm">
                좌측에서 상품을 선택하세요.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 scissors_score 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          demand_slope_pct = regr_slope(final_score, day) / avg(final_score) × 100
          <br />
          price_slope_pct = regr_slope(price_krw, day) / avg(price) × 100
          <br />
          scissors_score = (demand_slope_pct − price_slope_pct) × (0.5 + min(현재수요,100)/200)
        </code>
        <div className="pt-1">
          🟢 골든 = 가위{'>'}0 & 도매가 변화{'<'}0 (수요 오르며 도매가 내림). 매핑은 canonical_name ↔ ggsan title trigram best-match.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
