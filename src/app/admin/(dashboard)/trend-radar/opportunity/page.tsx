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

  // 반품 리스크 오버레이 (최신 row 만). 새 테이블이라 타입 미생성 → as any.
  const { data: risks } = await (sb as any)
    .from('jimscanner_return_risk')
    .select('product_id, return_risk_score, gate, computed_at')
    .in('product_id', ids)
    .order('computed_at', { ascending: false })
    .limit(5000)
  const riskById = new Map<string, { return_risk_score: number; gate: string }>()
  for (const r of (risks ?? []) as { product_id: string; return_risk_score: number; gate: string }[]) {
    if (!riskById.has(r.product_id)) riskById.set(r.product_id, r)
  }

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      const risk = riskById.get(s.product_id)
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
        returnRisk: risk?.return_risk_score ?? null,
        returnGate: risk?.gate ?? null,
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
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 핀 후보 = 우상단 큰 점
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
