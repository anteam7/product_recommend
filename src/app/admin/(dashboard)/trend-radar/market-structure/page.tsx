import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import MarketStructureScatter from './MarketStructureScatter'

export const dynamic = 'force-dynamic'

export interface CategoryStructureRow {
  category_mid: string
  category_top: string
  product_count: number
  demand_total: number
  hhi: number            // 0~10000 (낮을수록 파편화)
  cr3: number            // 0~100 %
  trend_momentum: number // 평균 trend Δ
}

export interface DrilldownItem {
  name: string
  score: number
  share: number // 0~100 %
}

interface ScoreRow {
  product_id: string
  trend_score: number
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 1) 보드 지표 (RPC) — DB(supabase/trends_category_structure_rpc.sql)에 존재, generated 타입 미반영
  const { data: rpcData, error } = await sb.rpc(
    'jimscanner_trends_category_structure' as never,
    { min_products: 2 } as never,
  )
  const rows = ((rpcData ?? []) as CategoryStructureRow[]) || []

  // 2) 드릴다운용 — 상품별 최신 trend_score 로 카테고리 내 점유율 막대 구성
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(4000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)
  const scoreById = new Map(latest.map((s) => [s.product_id, s.trend_score]))

  const drill: Record<string, DrilldownItem[]> = {}
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_mid')
      .in('id', ids)

    const grouped: Record<string, { name: string; score: number }[]> = {}
    for (const p of (prods ?? []) as any[]) {
      const mid = p.category_mid
      if (!mid) continue
      const score = Number(scoreById.get(p.id) ?? 0)
      if (score <= 0) continue
      ;(grouped[mid] ??= []).push({ name: p.canonical_name ?? '?', score })
    }
    for (const [mid, items] of Object.entries(grouped)) {
      const total = items.reduce((a, b) => a + b.score, 0) || 1
      drill[mid] = items
        .map((it) => ({ name: it.name, score: it.score, share: (it.score / total) * 100 }))
        .sort((a, b) => b.share - a.share)
        .slice(0, 12)
    }
  }

  return { rows, drill, error: error?.message ?? null }
}

export default async function MarketStructurePage() {
  const { rows, drill, error } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">시장구조 보드 (HHI)</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 카테고리 수요규모(→ 클수록 큰 시장) · Y = 파편화도(↑ HHI 낮음) · 버블 = 상품수 · 색 = 트렌드 모멘텀 · 🎯 우상단 = 진입 용이존
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          RPC 오류: {error} — supabase/trends_category_structure_rpc.sql 적용 여부 확인.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 category_mid 분류 데이터가 부족. cron 누적 + alias 분류 후 다시 방문.
        </div>
      ) : (
        <MarketStructureScatter rows={rows} drill={drill} />
      )}
    </div>
  )
}
