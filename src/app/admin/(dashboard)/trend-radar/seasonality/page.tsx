import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SeasonalityRow {
  subject_kind: 'product' | 'category'
  product_id: string | null
  category_key: string | null
  period_month: number
  seasonal_index: number
  sample_count: number
  peak_month: number | null
  trough_month: number | null
  amp_ratio: number | null
  fit_quality: number
  lead_time_days_default: number
  inherited_from_category: boolean
  computed_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

function kstNow() {
  return new Date(Date.now() + 9 * 3600_000)
}

function currentMonthKST() {
  return kstNow().getUTCMonth() + 1 // 1..12
}

function daysToNextMonth(targetMonth: number, leadTime: number): { peakDate: Date; daysToPeak: number; sourcingStart: Date } {
  // 다음 targetMonth 15일 (한 달 중간) 을 peak 로 가정.
  const now = kstNow()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  let peakYear = y
  if (targetMonth < m || (targetMonth === m && now.getUTCDate() > 15)) peakYear = y + 1
  const peakDate = new Date(Date.UTC(peakYear, targetMonth - 1, 15))
  const daysToPeak = Math.round((peakDate.getTime() - now.getTime()) / 86400_000)
  const sourcingStart = new Date(peakDate.getTime() - (leadTime + 30) * 86400_000)
  return { peakDate, daysToPeak, sourcingStart }
}

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

async function fetchSeasonalityData() {
  const sb = createAdminClient()

  // 모든 seasonality row (제한 충분히 크게)
  const { data: rows, error } = await sb
    .from('jimscanner_trends_seasonality' as never)
    .select('*')
    .limit(10000)

  if (error || !rows) {
    return { byProduct: new Map<string, SeasonalityRow[]>(), byCategory: new Map<string, SeasonalityRow[]>(), products: [], error: error?.message ?? null }
  }

  const all = rows as unknown as SeasonalityRow[]

  const byProduct = new Map<string, SeasonalityRow[]>()
  const byCategory = new Map<string, SeasonalityRow[]>()
  for (const r of all) {
    if (r.subject_kind === 'product' && r.product_id) {
      const list = byProduct.get(r.product_id) ?? []
      list.push(r)
      byProduct.set(r.product_id, list)
    } else if (r.subject_kind === 'category' && r.category_key) {
      const list = byCategory.get(r.category_key) ?? []
      list.push(r)
      byCategory.set(r.category_key, list)
    }
  }

  const productIds = [...byProduct.keys()]
  let products: ProductRow[] = []
  if (productIds.length > 0) {
    const { data: prodData } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds)
    products = (prodData ?? []) as ProductRow[]
  }

  return { byProduct, byCategory, products, error: null as string | null }
}

interface Card {
  subjectKey: string
  subjectLabel: string
  subjectSubtitle: string
  isCategory: boolean
  inherited: boolean
  currentIdx: number
  peakMonth: number
  troughMonth: number
  ampRatio: number | null
  fitQuality: number
  leadTime: number
  daysToPeak: number
  peakDate: Date
  sourcingStart: Date
  isTroughBottom: boolean
  monthly: number[] // 12
}

function buildCard(args: {
  subjectKey: string
  subjectLabel: string
  subjectSubtitle: string
  isCategory: boolean
  rows: SeasonalityRow[]
}): Card | null {
  const { rows } = args
  if (rows.length === 0) return null
  // monthly 12
  const monthly = new Array(12).fill(1)
  for (const r of rows) {
    monthly[r.period_month - 1] = Number(r.seasonal_index)
  }
  const meta = rows[0]
  const cm = currentMonthKST()
  const currentIdx = monthly[cm - 1]
  const peakMonth = meta.peak_month ?? 1
  const troughMonth = meta.trough_month ?? 1
  const leadTime = meta.lead_time_days_default ?? 21
  const { peakDate, daysToPeak, sourcingStart } = daysToNextMonth(peakMonth, leadTime)
  return {
    subjectKey: args.subjectKey,
    subjectLabel: args.subjectLabel,
    subjectSubtitle: args.subjectSubtitle,
    isCategory: args.isCategory,
    inherited: meta.inherited_from_category,
    currentIdx,
    peakMonth,
    troughMonth,
    ampRatio: meta.amp_ratio == null ? null : Number(meta.amp_ratio),
    fitQuality: Number(meta.fit_quality),
    leadTime,
    daysToPeak,
    peakDate,
    sourcingStart,
    isTroughBottom: currentIdx < 0.7,
    monthly,
  }
}

function MiniBarChart({ values, current }: { values: number[]; current: number }) {
  // 12개월 미니 바차트. 0~2 가정.
  const max = Math.max(...values, 1.5)
  return (
    <div className="flex items-end gap-[2px] h-8">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * 32)
        const isCurrent = i + 1 === current
        const isLow = v < 0.7
        const isHigh = v > 1.3
        const color = isCurrent
          ? 'bg-black'
          : isHigh
          ? 'bg-red-300'
          : isLow
          ? 'bg-blue-300'
          : 'bg-gray-300'
        return (
          <div
            key={i}
            className={`w-2 rounded-sm ${color}`}
            style={{ height: `${h}px` }}
            title={`M${i + 1}: ${v.toFixed(2)}`}
          />
        )
      })}
    </div>
  )
}

export default async function SeasonalityPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; cat?: string }>
}) {
  const sp = await searchParams
  const view = sp.view === 'product' ? 'product' : sp.view === 'all' ? 'all' : 'category'
  const catFilter = sp.cat ?? 'all'

  const { byProduct, byCategory, products, error } = await fetchSeasonalityData()

  const currentMonth = currentMonthKST()

  // category cards
  const categoryCards: Card[] = []
  for (const [key, rows] of byCategory.entries()) {
    const c = buildCard({
      subjectKey: `cat:${key}`,
      subjectLabel: CATEGORY_LABEL[key] ?? key,
      subjectSubtitle: `카테고리 · ${rows[0]?.sample_count ?? 0}+ 샘플`,
      isCategory: true,
      rows,
    })
    if (c) categoryCards.push(c)
  }

  // product cards
  const productMap = new Map(products.map((p) => [p.id, p]))
  const productCards: Card[] = []
  for (const [pid, rows] of byProduct.entries()) {
    const p = productMap.get(pid)
    if (!p) continue
    if (catFilter !== 'all' && p.category_top !== catFilter) continue
    const c = buildCard({
      subjectKey: `p:${pid}`,
      subjectLabel: p.canonical_name,
      subjectSubtitle: `${CATEGORY_LABEL[p.category_top] ?? p.category_top}${rows[0]?.inherited_from_category ? ' · 카테고리 상속' : ''}`,
      isCategory: false,
      rows,
    })
    if (c) productCards.push(c)
  }

  // 정렬: 비수기 바닥(idx<0.7) + D-day 가까운 순
  const sortCards = (arr: Card[]) =>
    [...arr].sort((a, b) => {
      // 1) 비수기 바닥 + 곧 peak 인 것 우선
      const aScore = (a.isTroughBottom ? 1000 : 0) - Math.max(0, a.daysToPeak)
      const bScore = (b.isTroughBottom ? 1000 : 0) - Math.max(0, b.daysToPeak)
      return bScore - aScore
    })

  const visibleCards =
    view === 'category' ? sortCards(categoryCards)
    : view === 'product' ? sortCards(productCards)
    : sortCards([...categoryCards, ...productCards])

  const sourcingNow = visibleCards.filter((c) => {
    // 권장 소싱 시작일이 이미 지났거나 이번주 안
    const today = kstNow().getTime()
    return c.sourcingStart.getTime() <= today + 7 * 86400_000 && c.daysToPeak > 14
  }).length
  const troughCount = visibleCards.filter((c) => c.isTroughBottom).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🌊 계절성 · 비수기 소싱 윈도우</h1>
          <p className="text-sm text-gray-500 mt-1">
            24개월 시계열을 STL-lite 로 분해 — trend 를 제거한 seasonal_index 로 진성 쇠퇴 vs 주기적 휴면 구분.
            비수기 바닥(idx&lt;0.7)에서 소싱, peak − lead_time − 30d 에 진입.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          데이터 조회 오류: {error}
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="현재 월 (KST)" value={`M${currentMonth}`} hint={fmtDate(kstNow())} />
        <KpiCard label="비수기 바닥 SKU" value={troughCount} hint="seasonal_index < 0.7" />
        <KpiCard label="소싱 시작 윈도우" value={sourcingNow} hint="권장 시작일 ≤ +7d" />
        <KpiCard label="총 분석 단위" value={visibleCards.length} hint={`view=${view}`} />
      </section>

      {/* 뷰 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {[
          { v: 'category', label: '카테고리 인덱스' },
          { v: 'product', label: '상품 인덱스' },
          { v: 'all', label: '전체' },
        ].map((t) => (
          <Link
            key={t.v}
            href={`/admin/trend-radar/seasonality?view=${t.v}${catFilter !== 'all' ? `&cat=${catFilter}` : ''}`}
            className={`px-3 py-2 text-sm ${
              view === t.v
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {t.label}
          </Link>
        ))}
        {view !== 'category' && (
          <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
            카테고리:
            {(['all', 'health', 'living', 'digital'] as const).map((c) => (
              <Link
                key={c}
                href={`/admin/trend-radar/seasonality?view=${view}&cat=${c}`}
                className={`px-2 py-1 rounded ${
                  catFilter === c ? 'bg-black text-white' : 'text-gray-500 hover:text-black'
                }`}
              >
                {c === 'all' ? '전체' : CATEGORY_LABEL[c] ?? c}
              </Link>
            ))}
          </div>
        )}
      </nav>

      {visibleCards.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 border-b border-gray-200">
            <div className="col-span-3">대상</div>
            <div className="col-span-2">월별 인덱스</div>
            <div className="col-span-1 text-right">현재 idx</div>
            <div className="col-span-1 text-right">peak</div>
            <div className="col-span-1 text-right">D-day</div>
            <div className="col-span-1 text-right">amp×</div>
            <div className="col-span-2">권장 소싱 시작</div>
            <div className="col-span-1 text-right">fit</div>
          </div>
          {visibleCards.slice(0, 200).map((c) => (
            <div
              key={c.subjectKey}
              className={`grid grid-cols-12 px-3 py-2 rounded border items-center transition-colors ${
                c.isTroughBottom
                  ? 'border-blue-300 bg-blue-50/40 hover:bg-blue-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="col-span-3">
                <div className="font-medium flex items-center gap-2">
                  {c.isTroughBottom && (
                    <span className="text-[10px] font-bold uppercase bg-blue-600 text-white px-1.5 py-0.5 rounded">
                      바닥
                    </span>
                  )}
                  {c.inherited && (
                    <span className="text-[10px] uppercase bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">
                      상속
                    </span>
                  )}
                  {c.isCategory && (
                    <span className="text-[10px] uppercase bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded">
                      cat
                    </span>
                  )}
                  <span className="truncate">{c.subjectLabel}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{c.subjectSubtitle}</div>
              </div>
              <div className="col-span-2">
                <MiniBarChart values={c.monthly} current={currentMonth} />
              </div>
              <div className="col-span-1 text-right font-mono">
                <span
                  className={
                    c.currentIdx < 0.7
                      ? 'text-blue-700 font-bold'
                      : c.currentIdx > 1.3
                      ? 'text-red-700 font-bold'
                      : 'text-gray-700'
                  }
                >
                  {c.currentIdx.toFixed(2)}
                </span>
              </div>
              <div className="col-span-1 text-right font-mono text-gray-700">M{c.peakMonth}</div>
              <div className="col-span-1 text-right font-mono">
                {c.daysToPeak >= 0 ? `+${c.daysToPeak}d` : `${c.daysToPeak}d`}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {c.ampRatio == null ? '—' : `${c.ampRatio.toFixed(1)}×`}
              </div>
              <div className="col-span-2 text-xs">
                <div className="font-mono text-gray-700">{fmtDate(c.sourcingStart)}</div>
                <div className="text-gray-400">
                  peak {fmtDate(c.peakDate)} − {c.leadTime}d − 30d
                </div>
              </div>
              <div className="col-span-1 text-right text-xs text-gray-500">
                {Math.round(c.fitQuality * 100)}%
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="text-xs text-gray-500 border-t pt-3 mt-6">
        재계산: <code className="px-1 bg-gray-100 rounded">node scripts/compute-seasonality.mjs</code>{' '}
        · 24개월 윈도우 · 12-month centered MA detrend · ratio 모드. fit_quality &lt; 50% 인 product 는
        카테고리 인덱스를 상속.
      </div>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 계절성 인덱스가 계산되지 않았습니다</p>
      <p className="text-sm mt-2">
        24개월 키워드 히스토리가 누적된 후 아래 스크립트를 실행하세요:
      </p>
      <p className="text-xs mt-3 font-mono bg-gray-50 inline-block px-3 py-1 rounded border border-gray-200">
        node scripts/compute-seasonality.mjs
      </p>
      <p className="text-xs mt-4 text-gray-400">
        필요 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
      </p>
    </div>
  )
}
