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
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  // 컴백(재출현) 상품 id 집합 — VIEW jimscanner_trends_comeback (generated 타입 미반영)
  const { data: comeback } = await sb
    .from('jimscanner_trends_comeback' as never)
    .select('product_id')
  const comebackIds = new Set<string>(((comeback ?? []) as unknown as { product_id: string }[]).map((c) => c.product_id))

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
        comeback: comebackIds.has(s.product_id),
      }
    }),
  }
}

export default async function OpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ comeback?: string }>
}) {
  const sp = await searchParams
  const comebackOnly = sp.comeback === '1'
  const { rows: allRows } = await fetchData()
  const comebackCount = allRows.filter((r) => r.comeback).length
  const rows = comebackOnly ? allRows.filter((r) => r.comeback) : allRows

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

      {/* 칩 필터 */}
      <div className="flex flex-wrap gap-1">
        <Link
          href="/admin/trend-radar/opportunity"
          className={`px-3 py-1 text-xs rounded ${!comebackOnly ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          전체
        </Link>
        <Link
          href="/admin/trend-radar/opportunity?comeback=1"
          className={`px-3 py-1 text-xs rounded ${comebackOnly ? 'bg-emerald-600 text-white font-semibold' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'}`}
        >
          🔁 컴백만 ({comebackCount})
        </Link>
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
