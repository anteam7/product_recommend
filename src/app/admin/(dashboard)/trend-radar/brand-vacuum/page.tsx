import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import BrandVacuumScatter, { type VacuumRow } from './BrandVacuumScatter'

export const dynamic = 'force-dynamic'

interface VacuumDbRow {
  product_id: string
  canonical_name: string | null
  category_top: string | null
  brand: string | null
  total_aliases: number | null
  generic_aliases: number | null
  generic_demand_ratio: number | null
  rep_generic_keyword: string | null
  trend_score: number | null
  supplier_score: number | null
}

async function fetchData(): Promise<{ rows: VacuumRow[] }> {
  const sb = createAdminClient()

  // trends_brand_vacuum 뷰는 generated types 에 아직 없음 → as any (마이그레이션 후 상태 가정)
  const { data } = await (sb as any)
    .from('jimscanner_trends_brand_vacuum')
    .select(
      'product_id, canonical_name, category_top, brand, total_aliases, generic_aliases, generic_demand_ratio, rep_generic_keyword, trend_score, supplier_score',
    )
    .not('trend_score', 'is', null)
    .limit(3000)

  const rows: VacuumRow[] = ((data ?? []) as VacuumDbRow[]).map((r) => ({
    id: r.product_id,
    name: r.canonical_name ?? '?',
    category: r.category_top ?? 'all',
    brand: r.brand,
    genericRatio: r.generic_demand_ratio != null ? Number(r.generic_demand_ratio) : null,
    trend: Number(r.trend_score ?? 0),
    supplier: Number(r.supplier_score ?? 0),
    total: Number(r.total_aliases ?? 0),
    generic: Number(r.generic_aliases ?? 0),
    repKeyword: r.rep_generic_keyword,
  }))

  return { rows }
}

export default async function BrandVacuumPage() {
  const { rows } = await fetchData()
  const plotted = rows.filter((r) => r.genericRatio != null)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">브랜드 무중력 지대</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 제네릭 수요비율 (일반명사 검색 ↑ = 노브랜드 진입 가능) · Y = trend · 색 = supplier · 골든존 = 우상단 강조
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-gray-100 bg-gray-50 p-4 text-xs text-gray-600 leading-relaxed">
        <strong>읽는 법:</strong> 수요 텍스트(alias)가 일반명사로 흩어져 있을수록(제네릭비율↑) 다이슨 같은 브랜드 락인이 약해
        ggsan 노브랜드 상품·가격만으로도 진입할 수 있습니다. 제네릭비율 ↑ × 트렌드 ↑ × supplier 매칭 = <strong>화이트라벨 골든존</strong>.
      </div>

      {plotted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. alias·score 누적 후 다시 방문. (뷰 마이그레이션{' '}
          <code className="text-xs">supabase/trends_brand_vacuum.sql</code> 적용 필요)
        </div>
      ) : (
        <BrandVacuumScatter rows={rows} />
      )}
    </div>
  )
}
