import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { MatrixCard, type MatrixRow } from './MatrixCard'

export const dynamic = 'force-dynamic'

type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4'

async function fetchMatrix(hours: number): Promise<MatrixRow[]> {
  // RPC 는 마이그레이션 후에 types/supabase 에 들어오므로 `as any` 캐스팅
  // (CLAUDE.md / RPC type workaround 참고)
  const sb = createAdminClient()
  const { data, error } = await (sb.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: MatrixRow[] | null; error: { message: string } | null }>)(
    'jimscanner_coupang_orders_risk_matrix',
    { hours_window: hours }
  )
  if (error) {
    console.error('[risk-matrix] rpc error', error.message)
    return []
  }
  return data ?? []
}

export default async function CoupangOrdersRiskMatrixPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>
}) {
  const sp = await searchParams
  const hours = Math.max(1, Math.min(720, parseInt(sp.hours ?? '72', 10) || 72))

  const rows = await fetchMatrix(hours)
  const buckets: Record<Quadrant, MatrixRow[]> = { Q1: [], Q2: [], Q3: [], Q4: [] }
  for (const r of rows) {
    const q = (['Q1', 'Q2', 'Q3', 'Q4'].includes(r.quadrant) ? r.quadrant : 'Q4') as Quadrant
    buckets[q].push(r)
  }

  const totalMatched = rows.filter((r) => r.source_goods_no).length
  const totalUnmatched = rows.length - totalMatched

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">PENDING × 도매 재고 위험 매트릭스</h1>
          <p className="text-sm text-zinc-500 mt-1">
            미발주 주문을 ggsan 도매 재고와 교차 검증 — 최근{' '}
            <strong>{hours}h</strong> 윈도우 · 총{' '}
            <strong>{rows.length}</strong>건 (매칭 {totalMatched} / 미매칭 {totalUnmatched})
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {[24, 48, 72, 168].map((h) => (
            <Link
              key={h}
              href={`/admin/coupang-orders/risk-matrix?hours=${h}`}
              className={`px-2 py-1 rounded ${
                hours === h
                  ? 'bg-blue-100 text-blue-700 font-semibold'
                  : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {h === 168 ? '7d' : `${h}h`}
            </Link>
          ))}
          <Link
            href="/admin/coupang-orders"
            className="ml-2 px-2 py-1 rounded text-zinc-500 hover:bg-zinc-100"
          >
            ← 주문 목록
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <MatrixCard quadrant="Q1" rows={buckets.Q1} />
        <MatrixCard quadrant="Q2" rows={buckets.Q2} />
        <MatrixCard quadrant="Q3" rows={buckets.Q3} />
        <MatrixCard quadrant="Q4" rows={buckets.Q4} />
      </div>

      <div className="text-xs text-zinc-400 border-t pt-3 space-y-1">
        <div>
          ℹ️ 사분면 정의: hours_pending × 도매 상태(active / imminent / sold_out)의 4-cross.
          매칭은 jimscanner_coupang_listings.seller_product_id → source_goods_no →
          jimscanner_ggsan_products.goods_no.
        </div>
        <div>
          ℹ️ 재입고 ETA: jimscanner_ggsan_price_history 30일 sold_out→active 평균. 데이터 누적이
          적은 SKU 는 ETA 가 비어 있을 수 있음.
        </div>
      </div>
    </div>
  )
}
