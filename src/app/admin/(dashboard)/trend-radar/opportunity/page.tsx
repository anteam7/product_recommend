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

interface RiskRow {
  product_id: string
  severity: number
  summary: string | null
  risk_tags: string[]
  hs_code_guess: string | null
}

// final_score 에서 차감할 risk_penalty 컴포넌트.
// severity 0 → 0, 1 → 5, 2 → 12, 3 → 25 점 패널티.
function riskPenalty(severity: number) {
  if (severity >= 3) return 25
  if (severity >= 2) return 12
  if (severity >= 1) return 5
  return 0
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
  if (ids.length === 0) return { rows: [], risks: [] as Array<RiskRow & { name: string }> }

  const [prodRes, regRes] = await Promise.all([
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', ids),
    (sb as any)
      .from('jimscanner_trends_regulation')
      .select('product_id, severity, summary, risk_tags, hs_code_guess')
      .in('product_id', ids)
      .gte('severity', 1),
  ])
  const byId = new Map((prodRes.data ?? []).map((p: any) => [p.id, p]))
  const riskById = new Map<string, RiskRow>(
    ((regRes?.data ?? []) as RiskRow[]).map((r) => [r.product_id, r]),
  )

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      const r = riskById.get(s.product_id)
      const penalty = riskPenalty(r?.severity ?? 0)
      const adjustedFinal = Math.max(0, s.final_score - penalty)
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: adjustedFinal,
        supplier: s.supplier_score,
        riskSeverity: r?.severity ?? 0,
      }
    }),
    risks: (regRes?.data ?? [])
      .map((r: RiskRow) => ({
        ...r,
        name: (byId.get(r.product_id) as any)?.canonical_name ?? '?',
      }))
      .sort((a: any, b: any) => b.severity - a.severity)
      .slice(0, 30) as Array<RiskRow & { name: string }>,
  }
}

export default async function OpportunityPage() {
  const { rows, risks } = await fetchData()

  const highRisk = risks.filter((r) => r.severity >= 2)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Opportunity Matrix</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 핀 후보 = 우상단 큰 점
          </p>
          <p className="text-xs text-gray-400 mt-1">
            final_score 는 규제 리스크 페널티 차감 후 (severity 1=-5, 2=-12, 3=-25)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {highRisk.length > 0 && (
        <section className="rounded border border-red-200 bg-red-50 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-red-900">
              🛡 진입 전 점검 필요 ({highRisk.length})
            </h2>
            <Link
              href="/admin/trend-radar/risk"
              className="text-xs text-red-700 hover:underline"
            >
              전체 보기 →
            </Link>
          </div>
          <ul className="mt-2 grid md:grid-cols-2 gap-1 text-xs">
            {highRisk.slice(0, 12).map((r) => (
              <li key={r.product_id} className="flex items-center gap-2">
                <span
                  className={
                    r.severity === 3
                      ? 'inline-block w-2 h-2 rounded-full bg-red-600'
                      : 'inline-block w-2 h-2 rounded-full bg-orange-500'
                  }
                />
                <Link
                  href={`/admin/trend-radar/products/${r.product_id}`}
                  className="font-medium hover:underline truncate"
                >
                  {r.name}
                </Link>
                <span className="text-gray-600 truncate">— {r.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
