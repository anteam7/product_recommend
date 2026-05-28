import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ClockRow {
  category: string
  hour: number
  dow: number
  purchase_count: number
  purchase_amount: number
  buzz_count: number
}

interface OrderRow {
  product_name: string
  order_price: number | null
}

const DOW_LABELS = ['월', '화', '수', '목', '금', '토', '일'] // ISO 1..7 → idx 0..6
const HOURS = Array.from({ length: 24 }, (_, i) => i)

async function fetchClock(category: string | null): Promise<ClockRow[]> {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => {
      select: (cols: string) => {
        eq: (c: string, v: string) => Promise<{ data: ClockRow[] | null }>
        then?: never
      } & Promise<{ data: ClockRow[] | null }>
    }
  }
  // 뷰는 supabase 타입에 없어서 캐스팅 후 단순 fetch.
  const client = createAdminClient() as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => Promise<{ data: unknown[] | null }>
      } & Promise<{ data: unknown[] | null }>
    }
  }
  const base = client.from('jimscanner_demand_clock_v').select('*')
  const result = category ? await base.eq('category', category) : await base
  return (result.data ?? []) as ClockRow[]
}

async function fetchCategoriesAndPeak(): Promise<{ categories: string[]; totalsByCategory: Map<string, number> }> {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => {
      select: (c: string) => Promise<{ data: unknown[] | null }>
    }
  }
  const { data } = await sb.from('jimscanner_demand_clock_purchase_v').select('category, purchase_count')
  const totals = new Map<string, number>()
  for (const r of ((data ?? []) as Array<{ category: string; purchase_count: number }>)) {
    totals.set(r.category, (totals.get(r.category) ?? 0) + (r.purchase_count ?? 0))
  }
  const categories = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  return { categories, totalsByCategory: totals }
}

async function fetchTopSku(): Promise<{ name: string; count: number; sum: number }[]> {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        gte: (col: string, val: string) => {
          limit: (n: number) => Promise<{ data: OrderRow[] | null }>
        }
      }
    }
  }
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data } = await sb
    .from('jimscanner_coupang_orders')
    .select('product_name, order_price')
    .gte('ordered_at', since)
    .limit(5000)
  const map = new Map<string, { count: number; sum: number }>()
  for (const r of ((data ?? []) as OrderRow[])) {
    const v = map.get(r.product_name) ?? { count: 0, sum: 0 }
    v.count++
    v.sum += r.order_price ?? 0
    map.set(r.product_name, v)
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, count: v.count, sum: v.sum }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
}

function buildGrid(rows: ClockRow[], key: 'purchase_count' | 'purchase_amount' | 'buzz_count'): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
  for (const r of rows) {
    const d = (r.dow ?? 0) - 1 // ISO 1..7 → 0..6
    const h = r.hour ?? 0
    if (d < 0 || d > 6 || h < 0 || h > 23) continue
    grid[d][h] += Number(r[key] ?? 0)
  }
  return grid
}

function findPeak(grid: number[][]): { value: number; hour: number; dow: number } {
  let mx = 0, mh = 0, md = 0
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (grid[d][h] > mx) { mx = grid[d][h]; mh = h; md = d }
    }
  }
  return { value: mx, hour: mh, dow: md }
}

function computeLagMinutes(buzz: number[][], purchase: number[][]): number | null {
  const lags: number[] = []
  for (let d = 0; d < 7; d++) {
    const bMax = Math.max(...buzz[d])
    const pMax = Math.max(...purchase[d])
    if (bMax === 0 || pMax === 0) continue
    const bP = buzz[d].indexOf(bMax)
    const pP = purchase[d].indexOf(pMax)
    lags.push((pP - bP) * 60)
  }
  if (lags.length === 0) return null
  return Math.round(lags.reduce((a, b) => a + b, 0) / lags.length)
}

function heatColor(v: number, max: number, hue: 'red' | 'blue'): string {
  if (max === 0 || v === 0) return 'rgba(0,0,0,0.03)'
  const t = Math.min(1, v / max)
  if (hue === 'red') return `rgba(220, 38, 38, ${0.08 + t * 0.7})`
  return `rgba(37, 99, 235, ${0.08 + t * 0.7})`
}

export default async function DemandClockPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const sp = await searchParams
  const selected = sp.category && sp.category.length > 0 ? sp.category : null

  const [{ categories, totalsByCategory }, rows, topSku] = await Promise.all([
    fetchCategoriesAndPeak(),
    fetchClock(selected),
    fetchTopSku(),
  ])

  const purchaseGrid = buildGrid(rows, 'purchase_count')
  const amountGrid = buildGrid(rows, 'purchase_amount')
  const buzzGrid = buildGrid(rows, 'buzz_count')

  const purchaseMax = Math.max(0, ...purchaseGrid.flat())
  const buzzMax = Math.max(0, ...buzzGrid.flat())
  const purchasePeak = findPeak(purchaseGrid)
  const buzzPeak = findPeak(buzzGrid)
  const lagMinutes = computeLagMinutes(buzzGrid, purchaseGrid)
  const totalPurchase = purchaseGrid.flat().reduce((a, b) => a + b, 0)
  const totalAmount = amountGrid.flat().reduce((a, b) => a + b, 0)
  const totalBuzz = buzzGrid.flat().reduce((a, b) => a + b, 0)

  // 위험 셀: 버즈 정규화 >= 0.6 && 구매 정규화 < 0.3 — 매출 누수 의심
  const dangerCells = new Set<string>()
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const b = buzzMax ? buzzGrid[d][h] / buzzMax : 0
      const p = purchaseMax ? purchaseGrid[d][h] / purchaseMax : 0
      if (b >= 0.6 && p < 0.3) dangerCells.add(`${d}-${h}`)
    }
  }

  // 운영 추천 카드
  const recs: { tag: string; title: string; detail: string; tone: 'rose' | 'amber' | 'blue' | 'emerald' }[] = []
  if (purchasePeak.value > 0) {
    recs.push({
      tag: '광고 부스트',
      title: `${DOW_LABELS[purchasePeak.dow]} ${purchasePeak.hour}시 입찰가 +30%`,
      detail: `구매 피크 슬롯 (${purchasePeak.value.toLocaleString()}건). 동 시간대 재고 사전 충원 권장.`,
      tone: 'rose',
    })
  }
  if (buzzPeak.value > 0) {
    recs.push({
      tag: '라이브커머스',
      title: `${DOW_LABELS[buzzPeak.dow]} ${buzzPeak.hour}시 편성 후보`,
      detail: `외부 버즈 피크 (${buzzPeak.value.toLocaleString()}건). 노출 정점 슬롯.`,
      tone: 'blue',
    })
  }
  if (lagMinutes != null && Math.abs(lagMinutes) >= 30) {
    const fwd = lagMinutes > 0
    recs.push({
      tag: 'lag 인사이트',
      title: fwd
        ? `버즈 → 구매 평균 +${lagMinutes}분 지연`
        : `구매가 버즈를 ${Math.abs(lagMinutes)}분 앞섬`,
      detail: fwd
        ? `버즈 감지 즉시 광고 자동 부스트 워크플로 권장 (lag window 안에서 전환 극대화)`
        : `외부 버즈에 의존하지 말고 자체 푸시 광고로 수요 견인 권장`,
      tone: 'amber',
    })
  }
  if (dangerCells.size > 0) {
    const sample = [...dangerCells].slice(0, 3).map((k) => {
      const [d, h] = k.split('-').map(Number)
      return `${DOW_LABELS[d]} ${h}시`
    }).join(', ')
    recs.push({
      tag: '매출 누수',
      title: `위험 셀 ${dangerCells.size}개 — 품절·노출 점검`,
      detail: `버즈는 강한데 구매 약함: ${sample}${dangerCells.size > 3 ? ' 외' : ''}. 재고/검색노출 알고리즘 점검 필요.`,
      tone: 'emerald',
    })
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">⏱ Demand Clock — 카테고리 시간대 수요 시계</h1>
          <p className="text-sm text-gray-500 mt-1">
            요일 × 시(KST) 히트맵 · 버즈 → 구매 lag 자동 계산 · 90일 윈도우
          </p>
        </div>
        <div className="text-xs text-gray-400">
          source: <code>jimscanner_demand_clock_v</code>
        </div>
      </header>

      {/* 카테고리 탭 */}
      <nav className="flex gap-2 flex-wrap border-b border-gray-200 pb-2">
        <Link
          href="/admin/trend-radar/demand-clock"
          className={`px-3 py-1.5 rounded text-sm ${!selected ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >
          전체
        </Link>
        {categories.slice(0, 14).map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/demand-clock?category=${encodeURIComponent(c)}`}
            className={`px-3 py-1.5 rounded text-sm ${selected === c ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100'}`}
            title={`${(totalsByCategory.get(c) ?? 0).toLocaleString()}건`}
          >
            {c}
            <span className="ml-1 text-[10px] opacity-60">{(totalsByCategory.get(c) ?? 0).toLocaleString()}</span>
          </Link>
        ))}
      </nav>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPI label="구매 피크" value={purchasePeak.value > 0 ? `${DOW_LABELS[purchasePeak.dow]} ${purchasePeak.hour}시` : '—'} hint={`${purchasePeak.value.toLocaleString()}건`} />
        <KPI label="버즈 피크" value={buzzPeak.value > 0 ? `${DOW_LABELS[buzzPeak.dow]} ${buzzPeak.hour}시` : '—'} hint={`${buzzPeak.value.toLocaleString()}건`} />
        <KPI label="평균 lag" value={lagMinutes == null ? '—' : `${lagMinutes > 0 ? '+' : ''}${lagMinutes}분`} hint="버즈 → 구매" />
        <KPI label="90일 총 주문" value={totalPurchase.toLocaleString()} hint={`매출 ${totalAmount.toLocaleString()}원`} />
        <KPI label="위험 셀" value={`${dangerCells.size}`} hint="버즈高·구매低" />
      </section>

      {/* 히트맵 — 구매 */}
      <Heatmap
        title="🛒 구매 무게 (Coupang 주문 건수)"
        grid={purchaseGrid}
        max={purchaseMax}
        hue="red"
        dangerCells={dangerCells}
      />
      <Heatmap
        title="📢 버즈 무게 (naver_news + naver_blog + quasarzone_sale)"
        grid={buzzGrid}
        max={buzzMax}
        hue="blue"
        dangerCells={null}
      />

      {/* 운영 추천 */}
      <section>
        <h2 className="text-lg font-semibold mb-3">💡 운영 액션 카드</h2>
        {recs.length === 0 ? (
          <div className="text-sm text-gray-500">데이터 부족 — 주문/버즈 신호가 더 쌓이면 추천이 채워집니다.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {recs.map((r, i) => <RecCard key={i} {...r} />)}
          </div>
        )}
      </section>

      {/* Top SKU — 드릴다운 대체 (가벼운 베스트셀러 보드) */}
      <section>
        <h2 className="text-lg font-semibold mb-3">🏆 최근 30일 Top SKU</h2>
        <div className="rounded border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left p-2 pl-3">상품명</th>
                <th className="text-right p-2 w-24">주문</th>
                <th className="text-right p-2 w-32 pr-3">매출</th>
              </tr>
            </thead>
            <tbody>
              {topSku.map((s, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  <td className="p-2 pl-3 truncate max-w-md">{s.name}</td>
                  <td className="p-2 text-right">{s.count.toLocaleString()}</td>
                  <td className="p-2 text-right pr-3">{s.sum.toLocaleString()}원</td>
                </tr>
              ))}
              {topSku.length === 0 && (
                <tr>
                  <td className="p-4 text-center text-gray-400" colSpan={3}>데이터 없음</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-gray-400 leading-relaxed">
        ※ 빨간 테두리 = 버즈는 강하지만 구매가 약한 셀 (매출 누수 의심). 셀 위 hover 시 정확한 수치 표시.<br />
        ※ 카테고리 분류는 <code>jimscanner_coupang_listings.display_category_name</code> 기준. 버즈는 카테고리 무관 전역 합산 (단계적으로 카테고리 매핑 도입 예정).<br />
        ※ 버즈 시그널 ({totalBuzz.toLocaleString()}건) — 카테고리 매핑이 미정착이므로 모든 카테고리 탭에서 동일한 버즈 분포가 표시됩니다.
      </p>
    </div>
  )
}

function KPI({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-bold mt-0.5 truncate">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5 truncate">{hint}</div>}
    </div>
  )
}

function RecCard({ tag, title, detail, tone }: { tag: string; title: string; detail: string; tone: 'rose' | 'amber' | 'blue' | 'emerald' }) {
  const tones: Record<typeof tone, string> = {
    rose: 'border-rose-200 bg-rose-50',
    amber: 'border-amber-200 bg-amber-50',
    blue: 'border-blue-200 bg-blue-50',
    emerald: 'border-emerald-200 bg-emerald-50',
  }
  const tagTones: Record<typeof tone, string> = {
    rose: 'bg-rose-200 text-rose-800',
    amber: 'bg-amber-200 text-amber-800',
    blue: 'bg-blue-200 text-blue-800',
    emerald: 'bg-emerald-200 text-emerald-800',
  }
  return (
    <div className={`rounded border p-4 ${tones[tone]}`}>
      <div className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${tagTones[tone]}`}>{tag}</div>
      <div className="font-semibold text-sm mt-1.5">{title}</div>
      <div className="text-xs text-gray-700 mt-1 leading-relaxed">{detail}</div>
    </div>
  )
}

function Heatmap({
  title,
  grid,
  max,
  hue,
  dangerCells,
}: {
  title: string
  grid: number[][]
  max: number
  hue: 'red' | 'blue'
  dangerCells: Set<string> | null
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      <div className="overflow-x-auto rounded border border-gray-200 bg-white p-3">
        <table className="text-[10px] border-collapse">
          <thead>
            <tr>
              <th className="w-9"></th>
              {HOURS.map((h) => (
                <th key={h} className="w-7 h-6 text-gray-500 font-normal">
                  {h}
                </th>
              ))}
              <th className="w-12 pl-2 text-gray-500 font-normal">합계</th>
            </tr>
          </thead>
          <tbody>
            {DOW_LABELS.map((label, d) => {
              const rowSum = grid[d].reduce((a, b) => a + b, 0)
              return (
                <tr key={d}>
                  <td className="w-9 pr-2 text-right text-gray-700 font-medium">{label}</td>
                  {HOURS.map((h) => {
                    const v = grid[d][h]
                    const isDanger = dangerCells?.has(`${d}-${h}`) ?? false
                    return (
                      <td
                        key={h}
                        className="w-7 h-7 text-center align-middle border border-white"
                        style={{
                          background: heatColor(v, max, hue),
                          outline: isDanger ? '2px solid #dc2626' : undefined,
                          outlineOffset: isDanger ? '-2px' : undefined,
                        }}
                        title={`${label} ${h}시 — ${v.toLocaleString()}`}
                      >
                        {v > 0 && v >= max * 0.15 ? (
                          <span className="text-[9px] text-gray-800">{v}</span>
                        ) : null}
                      </td>
                    )
                  })}
                  <td className="w-12 pl-2 text-right text-gray-600 font-medium">{rowSum.toLocaleString()}</td>
                </tr>
              )
            })}
            <tr>
              <td className="pr-2 text-right text-gray-500 text-[10px]">합계</td>
              {HOURS.map((h) => {
                const colSum = grid.reduce((a, row) => a + row[h], 0)
                return (
                  <td key={h} className="text-center text-gray-500 text-[9px]">
                    {colSum > 0 ? colSum : ''}
                  </td>
                )
              })}
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
