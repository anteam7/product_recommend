import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PriceWhitespaceBoard, { type ProductBoard, type Band } from './PriceWhitespaceBoard'

export const dynamic = 'force-dynamic'

const BAND_WIDTH = 5000 // 5k 간격 가격밴드

// 쿠팡 공식 마진 상수 (coupang_pricing_model 메모리와 동기화)
const SHIP = 3000
const FEE = 0.106
// 도매 개당원가 → 손익분기 판매가: P*(1-FEE) - SHIP - cost = 0
const breakeven = (cost: number) => Math.round((cost + SHIP) / (1 - FEE))

interface MarketRow {
  product_id: string
  keyword: string
  unit_price: number
  pack_count: number | null
  est_monthly_revenue: number | null
  rocket: boolean | null
  scanned_at: string
}

async function fetchData(): Promise<{ boards: ProductBoard[] }> {
  const sb = createAdminClient()

  // 최근 적재된 시장 리스팅 (시계열 — product_id+keyword 단위로 최신 스캔만 사용)
  const { data: rawRows } = await (sb as any)
    .from('jimscanner_trends_market_prices')
    .select('product_id, keyword, unit_price, pack_count, est_monthly_revenue, rocket, scanned_at')
    .order('scanned_at', { ascending: false })
    .limit(5000)

  const rows = (rawRows ?? []) as MarketRow[]
  if (rows.length === 0) return { boards: [] }

  // product_id+keyword 별로 가장 최신 scanned_at 만 채택 (재스캔 누적 노이즈 제거)
  const latestScanByGroup = new Map<string, string>()
  for (const r of rows) {
    const g = `${r.product_id}|${r.keyword}`
    if (!latestScanByGroup.has(g)) latestScanByGroup.set(g, r.scanned_at)
  }
  const fresh = rows.filter((r) => latestScanByGroup.get(`${r.product_id}|${r.keyword}`) === r.scanned_at)

  // ggsan 도매 개당원가 매핑 (product_id == goods_no 가정)
  const productIds = [...new Set(fresh.map((r) => r.product_id))]
  const { data: ggsan } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw')
    .in('goods_no', productIds)
  const costById = new Map<string, { title: string; cost: number | null }>(
    (ggsan ?? []).map((g: any) => [g.goods_no, { title: g.title, cost: g.price_krw ?? null }]),
  )

  // product_id 별 그룹핑
  const byProduct = new Map<string, MarketRow[]>()
  for (const r of fresh) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, [])
    byProduct.get(r.product_id)!.push(r)
  }

  const boards: ProductBoard[] = []
  for (const [productId, listings] of byProduct) {
    if (listings.length < 3) continue // 분포로 보기엔 표본 부족

    const meta = costById.get(productId)
    const cost = meta?.cost ?? null
    const entryFloor = cost != null ? breakeven(cost) : null

    // 5k 간격 binning
    const prices = listings.map((l) => l.unit_price).filter((p) => p > 0)
    const minP = Math.min(...prices)
    const maxP = Math.max(...prices)
    const startBand = Math.floor(minP / BAND_WIDTH) * BAND_WIDTH
    const endBand = Math.floor(maxP / BAND_WIDTH) * BAND_WIDTH

    const bands: Band[] = []
    for (let lo = startBand; lo <= endBand; lo += BAND_WIDTH) {
      const hi = lo + BAND_WIDTH
      const inBand = listings.filter((l) => l.unit_price >= lo && l.unit_price < hi)
      const revenue = inBand.reduce((s, l) => s + (l.est_monthly_revenue ?? 0), 0)
      bands.push({
        lo,
        hi,
        count: inBand.length,
        revenue,
        feasible: entryFloor != null ? lo + BAND_WIDTH / 2 >= entryFloor : false,
        whitespace: false, // 아래에서 판정
      })
    }

    // 화이트스페이스 판정: 매출은 상위인데 리스팅 밀도는 하위인 밴드.
    // 밴드별 '매출/리스팅수' (밀도당 매출) 가 높을수록 빈 틈.
    const counts = bands.map((b) => b.count).filter((c) => c > 0)
    const revenues = bands.map((b) => b.revenue)
    const medCount = median(counts) || 1
    const maxRevenue = Math.max(...revenues, 1)
    for (const b of bands) {
      const revShare = b.revenue / maxRevenue
      // 매출 점유 상위(≥35%) + 리스팅 밀도 중앙값 이하 = 수요 있는데 공급 얇음
      b.whitespace = revShare >= 0.35 && b.count <= medCount
    }

    boards.push({
      productId,
      title: meta?.title ?? productId,
      keyword: listings[0].keyword,
      cost,
      entryFloor,
      listingCount: listings.length,
      bandWidth: BAND_WIDTH,
      bands,
    })
  }

  // 진입 가능 화이트스페이스가 있는 product 우선 정렬
  boards.sort((a, b) => greenScore(b) - greenScore(a))
  return { boards }
}

function greenScore(b: ProductBoard): number {
  return b.bands
    .filter((band) => band.whitespace && band.feasible)
    .reduce((s, band) => s + band.revenue, 0)
}

function median(arr: number[]): number | null {
  const a = [...arr].sort((x, y) => x - y)
  if (!a.length) return null
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

export default async function PriceWhitespacePage() {
  const { boards } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">가격대 화이트스페이스</h1>
          <p className="text-sm text-gray-500 mt-1">
            경쟁 개당가를 5천원 밴드로 묶어 <b>리스팅 밀도(막대)</b> 위에 <b>추정 매출(라인)</b>을 겹쳐 본다.
            매출은 몰리는데 리스팅이 얇은 밴드 = 빈 틈. 도매원가로 마진까지 확보되는 밴드만{' '}
            <span className="text-emerald-600 font-semibold">초록</span>.
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          Opportunity →
        </Link>
      </header>

      {boards.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 시장 스캔 적재 없음. <code className="text-xs">coupang-market-prices-cdp.mjs</code> 실행 후 누적되면 표시됩니다.
        </div>
      ) : (
        <PriceWhitespaceBoard boards={boards} />
      )}
    </div>
  )
}
