import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ReviewVelocityBoard from './ReviewVelocityBoard'

export const dynamic = 'force-dynamic'

interface BoardRow {
  product_id: string
  canonical_name: string
  category_top: string
  marketplace_count: number
  sku_count: number
  review_total_latest: number
  review_delta: number
  days_span: number
  review_per_day: number
  rating_avg: number | null
  est_sales_low: number
  est_sales_high: number
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  observed_first: string
  observed_last: string
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

async function fetchBoard(days: number) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/review_velocity.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_review_velocity_board' as never, {
    days_window: days,
    write_rate_low: 0.01,
    write_rate_high: 0.03,
    min_sim: 0.2,
    result_limit: 200,
  } as never)
  if (error) return { rows: [] as BoardRow[], error: error.message }
  return { rows: (data ?? []) as BoardRow[], error: null as string | null }
}

export default async function ReviewVelocityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30

  const { rows, error } = await fetchBoard(validDays)

  // KPI
  const total = rows.length
  const sourced = rows.filter((r) => r.ggsan_goods_no).length
  const topVelocity = rows.length > 0 ? Number(rows[0].review_per_day) : 0
  const totalEstSalesLow = rows.reduce((s, r) => s + Number(r.est_sales_low || 0), 0)
  const totalEstSalesHigh = rows.reduce((s, r) => s + Number(r.est_sales_high || 0), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📈 리뷰 속도 → 실판매 추정</h1>
          <p className="text-sm text-gray-500 mt-1">
            경쟁 SKU 리뷰 증가분(Δreview/day)을 작성률(1~3%)로 역산해 <strong>추정 일판매량</strong>을 산출.
            검색량(soft)이 아닌 실거래(hard) 시그널로 위너를 확정.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 기간 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">관측 기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={`/admin/trend-radar/review-velocity?days=${d.v}`}
              className={`px-2 py-1 text-xs rounded ${
                validDays === d.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {d.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="추적 상품" value={total} />
        <Kpi label="ggsan 소싱 매칭" value={sourced} highlight={sourced > 0} />
        <Kpi label="최고 리뷰속도/일" value={topVelocity.toFixed(2)} />
        <Kpi
          label="추정 총 일판매 (밴드)"
          value={`${Math.round(totalEstSalesLow)}~${Math.round(totalEstSalesHigh)}`}
        />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_review_velocity_board</code> 미적용 가능성. supabase/review_velocity.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 리뷰 속도 데이터 없음</div>
          <div className="text-xs text-gray-400">
            최소 2회 이상 스냅샷이 누적돼야 Δ(증가분) 계산이 가능합니다.
            <br />
            WSL 수집기: <code className="font-mono">node scripts/collect-review-velocity.mjs</code>
          </div>
        </div>
      ) : (
        !error && <ReviewVelocityBoard rows={rows} />
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 추정 일판매량 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          review_per_day = Σ(SKU별 Δreview) / 관측일수
          <br />
          est_sales_low = review_per_day / 0.03 (작성률 3% 가정 → 보수적)
          <br />
          est_sales_high = review_per_day / 0.01 (작성률 1% 가정 → 낙관적)
        </code>
        <div className="pt-2">
          리뷰 누적 속도는 마켓이 가리는 판매량의 가장 신뢰도 높은 외부 프록시.
          사분면: <strong>X = ggsan 소싱가↓(마진 여력)</strong> · <strong>Y = 추정 실판매↑(검증된 수요)</strong>.
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
