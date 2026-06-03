import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PriceTierHeatmap, { type Candidate } from './PriceTierHeatmap'

export const dynamic = 'force-dynamic'

interface RpcRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number
  real_cost: number
  expected_sell: number
  expected_margin: number
  expected_margin_pct: number | null
  price_tier: string
  is_imminent: boolean
  detail_url: string | null
  demand_signal: number | null
  competition_score: number | null
}

async function fetchData(): Promise<Candidate[]> {
  const sb = createAdminClient()
  // RPC 는 마이그레이션 후 생성됨 — 타입 생성 전까지 as any 캐스팅.
  const { data, error } = await (sb as any).rpc('jimscanner_price_tier_whitespace', {
    min_sim: 0.2,
  })
  if (error) {
    console.error('[opportunity-price] rpc error', error.message)
    return []
  }
  return ((data ?? []) as RpcRow[]).map((r) => ({
    goodsNo: r.goods_no,
    title: r.title,
    cateCd: r.cate_cd ?? '?',
    cateLabel: r.cate_label ?? r.cate_cd ?? '기타',
    priceKrw: r.price_krw,
    realCost: r.real_cost,
    expectedSell: r.expected_sell,
    expectedMargin: r.expected_margin,
    expectedMarginPct: r.expected_margin_pct ?? null,
    priceTier: r.price_tier,
    isImminent: r.is_imminent,
    detailUrl: r.detail_url,
    demand: r.demand_signal ?? null,
    competition: r.competition_score ?? null,
  }))
}

export default async function OpportunityPricePage() {
  const candidates = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">가격대 화이트스페이스 맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            예상 판매가(쿠팡 공식) × 카테고리 그리드 · 셀 색 = 수요/경쟁 비율 · 🟢 = 수요 있는데 경쟁 빈 가격 포켓
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {candidates.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          후보 없음. ggsan 카탈로그 수집 + RPC 마이그레이션 적용 후 다시 방문.
          <br />
          <span className="text-xs text-gray-400">
            (supabase/trends_v4_price_tier_whitespace_rpc.sql 적용 필요)
          </span>
        </div>
      ) : (
        <PriceTierHeatmap candidates={candidates} />
      )}
    </div>
  )
}
