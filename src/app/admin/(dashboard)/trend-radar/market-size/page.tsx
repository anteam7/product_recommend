import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { estimateMarketSize } from '@/lib/trends/market-size'
import MarketSizeBoard, { type MarketRow } from './MarketSizeBoard'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}

async function fetchData(): Promise<{ rows: MarketRow[] }> {
  const sb = createAdminClient()

  // 최신 score (product_id 별 latest)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, competition_score, final_score, score_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { rows: [] }

  const [prodRes, supRes] = await Promise.all([
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', ids),
    sb
      .from('jimscanner_trends_supplier')
      .select('product_id, price_krw')
      .in('product_id', ids),
  ])

  const byId = new Map((prodRes.data ?? []).map((p: any) => [p.id, p]))

  // product 당 최저 도매가(최소 진입 비용 기준)
  const minPrice = new Map<string, number>()
  for (const s of (supRes.data ?? []) as any[]) {
    const v = Number(s.price_krw)
    if (!Number.isFinite(v) || v <= 0) continue
    const cur = minPrice.get(s.product_id)
    if (cur === undefined || v < cur) minPrice.set(s.product_id, v)
  }

  const rows: MarketRow[] = latest.map((s) => {
    const p = byId.get(s.product_id) ?? {}
    const category = (p as any).category_top ?? 'all'
    const est = estimateMarketSize({
      category,
      trendScore: s.trend_score,
      competitionScore: s.competition_score,
      supplierPriceKrw: minPrice.get(s.product_id) ?? null,
      scoreComponents: s.score_components,
    })
    return {
      id: s.product_id,
      name: (p as any).canonical_name ?? '?',
      category,
      finalScore: Math.round(s.final_score),
      trendScore: Math.round(s.trend_score),
      competitionScore: Math.round(s.competition_score),
      searchSource: est.searchSource,
      priceSource: est.priceSource,
      avgPrice: est.bands.base.avgPrice,
      monthlySearches: est.bands.base.monthlySearches,
      estimatedSellers: est.estimatedSellers,
      myRank: est.myRank,
      gmv: {
        conservative: est.bands.conservative.gmvKrw,
        base: est.bands.base.gmvKrw,
        optimistic: est.bands.optimistic.gmvKrw,
      },
      sam: {
        conservative: est.bands.conservative.samKrw,
        base: est.bands.base.samKrw,
        optimistic: est.bands.optimistic.samKrw,
      },
      sortKey: est.sortKey,
    }
  })

  rows.sort((a, b) => b.sortKey - a.sortKey)
  return { rows }
}

export default async function MarketSizePage() {
  const { rows } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">예상 월 시장규모 (원)</h1>
          <p className="text-sm text-gray-500 mt-1">
            검색량 앵커 × 카테고리 전환율 × 평균 판매가 = 예상 월 거래액(GMV) ·
            competition 분배 = 내가 진입 시 획득가능 매출(SAM) · 보수/기본/낙관 3밴드
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link
            href="/admin/trend-radar/opportunity"
            className="text-gray-700 hover:text-black underline"
          >
            Opportunity Matrix
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 score 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <MarketSizeBoard rows={rows} />
      )}
    </div>
  )
}
