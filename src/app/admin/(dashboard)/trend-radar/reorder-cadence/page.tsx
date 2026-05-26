import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CycleRow {
  id: string
  product_id: string
  source: string
  cycle_days: number
  peak_strength: number
  confidence: number
  p_value: number | null
  segment: 'consumable' | 'repeatable' | 'durable' | string
  series_length: number
  series_start: string | null
  series_end: string | null
  acf_top_lags: Array<{ lag: number; acf: number }>
  ltv_proxy_krw: number | null
  ltv_basis_price: number | null
  computed_at: string
  product?: {
    id: string
    canonical_name: string
    category_top: string
    category_mid: string | null
    brand: string | null
    alias_count: number
  } | null
}

type Segment = 'all' | 'consumable' | 'repeatable' | 'durable'

const SEGMENTS: { v: Segment; label: string; range: string; color: string }[] = [
  { v: 'all', label: '전체', range: '— 모든 cycle', color: 'gray' },
  { v: 'consumable', label: 'consumable', range: '≤ 45일', color: 'red' },
  { v: 'repeatable', label: 'repeatable', range: '46 ~ 120일', color: 'amber' },
  { v: 'durable', label: 'durable', range: '> 120일', color: 'blue' },
]

async function fetchCycles(seg: Segment) {
  const sb = createAdminClient()
  // Table not yet in generated types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = (sb as any)
    .from('jimscanner_trends_reorder_cycle')
    .select(
      'id, product_id, source, cycle_days, peak_strength, confidence, p_value, segment, series_length, series_start, series_end, acf_top_lags, ltv_proxy_krw, ltv_basis_price, computed_at',
    )
    .order('confidence', { ascending: false })
    .limit(500)
  if (seg !== 'all') q.eq('segment', seg)
  const { data, error } = await q
  if (error) return { rows: [] as CycleRow[], error: error.message }

  const rows = (data ?? []) as CycleRow[]
  if (rows.length === 0) return { rows, error: null as string | null }

  const ids = [...new Set(rows.map((r) => r.product_id))]
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand, alias_count')
    .in('id', ids)
  const pmap = new Map<string, NonNullable<CycleRow['product']>>()
  for (const p of (prods ?? []) as NonNullable<CycleRow['product']>[]) {
    pmap.set(p.id, p)
  }
  for (const r of rows) r.product = pmap.get(r.product_id) ?? null
  return { rows, error: null }
}

function buildHref(seg: Segment): string {
  if (seg === 'all') return '/admin/trend-radar/reorder-cadence'
  return `/admin/trend-radar/reorder-cadence?seg=${seg}`
}

function histBins(rows: CycleRow[]): Array<{ label: string; from: number; to: number; count: number }> {
  const bins = [
    { label: '7-14d', from: 7, to: 14, count: 0 },
    { label: '15-30d', from: 15, to: 30, count: 0 },
    { label: '31-45d', from: 31, to: 45, count: 0 },
    { label: '46-60d', from: 46, to: 60, count: 0 },
    { label: '61-90d', from: 61, to: 90, count: 0 },
    { label: '91-120d', from: 91, to: 120, count: 0 },
    { label: '121d+', from: 121, to: 999, count: 0 },
  ]
  for (const r of rows) {
    for (const b of bins) {
      if (r.cycle_days >= b.from && r.cycle_days <= b.to) {
        b.count++
        break
      }
    }
  }
  return bins
}

function segBadge(s: string) {
  if (s === 'consumable') return 'bg-red-100 text-red-700'
  if (s === 'repeatable') return 'bg-amber-100 text-amber-700'
  if (s === 'durable') return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-600'
}

export default async function ReorderCadencePage({
  searchParams,
}: {
  searchParams: Promise<{ seg?: string }>
}) {
  const sp = await searchParams
  const seg = (SEGMENTS.some((s) => s.v === sp.seg) ? (sp.seg as Segment) : 'all') as Segment

  const { rows, error } = await fetchCycles(seg)

  const counts = {
    all: rows.length,
    consumable: rows.filter((r) => r.segment === 'consumable').length,
    repeatable: rows.filter((r) => r.segment === 'repeatable').length,
    durable: rows.filter((r) => r.segment === 'durable').length,
  }

  const avgLtv =
    rows.filter((r) => r.ltv_proxy_krw != null).reduce((s, r) => s + (r.ltv_proxy_krw ?? 0), 0) /
    Math.max(1, rows.filter((r) => r.ltv_proxy_krw != null).length)

  const bins = histBins(rows)
  const maxBin = Math.max(1, ...bins.map((b) => b.count))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔁 Reorder Cadence — Consumable LTV 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            Naver search·shopping 일별 시계열 ACF 로 자연 재구매 주기 추정 ·
            consumable(≤45d) 은 구독·정기배송 전환 게이트
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>왜 reorder?</strong> · 위탁 판매 단위 ROI 는 단가·마진보다 LTV(재구매 횟수)가 5~10x
        큰 레버. 현재 4점수(trend·commerce·supplier·competition) 모델은 LTV proxy 부재 — 1회성
        hype SKU 와 진성 소모재를 구분 못 함. ACF 로 product 별 자연 주기(τ)를 잡고
        365/τ × price 로 연간 매출 추정.
      </div>

      {/* Segment 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {SEGMENTS.map((s) => (
          <Link
            key={s.v}
            href={buildHref(s.v)}
            className={`px-3 py-2 text-sm ${
              seg === s.v
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {s.label}{' '}
            <span className="text-xs text-gray-400">
              {counts[s.v === 'all' ? 'all' : (s.v as 'consumable' | 'repeatable' | 'durable')]}
            </span>
          </Link>
        ))}
      </nav>

      {/* KPI cards */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SegCard
          label="consumable"
          range="≤ 45일"
          count={counts.consumable}
          tone="red"
          hint="구독·정기배송 후보"
        />
        <SegCard
          label="repeatable"
          range="46~120일"
          count={counts.repeatable}
          tone="amber"
          hint="cross-sell·번들"
        />
        <SegCard
          label="durable"
          range="> 120일"
          count={counts.durable}
          tone="blue"
          hint="단발 ROI 위주"
        />
        <SegCard
          label="평균 LTV proxy"
          range="price × 365÷cycle"
          count={Math.round(avgLtv).toLocaleString()}
          tone="gray"
          hint="공급가 기준 연 매출 추정"
          suffix="원"
        />
      </section>

      {/* Histogram */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-3">cycle_days 분포</h2>
        <div className="space-y-1">
          {bins.map((b) => (
            <div key={b.label} className="flex items-center gap-3 text-xs">
              <div className="w-16 font-mono text-gray-500">{b.label}</div>
              <div className="flex-1 bg-gray-100 h-5 rounded overflow-hidden relative">
                <div
                  className="h-full bg-indigo-500/70"
                  style={{ width: `${(b.count / maxBin) * 100}%` }}
                />
              </div>
              <div className="w-12 text-right font-mono">{b.count}</div>
            </div>
          ))}
        </div>
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            마이그레이션 <code>supabase/trends_v4_reorder_cycle.sql</code> 미적용 가능성. 적용 후
            <code className="ml-1">node --env-file=.env.local scripts/scan-reorder-cadence.mjs</code> 실행.
          </p>
        </div>
      )}

      {/* Top reorder 후보 큐 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 검출된 cycle 없음</div>
          <div className="text-xs text-gray-400">
            naver_search_trend 가 21일 이상 누적되어야 ACF peak 검출 가능.
            <br />
            지금 단계에서는 데이터 축적 대기 — 매일 KST 03:30 cron 자동 누적.
          </div>
        </div>
      ) : (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Top reorder 후보 핀 큐 (정렬: confidence)</h2>
          {rows.slice(0, 100).map((r, i) => (
            <Link
              key={r.id}
              href={`/admin/trend-radar/products/${r.product_id}`}
              className="grid grid-cols-12 gap-2 items-center px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors text-sm"
            >
              <div className="col-span-1 font-mono text-gray-400 text-xs">{i + 1}</div>
              <div className="col-span-4">
                <div className="font-medium truncate" title={r.product?.canonical_name ?? r.product_id}>
                  {r.product?.canonical_name ?? r.product_id.slice(0, 8)}
                </div>
                <div className="text-xs text-gray-500">
                  {r.product?.brand ? `${r.product.brand} · ` : ''}
                  {r.product?.category_top ?? '?'}
                  {r.product?.category_mid ? ` / ${r.product.category_mid}` : ''}
                </div>
              </div>
              <div className="col-span-1 text-center">
                <span className={`text-[10px] px-2 py-0.5 rounded ${segBadge(r.segment)}`}>
                  {r.segment}
                </span>
              </div>
              <div className="col-span-1 text-right font-mono">
                <div className="text-base font-bold text-indigo-700">{r.cycle_days}d</div>
                <div className="text-[10px] text-gray-400">cycle</div>
              </div>
              <div className="col-span-1 text-right font-mono">
                <div className="text-sm font-semibold">{r.peak_strength.toFixed(2)}</div>
                <div className="text-[10px] text-gray-400">acf peak</div>
              </div>
              <div className="col-span-1 text-right font-mono">
                <div className="text-sm">{r.confidence.toFixed(2)}</div>
                <div className="text-[10px] text-gray-400">conf</div>
              </div>
              <div className="col-span-1 text-right font-mono text-[10px] text-gray-500">
                p={r.p_value != null ? r.p_value.toExponential(1) : '—'}
              </div>
              <div className="col-span-1 text-right font-mono text-xs text-gray-500">
                N={r.series_length}d
              </div>
              <div className="col-span-1 text-right font-mono">
                {r.ltv_proxy_krw != null ? (
                  <>
                    <div className="text-sm font-semibold text-emerald-700">
                      {r.ltv_proxy_krw.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-gray-400">LTV 추정 (원/년)</div>
                  </>
                ) : (
                  <span className="text-[10px] text-gray-400">no price</span>
                )}
              </div>
            </Link>
          ))}
        </section>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 ACF 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          r(k) = Σ (x[t] - μ)(x[t+k] - μ) ÷ Σ (x[t] - μ)²
          <br />
          peak: argmax over lag k ∈ [7, 90] · 통과 조건: r(k) &gt; 0.3, p &lt; 0.05 (Bartlett 근사)
          <br />
          LTV proxy = price_krw × (365 ÷ cycle_days)
        </code>
        <div className="pt-2">
          <strong>알고 있는 한계:</strong> shopping_insight 카테고리 series 미반영 (v2),
          21일 미만 series 는 무시, gap-filling 은 zero (저주파에서 peak 의 lag 가 약간 흔들릴 수 있음).
        </div>
      </section>
    </div>
  )
}

function SegCard({
  label,
  range,
  count,
  hint,
  tone,
  suffix,
}: {
  label: string
  range: string
  count: number | string
  hint: string
  tone: 'red' | 'amber' | 'blue' | 'gray'
  suffix?: string
}) {
  const border =
    tone === 'red' ? 'border-red-200 bg-red-50/40'
    : tone === 'amber' ? 'border-amber-200 bg-amber-50/40'
    : tone === 'blue' ? 'border-blue-200 bg-blue-50/40'
    : 'border-gray-200'
  const accent =
    tone === 'red' ? 'text-red-700'
    : tone === 'amber' ? 'text-amber-700'
    : tone === 'blue' ? 'text-blue-700'
    : 'text-gray-700'
  return (
    <div className={`rounded border p-3 ${border}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-[10px] text-gray-400 mb-1">{range}</div>
      <div className={`text-2xl font-bold ${accent}`}>
        {count}
        {suffix ? <span className="text-sm font-normal text-gray-500 ml-1">{suffix}</span> : null}
      </div>
      <div className="text-[10px] text-gray-500 mt-1">{hint}</div>
    </div>
  )
}
