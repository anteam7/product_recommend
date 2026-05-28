import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SignalRow {
  listing_id: string
  goods_no: string
  registered_title: string
  brand: string | null
  status: string
  displayable: boolean
  seller_product_id: number | null
  product_id: number | null
  my_price: number | null
  msp_price_krw: number | null
  dome_price_krw: number | null
  margin_floor: number | null
  competitor_min: number | null
  competitor_median: number | null
  competitor_p25: number | null
  sample_count: number | null
  price_observed_at: string | null
  median_7d_ago: number | null
  median_trend_pct_7d: number | null
  buybox_lost: boolean | null
  recommended_price: number | null
  orders_14d: number | null
}

type ActionKind = 'defend' | 'markup' | 'cut' | 'dead' | 'ok' | 'nodata'

interface Signal extends SignalRow {
  action: ActionKind
  urgency: number // 높을수록 시급
}

const ACTION_META: Record<ActionKind, { label: string; cls: string }> = {
  defend: { label: '🛡 방어필요', cls: 'bg-rose-100 text-rose-700' },
  markup: { label: '📈 마진인상가능', cls: 'bg-emerald-100 text-emerald-700' },
  cut: { label: '✂ 손절후보', cls: 'bg-amber-100 text-amber-700' },
  dead: { label: '💀 무주문(14일)', cls: 'bg-zinc-300 text-zinc-700' },
  ok: { label: '✓ 양호', cls: 'bg-gray-100 text-gray-500' },
  nodata: { label: '시세없음', cls: 'bg-gray-50 text-gray-400' },
}

/**
 * SKU별 액션 분류 + 시급도 산출.
 *   defend  : 바이박스 상실 + 권장가가 마진 플로어 위 → 인하 여력 있음
 *   cut     : 바이박스 상실 + 권장가 < 마진 플로어 → 경쟁가가 원가 아래, 손절 검토
 *   markup  : 내 가격이 경쟁최저보다 충분히 낮음 → 마진 인상 헤드룸
 *   dead    : 14일 무주문 (방어/인상과 별개 표시)
 */
function classify(r: SignalRow): { action: ActionKind; urgency: number } {
  const dead = (r.orders_14d ?? 0) === 0
  if (r.competitor_min == null || r.my_price == null) {
    return { action: dead ? 'dead' : 'nodata', urgency: dead ? 20 : 0 }
  }
  const floor = r.margin_floor ?? 0
  const gapToMin = r.my_price - r.competitor_min // 양수 = 내가 비쌈
  const gapPct = r.competitor_min > 0 ? (gapToMin / r.competitor_min) * 100 : 0

  if (r.buybox_lost) {
    // 권장가가 플로어 아래로 떨어지면 더 내릴 수 없음 → 손절후보
    const canDefend = (r.recommended_price ?? 0) > floor
    if (!canDefend) {
      return { action: 'cut', urgency: 70 + Math.min(gapPct, 30) }
    }
    // 방어: 비쌀수록 + 7일간 경쟁 시세가 내려갈수록 시급
    const trendDrop = (r.median_trend_pct_7d ?? 0) < 0 ? Math.abs(r.median_trend_pct_7d ?? 0) : 0
    return { action: 'defend', urgency: 100 + Math.min(gapPct, 50) + Math.min(trendDrop, 20) }
  }

  // 바이박스 우위 — 마진 인상 헤드룸? (경쟁최저보다 5%+ 저렴)
  if (gapPct <= -5) {
    return { action: 'markup', urgency: 40 + Math.min(Math.abs(gapPct), 30) }
  }
  return { action: dead ? 'dead' : 'ok', urgency: dead ? 25 : 5 }
}

const FILTERS: { v: string; label: string }[] = [
  { v: '', label: '전체' },
  { v: 'defend', label: '🛡 방어필요' },
  { v: 'markup', label: '📈 마진인상' },
  { v: 'cut', label: '✂ 손절후보' },
  { v: 'dead', label: '💀 무주문' },
]

async function fetchSignals(): Promise<{ rows: Signal[]; error: string | null }> {
  // v_repricing_signals 뷰 — generated 타입 미반영, `npm run gen:types` 시 캐스팅 제거
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const { data, error } = await sb
    .from('v_repricing_signals')
    .select('*')
    .limit(1000)
  if (error) return { rows: [], error: error.message }
  const rows: Signal[] = (data as SignalRow[]).map((r) => ({ ...r, ...classify(r) }))
  rows.sort((a, b) => b.urgency - a.urgency)
  return { rows, error: null }
}

function fmt(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}
function fmtDate(s: string | null | undefined) {
  return s ? s.slice(0, 16).replace('T', ' ') : '—'
}

/** 경쟁 median 스파크라인 — 7일 전 → 현재 추세를 작은 막대로 표현 */
function TrendBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-gray-300 text-[10px]">—</span>
  const up = pct > 0
  const flat = Math.abs(pct) < 1
  return (
    <span
      className={`text-[11px] tabular-nums ${
        flat ? 'text-gray-400' : up ? 'text-rose-600' : 'text-emerald-600'
      }`}
      title="경쟁 시세 7일 추세"
    >
      {flat ? '→' : up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

export default async function RepricingPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>
}) {
  const sp = await searchParams
  const activeFilter = FILTERS.some((f) => f.v === sp.action) ? (sp.action ?? '') : ''
  const { rows, error } = await fetchSignals()

  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1
  const visible = activeFilter ? rows.filter((r) => r.action === activeFilter) : rows

  return (
    <div className="space-y-5 p-6">
      <header>
        <h1 className="text-2xl font-bold">리프라이싱 코크핏</h1>
        <p className="text-sm text-gray-500 mt-1">
          발행 SKU의 바이박스 방어·마진 헤드룸 보드 — 경쟁 시세 시계열 ×
          원가(마진 플로어) × 내 현재가 · 액션 시급도순 정렬
        </p>
      </header>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          뷰 조회 실패: {error}
          <div className="text-xs text-rose-500 mt-1">
            supabase/coupang_repricing.sql 적용 후 사용 가능합니다.
          </div>
        </div>
      )}

      {/* 요약 배지 */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const cnt = f.v ? (counts[f.v] ?? 0) : rows.length
          const on = activeFilter === f.v
          return (
            <Link
              key={f.v || 'all'}
              href={f.v ? `/admin/trend-radar/repricing?action=${f.v}` : '/admin/trend-radar/repricing'}
              className={`px-3 py-1.5 text-sm rounded border ${
                on
                  ? 'bg-blue-600 text-white border-blue-600 font-semibold'
                  : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {f.label} <span className={on ? 'text-blue-100' : 'text-gray-400'}>{cnt}</span>
            </Link>
          )
        })}
      </div>

      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-semibold w-[28%]">상품명</th>
              <th className="px-3 py-2 text-center font-semibold">액션</th>
              <th className="px-3 py-2 text-right font-semibold">내 가격</th>
              <th className="px-3 py-2 text-right font-semibold">경쟁최저</th>
              <th className="px-3 py-2 text-right font-semibold">경쟁median</th>
              <th className="px-3 py-2 text-center font-semibold">7일추세</th>
              <th className="px-3 py-2 text-right font-semibold">마진플로어</th>
              <th className="px-3 py-2 text-right font-semibold">권장가</th>
              <th className="px-3 py-2 text-center font-semibold">14일주문</th>
              <th className="px-3 py-2 text-center font-semibold">링크</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-12 text-center text-gray-400 text-sm">
                  표시할 시그널이 없습니다. 시세 collector(coupang-market-prices.mjs)가
                  history를 누적하면 채워집니다.
                </td>
              </tr>
            )}
            {visible.map((r) => {
              const am = ACTION_META[r.action]
              const coupangUrl = r.product_id
                ? `https://www.coupang.com/vp/products/${r.product_id}`
                : null
              const recDelta =
                r.recommended_price != null && r.my_price != null
                  ? r.recommended_price - r.my_price
                  : null
              return (
                <tr key={r.listing_id} className="border-t hover:bg-amber-50/30">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">{r.registered_title}</div>
                    <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap gap-x-2">
                      {r.brand && <span>{r.brand}</span>}
                      <span>· goods_no={r.goods_no}</span>
                      {r.price_observed_at && <span>· 시세 {fmtDate(r.price_observed_at)}</span>}
                      {r.sample_count != null && <span>· 표본 {r.sample_count}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs whitespace-nowrap ${am.cls}`}>
                      {am.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">
                    {fmt(r.my_price)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={r.buybox_lost ? 'text-rose-600 font-medium' : ''}>
                      {fmt(r.competitor_min)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{fmt(r.competitor_median)}</td>
                  <td className="px-3 py-2 text-center">
                    <TrendBadge pct={r.median_trend_pct_7d} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmt(r.margin_floor)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.recommended_price != null ? (
                      <>
                        <span className="font-semibold text-blue-700">{fmt(r.recommended_price)}</span>
                        {recDelta != null && recDelta !== 0 && (
                          <div
                            className={`text-[10px] ${recDelta < 0 ? 'text-rose-500' : 'text-emerald-600'}`}
                          >
                            {recDelta > 0 ? '+' : ''}
                            {recDelta.toLocaleString()}
                          </div>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">
                    <span
                      className={
                        (r.orders_14d ?? 0) === 0 ? 'text-zinc-400' : 'text-gray-800 font-medium'
                      }
                    >
                      {r.orders_14d ?? 0}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center text-xs">
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
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
