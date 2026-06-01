import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OpportunityScatter from './OpportunityScatter'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 score 만 (product_id 별 latest)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at')
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

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    // logistics_suitability/reasons 는 trends_v4_logistics_gate.sql 적용 후 컬럼 — generated 타입 미반영
    .select('id, canonical_name, category_top, logistics_suitability, logistics_reasons')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      const suit = (p as any).logistics_suitability
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
        logistics: (suit === 'fit' || suit === 'caution' || suit === 'unfit' ? suit : null) as
          | 'fit'
          | 'caution'
          | 'unfit'
          | null,
        logisticsReasons: Array.isArray((p as any).logistics_reasons) ? ((p as any).logistics_reasons as string[]) : [],
      }
    }),
  }
}

export default async function OpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ lg?: string }>
}) {
  const sp = await searchParams
  const excludeUnfit = sp.lg === '1'
  const { rows: allRows } = await fetchData()
  const unfitCount = allRows.filter((r) => r.logistics === 'unfit').length
  const rows = excludeUnfit ? allRows.filter((r) => r.logistics !== 'unfit') : allRows

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Opportunity Matrix</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 핀 후보 = 우상단 큰 점
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 위탁 물류 적합성 게이트 필터 */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-gray-500">위탁 물류:</span>
        <Link
          href={excludeUnfit ? '/admin/trend-radar/opportunity' : '/admin/trend-radar/opportunity?lg=1'}
          className={`px-3 py-1 rounded ${excludeUnfit ? 'bg-red-100 text-red-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          title="리튬배터리·냉장/냉동·가구급 대형 등 위탁 부적합 후보 숨김"
        >
          {excludeUnfit ? '✓ ' : ''}부적합 제외{unfitCount > 0 ? ` (${unfitCount})` : ''}
        </Link>
        <span className="text-gray-400">
          분류 패스(classify-trends-llm) 누적 후 등급 채워짐 · 적합/주의/부적합
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <OpportunityScatter rows={rows} />
      )}
    </div>
  )
}
