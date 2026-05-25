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

async function fetchHhiByCategory(): Promise<Map<string, number>> {
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_trends_category_concentration')
    .select('category_top, hhi')
  const m = new Map<string, number>()
  for (const r of ((data ?? []) as { category_top: string; hhi: number | string }[])) {
    m.set(r.category_top, Number(r.hhi))
  }
  return m
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

  const [{ data: prods }, hhiMap] = await Promise.all([
    sb.from('jimscanner_trends_products').select('id, canonical_name, category_top').in('id', ids),
    fetchHhiByCategory(),
  ])
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      const cat = (p as any).category_top ?? 'all'
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: cat,
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
        hhi: hhiMap.get(cat) ?? null,
      }
    }),
  }
}

export default async function OpportunityPage() {
  const { rows } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Opportunity Matrix</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 색 = 카테고리 HHI (초록 fragmented → 빨강 독과점) · 핀 후보 = 우상단 큰 점
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

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
