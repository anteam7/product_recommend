import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ParetoFrontier from './ParetoFrontier'
import { computeFrontier, type Candidate } from './pareto'

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
  if (ids.length === 0) return { nodes: [] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const cands: Candidate[] = latest.map((s) => {
    const p = byId.get(s.product_id) ?? {}
    return {
      id: s.product_id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      trend: Number(s.trend_score),
      commerce: Number(s.commerce_score),
      supplier: Number(s.supplier_score),
      competition: Number(s.competition_score),
      final: Number(s.final_score),
    }
  })

  return { nodes: computeFrontier(cands) }
}

export default async function FrontierPage() {
  const { nodes } = await fetchData()

  const layer1 = nodes.filter((n) => n.layer === 1).length
  const dominated = nodes.length - layer1

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">비지배 후보 프론티어</h1>
          <p className="text-sm text-gray-500 mt-1">
            4점수(trend·commerce·supplier·competition)를 다차원 벡터로 보고 파레토 지배 관계를 판정.{' '}
            <span className="text-sky-600 font-medium">{layer1}개 비지배</span> ·{' '}
            <span className="text-gray-400">{dominated}개 dominated(제외)</span> / 총 {nodes.length}
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {nodes.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <ParetoFrontier nodes={nodes} />
      )}
    </div>
  )
}
