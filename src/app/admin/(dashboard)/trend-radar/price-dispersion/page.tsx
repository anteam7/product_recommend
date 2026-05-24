import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PriceDispersionBoard, { type SnapshotRow } from './PriceDispersionBoard'

export const dynamic = 'force-dynamic'

interface RawRow {
  id: string
  keyword: string
  collected_at: string
  prices: Array<{ title?: string; price?: number; mallName?: string; link?: string }> | null
  n_listings: number
  mean_price: number | null
  median_price: number | null
  p25_price: number | null
  p75_price: number | null
  min_price: number | null
  max_price: number | null
  stddev_price: number | null
  cv: number | null
  iqr_ratio: number | null
  minmax_gap_ratio: number | null
  product_id: string | null
  category_top: string | null
}

async function fetchData() {
  const sb = createAdminClient() as any

  const { data: snaps } = await sb
    .from('jimscanner_serp_price_snapshot')
    .select('*')
    .order('collected_at', { ascending: false })
    .limit(500)

  // keyword 별 latest snapshot
  const seen = new Set<string>()
  const latest: RawRow[] = []
  for (const s of (snaps ?? []) as RawRow[]) {
    if (seen.has(s.keyword)) continue
    seen.add(s.keyword)
    latest.push(s)
  }

  const rows: SnapshotRow[] = latest.map((s) => ({
    id: s.id,
    keyword: s.keyword,
    collectedAt: s.collected_at,
    nListings: s.n_listings,
    mean: s.mean_price,
    median: s.median_price,
    p25: s.p25_price,
    p75: s.p75_price,
    min: s.min_price,
    max: s.max_price,
    stddev: s.stddev_price,
    cv: s.cv,
    iqrRatio: s.iqr_ratio,
    minmaxGap: s.minmax_gap_ratio,
    productId: s.product_id,
    categoryTop: s.category_top,
    prices: (s.prices ?? []).map((p) => Number(p.price ?? 0)).filter((v) => v > 0),
  }))

  return { rows }
}

export default async function PriceDispersionPage() {
  const { rows } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">SERP 가격분산 알파</h1>
          <p className="text-sm text-gray-500 mt-1">
            Naver 쇼핑 SERP top {30} 리스팅 가격의 분산(CV) — high-CV = 앵커링 미형성(pricing
            power), low-CV = commodity. 도매가 앵커 + p25~p75 진입 권장 구간 표시.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 SERP 스냅샷 없음</p>
          <p className="text-sm mt-2 font-mono text-xs">
            /api/cron/collect-serp-prices 를 1회 이상 실행 후 다시 방문.
            <br />
            (locally: node --env-file=.env.local scripts/run-crons.mjs collect-serp-prices)
          </p>
        </div>
      ) : (
        <PriceDispersionBoard rows={rows} />
      )}
    </div>
  )
}
