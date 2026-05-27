import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import AdGateBoard from './AdGateBoard'

export const dynamic = 'force-dynamic'

interface AdCostRow {
  keyword: string
  product_id: string | null
  monthly_search_total: number | null
  est_cpc_avg: number | null
  est_cpc_low: number | null
  est_cpc_high: number | null
  competition_index: string | null
  collected_at: string
}

interface SupplierRow {
  product_id: string
  price_krw: number | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

interface ConfigRow {
  margin_rate: number
  conversion_rate: number
  sale_price_multiplier: number
}

export interface AdGateItem {
  productId: string | null
  keyword: string
  category: string
  monthlySearch: number
  cpcAvg: number
  competition: string
  supplierPriceKrw: number | null
  salePriceKrw: number | null
  marginPerSaleKrw: number | null
  costPerSaleAdKrw: number | null         // CPC ÷ CVR — 한 건 판매까지의 광고비
  adMarginBurnRatio: number | null        // costPerSaleAd / margin (1.0 이상 = 손익분기 초과)
  breakEvenCvr: number | null             // CPC × 100 / margin (퍼센트)
  quadrant: 'organic_seo' | 'ad_roi' | 'blocked' | 'low_search'
}

const DEFAULT_CONFIG: ConfigRow = {
  margin_rate: 0.25,
  conversion_rate: 0.025,
  sale_price_multiplier: 2.5,
}

async function fetchData(): Promise<{ items: AdGateItem[]; config: ConfigRow; lastCollected: string | null }> {
  const sb = createAdminClient()

  // 1) latest adcost per keyword
  const { data: adRows } = await sb
    .from('jimscanner_trends_keyword_adcost' as never)
    .select('keyword, product_id, monthly_search_total, est_cpc_avg, est_cpc_low, est_cpc_high, competition_index, collected_at')
    .order('collected_at', { ascending: false })
    .limit(2000) as { data: AdCostRow[] | null }

  const seen = new Set<string>()
  const latestAd: AdCostRow[] = []
  for (const r of adRows ?? []) {
    if (seen.has(r.keyword)) continue
    seen.add(r.keyword)
    latestAd.push(r)
  }

  // 2) product meta
  const productIds = Array.from(new Set(latestAd.map((r) => r.product_id).filter(Boolean) as string[]))
  let productMap = new Map<string, ProductRow>()
  if (productIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds)
    productMap = new Map((prods ?? []).map((p) => [p.id as string, p as ProductRow]))
  }

  // 3) supplier price (cheapest per product)
  let supplierMap = new Map<string, number>()
  if (productIds.length > 0) {
    const { data: supps } = await sb
      .from('jimscanner_trends_supplier')
      .select('product_id, price_krw, collected_at')
      .in('product_id', productIds)
      .order('collected_at', { ascending: false })
      .limit(4000) as { data: SupplierRow[] | null }
    for (const s of supps ?? []) {
      const cur = supplierMap.get(s.product_id)
      if (s.price_krw == null) continue
      if (cur === undefined || s.price_krw < cur) supplierMap.set(s.product_id, s.price_krw)
    }
  }

  // 4) config
  const { data: cfgRow } = await sb
    .from('jimscanner_trends_ad_gate_config' as never)
    .select('margin_rate, conversion_rate, sale_price_multiplier')
    .eq('id', 'main')
    .maybeSingle() as { data: ConfigRow | null }
  const config = cfgRow ?? DEFAULT_CONFIG

  // 5) merge → AdGateItem
  const items: AdGateItem[] = latestAd.map((r) => {
    const prod = r.product_id ? productMap.get(r.product_id) ?? null : null
    const supplierPrice = r.product_id ? supplierMap.get(r.product_id) ?? null : null
    const salePrice =
      supplierPrice != null ? Math.round(supplierPrice * config.sale_price_multiplier) : null
    const margin = salePrice != null ? salePrice * config.margin_rate : null
    const cpcAvg = r.est_cpc_avg ?? 0
    const costPerSale = config.conversion_rate > 0 ? cpcAvg / config.conversion_rate : null
    const burnRatio = margin && margin > 0 && costPerSale != null ? costPerSale / margin : null
    const breakEvenCvr = margin && margin > 0 && cpcAvg > 0 ? (cpcAvg / margin) * 100 : null
    const monthlySearch = r.monthly_search_total ?? 0

    let quadrant: AdGateItem['quadrant']
    if (monthlySearch < 1000) {
      quadrant = 'low_search'
    } else if (burnRatio != null && burnRatio <= 0.5) {
      quadrant = 'ad_roi'
    } else if (burnRatio != null && burnRatio > 1.0) {
      quadrant = 'blocked'
    } else {
      quadrant = 'organic_seo'
    }

    return {
      productId: r.product_id,
      keyword: r.keyword,
      category: prod?.category_top ?? 'unknown',
      monthlySearch,
      cpcAvg,
      competition: r.competition_index ?? '-',
      supplierPriceKrw: supplierPrice,
      salePriceKrw: salePrice,
      marginPerSaleKrw: margin ? Math.round(margin) : null,
      costPerSaleAdKrw: costPerSale ? Math.round(costPerSale) : null,
      adMarginBurnRatio: burnRatio,
      breakEvenCvr,
      quadrant,
    }
  })

  const lastCollected = latestAd[0]?.collected_at ?? null
  return { items, config, lastCollected }
}

export default async function AdGatePage() {
  const { items, config, lastCollected } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold">광고비 진입 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            CPC × 마진 손익분기 — 키워드별 광고 ROI 와 오가닉 SEO 가능성 진단.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 flex flex-wrap gap-x-6 gap-y-1">
        <span>마진율: <strong>{(config.margin_rate * 100).toFixed(0)}%</strong></span>
        <span>평균 전환율: <strong>{(config.conversion_rate * 100).toFixed(1)}%</strong></span>
        <span>도매가→판매가 배수: <strong>×{config.sale_price_multiplier}</strong></span>
        <span>
          마지막 수집:{' '}
          <strong>
            {lastCollected ? new Date(lastCollected).toLocaleString('ko-KR') : '미수집'}
          </strong>
        </span>
        <span className="text-gray-500">
          (값 변경: <code className="font-mono">jimscanner_trends_ad_gate_config</code>)
        </span>
      </div>

      {items.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. <code className="font-mono">node --env-file=.env.local scripts/collect-naver-adcpc.mjs</code>
          {' '}로 수집 시작.
        </div>
      ) : (
        <AdGateBoard items={items} />
      )}
    </div>
  )
}
