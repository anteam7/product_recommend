import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CycleRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  brand: string | null
  image_url: string | null
  detail_url: string | null
  current_price: number | null
  base_price: number | null
  discount_depth_avg: number | null
  period_days: number | null
  total_events: number
  last_low_at: string | null
  days_to_next_predicted_low: number | null
  confidence: number
  current_discount_pct: number | null
}

interface HistoryPoint {
  goods_no: string
  price_krw: number | null
  observed_at: string
}

const TAB_OPTIONS = [
  { v: 'soon', label: '7일내 예측 할인' },
  { v: 'all', label: '전체 사이클' },
  { v: 'category', label: '카테고리 패턴' },
] as const
type Tab = (typeof TAB_OPTIONS)[number]['v']

const CONFIDENCE_OPTIONS = [
  { v: 0, label: '전체' },
  { v: 0.3, label: 'C≥0.3' },
  { v: 0.5, label: 'C≥0.5 (기본)' },
  { v: 0.7, label: 'C≥0.7 (엄격)' },
] as const

async function fetchCycles(opts: { minConfidence: number; tab: Tab; cat: string }) {
  const sb = createAdminClient()
  // View는 supabase/ggsan_discount_cycle.sql 에서 정의되었으나 generated 타입 미반영 → as never 캐스팅
  let query = sb
    .from('jimscanner_ggsan_discount_cycle' as never)
    .select('*')
    .gte('confidence' as never, opts.minConfidence)
    .order('confidence' as never, { ascending: false })
    .limit(500)

  if (opts.cat) query = query.eq('cate_cd' as never, opts.cat)

  const { data, error } = await query
  if (error) return { rows: [] as CycleRow[], error: error.message }
  let rows = (data ?? []) as unknown as CycleRow[]

  if (opts.tab === 'soon') {
    rows = rows.filter(
      (r) =>
        r.days_to_next_predicted_low != null &&
        r.days_to_next_predicted_low >= -3 &&
        r.days_to_next_predicted_low <= 7,
    )
    rows.sort((a, b) => (a.days_to_next_predicted_low ?? 999) - (b.days_to_next_predicted_low ?? 999))
  }
  return { rows, error: null as string | null }
}

async function fetchHistory(goodsNos: string[]): Promise<Map<string, HistoryPoint[]>> {
  if (goodsNos.length === 0) return new Map()
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_ggsan_price_history')
    .select('goods_no, price_krw, observed_at')
    .in('goods_no', goodsNos)
    .gte('observed_at', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())
    .order('observed_at', { ascending: true })

  const map = new Map<string, HistoryPoint[]>()
  for (const row of (data ?? []) as HistoryPoint[]) {
    const arr = map.get(row.goods_no) ?? []
    arr.push(row)
    map.set(row.goods_no, arr)
  }
  return map
}

function Sparkline({
  points,
  basePrice,
  width = 160,
  height = 40,
}: {
  points: HistoryPoint[]
  basePrice: number | null
  width?: number
  height?: number
}) {
  if (points.length < 2) {
    return <div className="text-[10px] text-gray-400">데이터 부족</div>
  }
  const prices = points.map((p) => p.price_krw ?? 0).filter((v) => v > 0)
  if (prices.length < 2) return <div className="text-[10px] text-gray-400">데이터 부족</div>

  const minP = Math.min(...prices)
  const maxP = Math.max(...prices)
  const span = Math.max(maxP - minP, 1)
  const t0 = new Date(points[0].observed_at).getTime()
  const t1 = new Date(points[points.length - 1].observed_at).getTime()
  const tspan = Math.max(t1 - t0, 1)

  const coords = points
    .filter((p) => (p.price_krw ?? 0) > 0)
    .map((p) => {
      const x = ((new Date(p.observed_at).getTime() - t0) / tspan) * width
      const y = height - ((p.price_krw! - minP) / span) * (height - 4) - 2
      return [x, y] as const
    })

  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')

  // base price line
  const baseY =
    basePrice != null && basePrice >= minP && basePrice <= maxP
      ? height - ((basePrice - minP) / span) * (height - 4) - 2
      : null

  // current price marker (last point)
  const last = coords[coords.length - 1]

  return (
    <svg width={width} height={height} className="overflow-visible">
      {baseY != null && (
        <line x1={0} x2={width} y1={baseY} y2={baseY} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="2,2" />
      )}
      <path d={path} fill="none" stroke="#0ea5e9" strokeWidth={1.5} />
      {last && <circle cx={last[0]} cy={last[1]} r={2.5} fill="#0ea5e9" />}
    </svg>
  )
}

function ConfidenceBadge({ c }: { c: number }) {
  const pct = Math.round(c * 100)
  const color =
    c >= 0.7 ? 'bg-green-100 text-green-800' : c >= 0.4 ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${color}`}>{pct}%</span>
}

function DaysToBadge({ d }: { d: number | null }) {
  if (d == null) return <span className="text-xs text-gray-400">—</span>
  if (d < 0) return <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-100 text-rose-700 font-semibold">진행중 {d}d</span>
  if (d <= 3) return <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-100 text-rose-700 font-semibold">D-{d}</span>
  if (d <= 7) return <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 font-semibold">D-{d}</span>
  return <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600">D-{d}</span>
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/discount-cycle' + (qs ? `?${qs}` : '')
}

interface CategoryAgg {
  cate_cd: string
  cate_label: string | null
  sku_count: number
  avg_period: number
  avg_depth: number
  high_conf_count: number
  soon_count: number
}

function aggregateByCategory(rows: CycleRow[]): CategoryAgg[] {
  const m = new Map<string, CategoryAgg>()
  for (const r of rows) {
    if (!r.cate_cd) continue
    const key = r.cate_cd
    const acc = m.get(key) ?? {
      cate_cd: key,
      cate_label: r.cate_label,
      sku_count: 0,
      avg_period: 0,
      avg_depth: 0,
      high_conf_count: 0,
      soon_count: 0,
    }
    acc.sku_count += 1
    acc.avg_period += r.period_days ?? 0
    acc.avg_depth += r.discount_depth_avg ?? 0
    if (r.confidence >= 0.5) acc.high_conf_count += 1
    if (r.days_to_next_predicted_low != null && r.days_to_next_predicted_low >= -3 && r.days_to_next_predicted_low <= 7) {
      acc.soon_count += 1
    }
    m.set(key, acc)
  }
  for (const v of m.values()) {
    v.avg_period = v.sku_count > 0 ? v.avg_period / v.sku_count : 0
    v.avg_depth = v.sku_count > 0 ? v.avg_depth / v.sku_count : 0
  }
  return Array.from(m.values()).sort((a, b) => b.soon_count - a.soon_count)
}

export default async function DiscountCyclePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; conf?: string; cat?: string }>
}) {
  const sp = await searchParams
  const tab = (TAB_OPTIONS.some((t) => t.v === sp.tab) ? sp.tab : 'soon') as Tab
  const minConfidence = parseFloat(sp.conf ?? '0.5')
  const cat = sp.cat ?? ''

  const current: Record<string, string> = { tab, conf: String(minConfidence), cat }

  const { rows, error } = await fetchCycles({ minConfidence, tab, cat })

  // 표시 대상 (sparkline 은 상위 N개만 — 페이지 성능)
  const visibleRows = tab === 'category' ? rows : rows.slice(0, 80)
  const historyMap = await fetchHistory(visibleRows.map((r) => r.goods_no))

  const categoryAgg = aggregateByCategory(rows)
  const soonCount = rows.filter(
    (r) => r.days_to_next_predicted_low != null && r.days_to_next_predicted_low >= -3 && r.days_to_next_predicted_low <= 7,
  ).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">공급사 할인 사이클</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan SKU별 가격 시계열에서 학습한 할인 주기 — 핀 발행/광고/매입 타이밍을 예측 저점에 정렬한다.
            <span className="ml-2 px-2 py-0.5 bg-rose-100 text-rose-700 rounded text-xs">7일내 예측 {soonCount}</span>
          </p>
        </div>
        <div className="text-xs text-gray-500 text-right">
          view: <code className="text-amber-700">jimscanner_ggsan_discount_cycle</code>
          <br />
          최근 120일 가격 시계열 / 신뢰도≥{minConfidence}
        </div>
      </header>

      {/* 탭 */}
      <nav className="flex gap-1 border-b border-gray-200">
        {TAB_OPTIONS.map((t) => (
          <Link
            key={t.v}
            href={buildHref(current, { tab: t.v })}
            className={`px-4 py-2 text-sm border-b-2 ${tab === t.v ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {/* 신뢰도 필터 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">신뢰도:</span>
        {CONFIDENCE_OPTIONS.map((c) => (
          <Link
            key={c.v}
            href={buildHref(current, { conf: String(c.v) })}
            className={`px-2 py-1 text-xs rounded ${minConfidence === c.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            {c.label}
          </Link>
        ))}
        {cat && (
          <Link
            href={buildHref(current, { cat: null })}
            className="ml-auto px-2 py-1 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
          >
            ✕ 카테고리 필터({cat}) 해제
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          view 조회 실패: {error}
          <div className="mt-1 text-red-500">
            supabase/ggsan_discount_cycle.sql 마이그레이션을 실제 DB에 적용했는지 확인하세요.
          </div>
        </div>
      )}

      {tab === 'category' ? (
        // 카테고리 집계 보드
        <div className="rounded border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-right">사이클 SKU</th>
                <th className="px-3 py-2 text-right">평균 주기</th>
                <th className="px-3 py-2 text-right">평균 할인폭</th>
                <th className="px-3 py-2 text-right">고신뢰</th>
                <th className="px-3 py-2 text-right">7일내 예측</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {categoryAgg.map((c) => (
                <tr key={c.cate_cd} className="hover:bg-amber-50">
                  <td className="px-3 py-2 font-medium">
                    <span className="text-gray-400 text-xs font-mono mr-2">{c.cate_cd}</span>
                    {c.cate_label ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{c.sku_count}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.avg_period.toFixed(1)}일</td>
                  <td className="px-3 py-2 text-right font-mono">{c.avg_depth.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right font-mono">{c.high_conf_count}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.soon_count > 0 ? (
                      <span className="px-1.5 py-0.5 bg-rose-100 text-rose-700 rounded text-xs font-semibold">
                        {c.soon_count}
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={buildHref(current, { tab: 'soon', cat: c.cate_cd })}
                      className="text-xs text-amber-700 hover:underline"
                    >
                      SKU 보기 →
                    </Link>
                  </td>
                </tr>
              ))}
              {categoryAgg.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-gray-400">
                    사이클 데이터 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        // SKU 카드 큐
        <div>
          <div className="text-xs text-gray-500 mb-2">
            {rows.length.toLocaleString()}건 · {visibleRows.length}건 표시{rows.length > visibleRows.length && ` (전체 ${rows.length}건 중 상위 ${visibleRows.length}개 그래프 렌더)`}
          </div>
          {visibleRows.length === 0 ? (
            <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
              조건에 맞는 SKU 없음 — 신뢰도 기준을 낮춰보세요.
            </div>
          ) : (
            <div className="rounded border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">상품</th>
                    <th className="px-3 py-2 text-right">현재가</th>
                    <th className="px-3 py-2 text-right">정상가</th>
                    <th className="px-3 py-2 text-center">가격 차트</th>
                    <th className="px-3 py-2 text-right">평균 할인</th>
                    <th className="px-3 py-2 text-right">주기</th>
                    <th className="px-3 py-2 text-center">신뢰도</th>
                    <th className="px-3 py-2 text-center">다음 저점</th>
                    <th className="px-3 py-2 text-right">관측 횟수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleRows.map((r) => {
                    const history = historyMap.get(r.goods_no) ?? []
                    const isOnSale = (r.current_discount_pct ?? 0) >= 3
                    return (
                      <tr key={r.goods_no} className="hover:bg-amber-50">
                        <td className="px-3 py-2 max-w-xs">
                          <a
                            href={r.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener"
                            className="flex items-start gap-2 hover:text-amber-700"
                          >
                            {r.image_url && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.image_url} alt="" className="w-10 h-10 object-cover rounded" loading="lazy" />
                            )}
                            <div className="min-w-0">
                              <div className="text-xs text-gray-400">
                                {r.cate_label ?? r.cate_cd} {r.brand && `· ${r.brand}`}
                              </div>
                              <div className="text-sm line-clamp-2 leading-snug">{r.title}</div>
                            </div>
                          </a>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-sm">
                          <div className={isOnSale ? 'text-rose-600 font-semibold' : ''}>
                            {r.current_price != null ? `${r.current_price.toLocaleString()}원` : '—'}
                          </div>
                          {isOnSale && (
                            <div className="text-[10px] text-rose-500">-{r.current_discount_pct?.toFixed(1)}%</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                          {r.base_price?.toLocaleString()}원
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Sparkline points={history} basePrice={r.base_price} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {r.discount_depth_avg?.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{r.period_days?.toFixed(1)}일</td>
                        <td className="px-3 py-2 text-center">
                          <ConfidenceBadge c={r.confidence} />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <DaysToBadge d={r.days_to_next_predicted_low} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">{r.total_events}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 text-[11px] text-gray-400 space-y-1">
            <div>• 정상가 = 최근 120일 관측가의 p85 / 할인 이벤트 = base 대비 3%↓ 가격 군집</div>
            <div>• 주기 = 이벤트 간격 평균(일) / 신뢰도 = 샘플 수 × (1 - 주기 편차/평균)</div>
            <div>• 다음 저점 = 주기 - (마지막 저점 경과일). D-3 이내면 핀/광고/매입 보류 권장.</div>
          </div>
        </div>
      )}
    </div>
  )
}
