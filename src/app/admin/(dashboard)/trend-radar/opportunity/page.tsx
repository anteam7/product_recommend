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

  // 자기잠식 게이트: 후보 canonical_name 을 자사 등록 SKU 와 교차대조
  const names = Array.from(
    new Set(
      latest
        .map((s) => (byId.get(s.product_id) as any)?.canonical_name)
        .filter((n: unknown): n is string => typeof n === 'string' && n.trim().length > 0),
    ),
  )
  const cannibalMap = new Map<string, { riskPct: number; conflictTitle: string | null }>()
  if (names.length > 0) {
    // RPC는 supabase/cannibalization_check_rpc.sql 에 정의 — generated 타입 미반영, 캐스팅 사용
    const { data: conflicts } = await sb.rpc('jimscanner_cannibalization_check' as never, {
      candidate_titles: names,
      min_sim: 0.3,
    } as never)
    for (const c of (conflicts ?? []) as Array<{
      candidate_title: string
      similarity_pct: number
      conflict_title: string | null
    }>) {
      const prev = cannibalMap.get(c.candidate_title)
      if (!prev || c.similarity_pct > prev.riskPct) {
        cannibalMap.set(c.candidate_title, { riskPct: c.similarity_pct, conflictTitle: c.conflict_title })
      }
    }
  }
  const RISK_THRESHOLD = 45

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      const name = (p as any).canonical_name ?? '?'
      const conflict = cannibalMap.get(name)
      return {
        id: s.product_id,
        name,
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
        cannibal: (conflict?.riskPct ?? 0) >= RISK_THRESHOLD,
        riskPct: conflict?.riskPct ?? 0,
        conflictTitle: conflict?.conflictTitle ?? null,
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
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 핀 후보 = 우상단 큰 점 · 🚨 빨강 점선 = 자기잠식 위험
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
