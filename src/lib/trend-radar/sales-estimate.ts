import { createAdminClient } from '@/lib/auth/admin-supabase'

export interface ProductSalesEstimate {
  product_id: string
  est_sales_7d: number
  est_sales_30d: number
  est_revenue_7d_krw: number
  est_revenue_30d_krw: number
  accel_ratio_14d: number
  tracked_sku_count: number
  latest_observed_date: string | null
}

export interface CompetitorSkuRow {
  id: string
  channel: string
  external_sku_id: string
  name: string | null
  url: string | null
  rank_serp: number | null
  last_seen_at: string
}

export interface DailySalesRow {
  competitor_sku_id: string
  channel: string
  external_sku_id: string
  observed_date: string
  review_count: number
  delta_reviews: number | null
  day_gap: number | null
  price_krw: number | null
  review_rate: number | null
  estimated_daily_sales: number | null
  estimated_daily_revenue_krw: number | null
}

// 마이그레이션 후 generated 타입 미반영 — `as any` 캐스팅 (CLAUDE.md 규칙).
type AnyClient = ReturnType<typeof createAdminClient>

export async function fetchProductSalesEstimate(productId: string): Promise<ProductSalesEstimate | null> {
  const sb = createAdminClient() as AnyClient
  const { data, error } = await (sb as any)
    .from('jimscanner_product_sales_estimate')
    .select('*')
    .eq('product_id', productId)
    .maybeSingle()
  if (error || !data) return null
  return data as ProductSalesEstimate
}

export async function fetchCompetitorSkus(productId: string): Promise<CompetitorSkuRow[]> {
  const sb = createAdminClient() as AnyClient
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_competitor_skus')
    .select('id, channel, external_sku_id, name, url, rank_serp, last_seen_at')
    .eq('product_id', productId)
    .order('last_seen_at', { ascending: false })
  if (error) return []
  return (data ?? []) as CompetitorSkuRow[]
}

export async function fetchDailySales(productId: string, days = 30): Promise<DailySalesRow[]> {
  const sb = createAdminClient() as AnyClient
  const skuList = await fetchCompetitorSkus(productId)
  if (skuList.length === 0) return []
  const ids = skuList.map((s) => s.id)
  const sinceDate = new Date()
  sinceDate.setDate(sinceDate.getDate() - days)
  const sinceStr = sinceDate.toISOString().slice(0, 10)
  const { data, error } = await (sb as any)
    .from('jimscanner_competitor_daily_sales')
    .select('*')
    .in('competitor_sku_id', ids)
    .gte('observed_date', sinceStr)
    .order('observed_date', { ascending: true })
  if (error) return []
  return (data ?? []) as DailySalesRow[]
}

export interface AccelSku {
  competitor_sku_id: string
  channel: string
  external_sku_id: string
  product_id: string | null
  product_name: string | null
  est_sales_recent7: number
  est_sales_prior7: number
  accel_ratio: number
}

export async function fetchTopAccelSkus(limit = 20): Promise<AccelSku[]> {
  const sb = createAdminClient() as AnyClient
  const { data, error } = await (sb as any)
    .from('jimscanner_competitor_daily_sales')
    .select('competitor_sku_id, channel, external_sku_id, observed_date, estimated_daily_sales')
    .gte('observed_date', new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10))
  if (error || !data) return []

  type Row = { competitor_sku_id: string; channel: string; external_sku_id: string; observed_date: string; estimated_daily_sales: number | null }
  const rows = data as Row[]
  const today = new Date()
  const cutoff = new Date(today)
  cutoff.setDate(cutoff.getDate() - 7)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const bySku = new Map<string, { channel: string; external_sku_id: string; recent: number; prior: number }>()
  for (const r of rows) {
    if (r.estimated_daily_sales == null) continue
    const cur = bySku.get(r.competitor_sku_id) ?? { channel: r.channel, external_sku_id: r.external_sku_id, recent: 0, prior: 0 }
    if (r.observed_date >= cutoffStr) cur.recent += Number(r.estimated_daily_sales)
    else cur.prior += Number(r.estimated_daily_sales)
    bySku.set(r.competitor_sku_id, cur)
  }

  // sku → product_id, product_name 조인
  const ids = Array.from(bySku.keys())
  let skuMeta = new Map<string, { product_id: string; product_name: string | null }>()
  if (ids.length > 0) {
    const { data: skus } = await (sb as any)
      .from('jimscanner_trends_competitor_skus')
      .select('id, product_id, jimscanner_trends_products(canonical_name)')
      .in('id', ids)
    for (const s of (skus ?? []) as any[]) {
      const name = s.jimscanner_trends_products?.canonical_name ?? null
      skuMeta.set(s.id, { product_id: s.product_id, product_name: name })
    }
  }

  const out: AccelSku[] = []
  for (const [sku_id, v] of bySku.entries()) {
    const ratio = v.prior > 0 ? v.recent / v.prior : v.recent > 0 ? 99 : 0
    const meta = skuMeta.get(sku_id)
    out.push({
      competitor_sku_id: sku_id,
      channel: v.channel,
      external_sku_id: v.external_sku_id,
      product_id: meta?.product_id ?? null,
      product_name: meta?.product_name ?? null,
      est_sales_recent7: v.recent,
      est_sales_prior7: v.prior,
      accel_ratio: ratio,
    })
  }
  out.sort((a, b) => b.accel_ratio - a.accel_ratio)
  return out.slice(0, limit)
}
