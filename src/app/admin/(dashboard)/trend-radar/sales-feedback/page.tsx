import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 실수익 = 매출 − 매입원가 − 수수료(10.6%) − 부가세(÷11) — coupang-orders/page.tsx 와 동일 상수 유지
const FEE_RATE = 0.106
const VAT_DIVISOR = 11

const PERIOD_OPTIONS = [
  { v: 30, label: '30일' },
  { v: 90, label: '90일' },
  { v: 0, label: '전체' },
] as const

// 발굴 트리거 시그널 → 한글 라벨/색. listings.origin_signal 값과 매핑.
const SIGNAL_LABELS: Record<string, { label: string; cls: string }> = {
  tv: { label: 'TV 편성', cls: 'bg-rose-100 text-rose-700' },
  search_surge: { label: '검색 급등', cls: 'bg-amber-100 text-amber-700' },
  hotdeal: { label: '핫딜', cls: 'bg-orange-100 text-orange-700' },
  wholesale_new: { label: '도매 신상', cls: 'bg-emerald-100 text-emerald-700' },
  stl_season: { label: 'STL 시즌', cls: 'bg-sky-100 text-sky-700' },
  naver_hot: { label: '네이버 인기', cls: 'bg-green-100 text-green-700' },
  manual: { label: '수동 선별', cls: 'bg-violet-100 text-violet-700' },
  __untagged__: { label: '미태깅', cls: 'bg-zinc-100 text-zinc-500' },
}

function signalMeta(sig: string | null | undefined) {
  const key = sig && SIGNAL_LABELS[sig] ? sig : '__untagged__'
  return { key, ...SIGNAL_LABELS[key] }
}

interface ListingLite {
  seller_product_id: number | null
  registered_title: string
  status: string
  displayable: boolean | null
  origin_signal: string | null
  dome_price_krw: number | null
  estimated_margin_pct: number | null
}

interface OrderLite {
  seller_product_id: number | null
  shipping_count: number | null
  order_price: number | null
  purchase_total_cost: number | null
  purchase_status: string
  ordered_at: string
}

interface SkuPnl {
  seller_product_id: number
  title: string
  signal: string | null
  status: string
  units: number
  revenue: number
  cost: number
  fee: number
  vat: number
  net: number
  costMissing: number
}

interface Cohort {
  key: string
  label: string
  cls: string
  skuCount: number       // 코호트에 속한 발행 SKU 수
  soldSkuCount: number   // 1건 이상 판매된 SKU 수
  breakevenCount: number // 누적 실수익 ≥ 0 인 판매 SKU 수
  units: number
  revenue: number
  cost: number
  net: number
  costMissing: number
}

function periodCutoff(days: number): number | null {
  return days > 0 ? Date.now() - days * 86400000 : null
}

async function fetchData(days: number) {
  // 신규 컬럼(origin_signal) — generated types 갱신 전까지 임시 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  const [listingsResp, ordersResp] = await Promise.all([
    sb
      .from('jimscanner_coupang_listings')
      .select('seller_product_id, registered_title, status, displayable, origin_signal, dome_price_krw, estimated_margin_pct')
      .not('seller_product_id', 'is', null)
      .limit(5000),
    sb
      .from('jimscanner_coupang_orders')
      .select('seller_product_id, shipping_count, order_price, purchase_total_cost, purchase_status, ordered_at')
      .not('seller_product_id', 'is', null)
      .limit(20000),
  ])

  const listings = (listingsResp.data ?? []) as ListingLite[]
  const orders = (ordersResp.data ?? []) as OrderLite[]

  // SKU(seller_product_id) → listing
  const listingMap = new Map<number, ListingLite>()
  for (const l of listings) {
    if (l.seller_product_id != null) listingMap.set(l.seller_product_id, l)
  }

  // 주문 집계 (기간/취소 필터)
  const cutoff = periodCutoff(days)
  const agg = new Map<number, SkuPnl>()
  for (const o of orders) {
    if (o.seller_product_id == null) continue
    if (o.purchase_status === 'CANCELLED') continue
    if (cutoff && new Date(o.ordered_at).getTime() < cutoff) continue
    const rev = o.order_price ?? 0
    const fee = Math.round(rev * FEE_RATE)
    const vat = Math.round(rev / VAT_DIVISOR)
    const cost = o.purchase_total_cost ?? 0
    const l = listingMap.get(o.seller_product_id)
    let row = agg.get(o.seller_product_id)
    if (!row) {
      row = {
        seller_product_id: o.seller_product_id,
        title: l?.registered_title ?? `SKU ${o.seller_product_id}`,
        signal: l?.origin_signal ?? null,
        status: l?.status ?? '—',
        units: 0, revenue: 0, cost: 0, fee: 0, vat: 0, net: 0, costMissing: 0,
      }
      agg.set(o.seller_product_id, row)
    }
    row.units += o.shipping_count ?? 0
    row.revenue += rev
    row.fee += fee
    row.vat += vat
    row.cost += cost
    row.net += rev - cost - fee - vat
    if (o.purchase_total_cost == null) row.costMissing++
  }

  const skus = [...agg.values()]

  // 코호트 = origin_signal 별. 발행 SKU 모수(listings)로 사장재고율 계산.
  const cohorts = new Map<string, Cohort>()
  function ensureCohort(sig: string | null): Cohort {
    const m = signalMeta(sig)
    let c = cohorts.get(m.key)
    if (!c) {
      c = { key: m.key, label: m.label, cls: m.cls, skuCount: 0, soldSkuCount: 0, breakevenCount: 0, units: 0, revenue: 0, cost: 0, net: 0, costMissing: 0 }
      cohorts.set(m.key, c)
    }
    return c
  }
  // 발행 SKU 모수: 판매 가능 상태(노출/판매 흐름)인 listing 만 분모로
  const PUBLISHED = new Set(['TEMPORARY_SAVE', 'PENDING_APPROVAL', 'APPROVED', 'SELLING', 'STOPPED'])
  for (const l of listings) {
    if (!PUBLISHED.has(l.status)) continue
    ensureCohort(l.origin_signal).skuCount++
  }
  for (const s of skus) {
    const c = ensureCohort(s.signal)
    c.soldSkuCount++
    if (s.net >= 0) c.breakevenCount++
    c.units += s.units
    c.revenue += s.revenue
    c.cost += s.cost
    c.net += s.net
    c.costMissing += s.costMissing
  }

  const cohortList = [...cohorts.values()]
    .filter((c) => c.skuCount > 0 || c.soldSkuCount > 0)
    .sort((a, b) => b.net - a.net)

  // 행동 큐
  const winners = skus
    .filter((s) => s.net > 0 && s.units >= 1)
    .sort((a, b) => b.net - a.net)
    .slice(0, 12)
  const losers = skus
    .filter((s) => s.net < 0)
    .sort((a, b) => a.net - b.net)
    .slice(0, 12)

  const totalNet = skus.reduce((a, s) => a + s.net, 0)

  return { cohortList, winners, losers, skuTotal: skus.length, totalNet }
}

function fmt(n: number) {
  return Math.round(n).toLocaleString()
}
function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`
}

export default async function SalesFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const daysRaw = parseInt(sp.days ?? '0', 10)
  const days = PERIOD_OPTIONS.some((p) => p.v === daysRaw) ? daysRaw : 0

  const { cohortList, winners, losers, skuTotal, totalNet } = await fetchData(days)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">실판매 ROI 피드백</h1>
          <p className="text-sm text-gray-500 mt-1">
            발행 SKU를 <strong>발굴 시그널</strong>별로 묶어 쿠팡 실주문(판매·실수익·매입원가)과 조인 — 어떤 발굴
            채널이 실제 흑자로 전환되는지 측정하고 <strong>재소싱 / 철수</strong> 큐를 만든다.
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          Opportunity →
        </Link>
      </header>

      {/* 기간 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">기간</span>
        {PERIOD_OPTIONS.map((p) => (
          <Link
            key={p.v}
            href={`/admin/trend-radar/sales-feedback${p.v ? `?days=${p.v}` : ''}`}
            className={`px-2.5 py-1 text-xs rounded ${days === p.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            {p.label}
          </Link>
        ))}
        <span className="text-xs text-gray-400 ml-1">
          · 판매 발생 SKU {skuTotal}개 · 누적 실수익 <strong className={totalNet >= 0 ? 'text-emerald-700' : 'text-rose-600'}>{fmt(totalNet)}원</strong>
        </span>
      </div>

      {/* 코호트 카드 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">시그널 소스별 실수익 코호트</h2>
        {cohortList.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-10 text-center text-gray-500 text-sm">
            아직 코호트 데이터 없음. 발행 SKU에 <code>origin_signal</code>이 태깅되고 주문이 쌓이면 표시됩니다.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cohortList.map((c) => {
              const roi = c.cost > 0 ? c.net / c.cost : null
              const avgNetUnit = c.units > 0 ? c.net / c.units : 0
              const breakevenRate = c.soldSkuCount > 0 ? c.breakevenCount / c.soldSkuCount : 0
              const deadRate = c.skuCount > 0 ? 1 - c.soldSkuCount / c.skuCount : 0
              return (
                <div key={c.key} className={`rounded border p-4 space-y-3 ${c.net >= 0 ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-200 bg-rose-50/40'}`}>
                  <div className="flex items-center justify-between">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${c.cls}`}>{c.label}</span>
                    <span className="text-[11px] text-gray-500">발행 {c.skuCount} · 판매 {c.soldSkuCount}</span>
                  </div>
                  <div>
                    <div className="text-[11px] text-gray-500">누적 실수익</div>
                    <div className={`text-xl font-bold tabular-nums ${c.net >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{fmt(c.net)}원</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <Stat label="누적 ROI" value={roi == null ? '—' : pct(roi)} good={roi != null && roi >= 0} />
                    <Stat label="평균 실수익/단위" value={`${fmt(avgNetUnit)}원`} good={avgNetUnit >= 0} />
                    <Stat label="손익분기 도달율" value={pct(breakevenRate)} good={breakevenRate >= 0.5} />
                    <Stat label="사장재고율" value={pct(deadRate)} good={deadRate <= 0.3} />
                  </div>
                  <div className="text-[10px] text-gray-400 tabular-nums">
                    매출 {fmt(c.revenue)} · 매입 {fmt(c.cost)} · 판매 {c.units}개
                    {c.costMissing > 0 && <span className="text-amber-600"> · ⚠매입원가 미입력 {c.costMissing}건</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 행동 큐 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ActionQueue
          title="✅ 검증 winner → 재소싱 · 물량 확대"
          empty="흑자 전환 SKU가 아직 없습니다."
          tone="emerald"
          rows={winners.map((s) => ({ s, hint: '재소싱' }))}
        />
        <ActionQueue
          title="🚩 적자 SKU → 철수 · 리프라이싱"
          empty="적자 SKU가 없습니다. 👍"
          tone="rose"
          rows={losers.map((s) => ({ s, hint: '철수/리프라이싱' }))}
        />
      </section>

      <div className="text-xs text-gray-400 border-t pt-3 leading-relaxed">
        ℹ️ 실수익 = 매출 − 매입원가 − 판매수수료(10.6%) − 부가세(÷11), 취소 제외 (주문 관리 화면과 동일 공식).
        발행 시점에 <code>origin_signal</code>(TV편성/검색급등/핫딜/도매신상/STL시즌 등)을 기록하면 채널별 ROI가 채워집니다.
        매입원가 미입력 주문은 원가 0으로 잡혀 실수익이 과대 표시될 수 있습니다 (<Link href="/admin/coupang-orders" className="text-blue-600 hover:underline">주문 관리</Link>에서 입력).
      </div>
    </div>
  )
}

function Stat({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded bg-white/70 border border-gray-200 px-2 py-1.5">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${good ? 'text-emerald-700' : 'text-rose-600'}`}>{value}</div>
    </div>
  )
}

function ActionQueue({
  title,
  empty,
  tone,
  rows,
}: {
  title: string
  empty: string
  tone: 'emerald' | 'rose'
  rows: { s: SkuPnl; hint: string }[]
}) {
  const border = tone === 'emerald' ? 'border-emerald-200' : 'border-rose-200'
  return (
    <div className={`rounded border ${border} bg-white`}>
      <div className="px-4 py-2.5 border-b border-gray-100 text-sm font-semibold text-gray-800">{title}</div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-gray-400">{empty}</div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map(({ s, hint }) => {
            const sm = signalMeta(s.signal)
            return (
              <li key={s.seller_product_id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900 truncate">{s.title}</div>
                  <div className="text-[11px] text-gray-500 flex items-center gap-1.5 mt-0.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded ${sm.cls}`}>{sm.label}</span>
                    <span>판매 {s.units}개</span>
                    <span>· sellerPID {s.seller_product_id}</span>
                  </div>
                </div>
                <div className="text-right flex-none">
                  <div className={`text-sm font-bold tabular-nums ${s.net >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{fmt(s.net)}원</div>
                  <div className="text-[10px] text-gray-400">{hint}</div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
