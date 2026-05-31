import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ScoringLab, { type LabRow, type Profile } from './ScoringLab'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: Record<string, unknown> | null
  computed_at: string
}

async function fetchData(): Promise<{ rows: LabRow[]; profiles: Profile[] }> {
  const sb = createAdminClient()

  // 최신 score 만 (product_id 별 latest computed_at)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)

  const byId = new Map<string, any>()
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', ids)
    for (const p of (prods ?? []) as any[]) byId.set(p.id, p)
  }

  const rows: LabRow[] = latest.map((s) => {
    const p = byId.get(s.product_id) ?? {}
    return {
      id: s.product_id,
      name: p.canonical_name ?? '?',
      category: p.category_top ?? 'all',
      trend: Number(s.trend_score) || 0,
      commerce: Number(s.commerce_score) || 0,
      supplier: Number(s.supplier_score) || 0,
      competition: Number(s.competition_score) || 0,
      baselineFinal: Number(s.final_score) || 0,
      components: (s.score_components ?? {}) as Record<string, Record<string, number>>,
      computedAt: s.computed_at,
    }
  })

  // 가중치 프로파일 프리셋 (마이그레이션 후 테이블 존재 가정 — as any 캐스팅)
  let profiles: Profile[] = []
  try {
    const { data: profData } = await (sb as any)
      .from('jimscanner_trends_score_profiles')
      .select('id, name, weights')
      .order('created_at', { ascending: true })
    profiles = ((profData ?? []) as any[]).map((p) => ({
      id: p.id,
      name: p.name,
      weights: p.weights ?? {},
    }))
  } catch {
    profiles = []
  }

  return { rows, profiles }
}

export default async function ScoringLabPage() {
  const { rows, profiles } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">점수 가중치 What-if 랩</h1>
          <p className="mt-1 text-sm text-gray-500">
            4개 컴포넌트 가중치를 직접 조절해 <b>내 성향 기준 진짜 1순위</b>를 즉시 재랭킹.
            행을 펼치면 워터폴로 점수 분해를 확인. (서버 재집계 없이 브라우저에서 계산)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 점수 데이터 없음. recompute cron 누적 후 다시 방문.
        </div>
      ) : (
        <ScoringLab rows={rows} profiles={profiles} />
      )}
    </div>
  )
}
