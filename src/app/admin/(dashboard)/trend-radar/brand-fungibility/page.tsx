import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import BrandFungibilityBoard from './BrandFungibilityBoard'

export const dynamic = 'force-dynamic'

export interface FungibilityRow {
  product_id: string
  canonical_name: string
  category_top: string
  brand: string | null
  alias_total: number
  brand_dep_count: number
  brand_dependency_ratio: number
  final_score: number
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  ggsan_match_count: number
}

async function fetchData(): Promise<FungibilityRow[]> {
  const sb = createAdminClient()
  // RPC 타입은 아직 generate 전 — 마이그레이션(trends_v4_brand_fungibility.sql) 적용 후 상태 가정
  const { data, error } = await (sb as any).rpc('jimscanner_brand_fungibility', {
    ggsan_min_sim: 0.2,
    result_limit: 500,
  })
  if (error) {
    console.error('[brand-fungibility] rpc error', error.message)
    return []
  }
  return (data ?? []) as FungibilityRow[]
}

export default async function BrandFungibilityPage() {
  const rows = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">브랜드 종속도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            제네릭(브랜드 중립) 수요 = 위탁 광맥 · 브랜드 종속 수요 = 소싱 불가·상표권 리스크
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600 leading-relaxed">
        <strong className="text-gray-800">브랜드 종속도</strong> = (브랜드 토큰 포함 alias + 모델번호/sku alias) ÷ 전체 alias.
        낮을수록 소비자가 <em>‘차량용 청소기’</em>처럼 제네릭 디스크립터로 검색 → 어떤 도매 동등품으로도 수요 충족 가능.
        높을수록 <em>‘샤오미 핸디’</em>처럼 특정 브랜드 지목 → 소싱 대체 불가. ggsan 열은 도매몰 유사 동등품 개수(즉시 소싱 가능성).
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. RPC(jimscanner_brand_fungibility) 마이그레이션 적용 + score 누적 후 다시 방문.
        </div>
      ) : (
        <BrandFungibilityBoard rows={rows} />
      )}
    </div>
  )
}
