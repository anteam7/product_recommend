import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import StrategyBoard from './StrategyBoard'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
  score_components?: any
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 score (product_id 별 latest) — page.tsx / opportunity 와 동일 패턴
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components',
    )
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

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        trend: Number(s.trend_score) || 0,
        commerce: Number(s.commerce_score) || 0,
        supplier: Number(s.supplier_score) || 0,
        competition: Number(s.competition_score) || 0,
        baseFinal: Number(s.final_score) || 0,
        components: s.score_components ?? null,
      }
    }),
  }
}

export default async function StrategyPage() {
  const { rows } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">⚖️ 전략 가중치 시뮬레이터</h1>
          <p className="text-sm text-gray-500 mt-1">
            4축(trend·commerce·supplier·competition) 가중치를 직접 돌려 실시간 재랭킹 · 기본 랭킹이 묻어둔 <strong>숨은 후보</strong> 발굴
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 score 데이터 없음. recompute cron 누적 후 다시 방문.
        </div>
      ) : (
        <StrategyBoard rows={rows} />
      )}
    </div>
  )
}
