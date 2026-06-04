import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SkylineBoard, { type SkylineRow } from './SkylineBoard'

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

const AXES = ['trend', 'commerce', 'supplier', 'competition'] as const
type Axis = (typeof AXES)[number]

interface Cand {
  id: string
  name: string
  category: string
  final: number
  v: Record<Axis, number>
}

// A dominates B: 모든 축 ≥ 그리고 최소 한 축 >
function dominates(a: Cand, b: Cand): boolean {
  let strict = false
  for (const ax of AXES) {
    if (a.v[ax] < b.v[ax]) return false
    if (a.v[ax] > b.v[ax]) strict = true
  }
  return strict
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
  if (ids.length === 0) return { rows: [] as SkylineRow[], total: 0 }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const cands: Cand[] = latest.map((s) => {
    const p = byId.get(s.product_id) ?? {}
    return {
      id: s.product_id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      final: s.final_score,
      v: {
        trend: s.trend_score,
        commerce: s.commerce_score,
        supplier: s.supplier_score,
        competition: s.competition_score,
      },
    }
  })

  // 파레토 스카이라인: 다른 누구에게도 피지배되지 않는 후보만 생존
  const skyline: Cand[] = cands.filter((b) => !cands.some((a) => a.id !== b.id && dominates(a, b)))

  // 각 스카이라인 후보의 dominance depth = 자신이 지배한 후보 수
  const rows: SkylineRow[] = skyline.map((c) => {
    let depth = 0
    for (const other of cands) {
      if (other.id !== c.id && dominates(c, other)) depth++
    }

    // 차별 강점 축: 다른 스카이라인 후보 전부보다 '유일하게' 우위인 축
    const uniqueAxes: Axis[] = AXES.filter((ax) =>
      skyline.every((o) => o.id === c.id || c.v[ax] > o.v[ax]),
    )

    // 유일 우위 축이 없으면, 스카이라인 평균 대비 가장 앞선 축을 강점으로
    let bestAxis: Axis = AXES[0]
    let bestEdge = -Infinity
    for (const ax of AXES) {
      const mean =
        skyline.reduce((s, o) => s + o.v[ax], 0) / Math.max(1, skyline.length)
      const edge = c.v[ax] - mean
      if (edge > bestEdge) {
        bestEdge = edge
        bestAxis = ax
      }
    }

    return {
      id: c.id,
      name: c.name,
      category: c.category,
      final: c.final,
      v: c.v,
      depth,
      uniqueAxes,
      strongestAxis: bestAxis,
    }
  })

  rows.sort((a, b) => b.depth - a.depth || b.final - a.final)

  return { rows, total: cands.length }
}

export default async function SkylinePage() {
  const { rows, total } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">파레토 스카이라인 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            4축(trend·commerce·supplier·competition)을 가중치 없이 피지배 가지치기 ·{' '}
            {total}개 → 비피지배 {rows.length}개 · 어떻게 가중해도 누군가에게 밀리지 않는 후보만 노출
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
        <SkylineBoard rows={rows} total={total} />
      )}
    </div>
  )
}
