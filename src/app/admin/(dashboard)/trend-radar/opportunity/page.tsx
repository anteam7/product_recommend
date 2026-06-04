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
    // regulatory_regime / consignment_blocker 는 trends_v4_regulatory.sql 적용 후 존재 (gen:types 전까지 any)
    .select('id, canonical_name, category_top, regulatory_regime, consignment_blocker')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  return {
    rows: latest.map((s) => {
      const p = (byId.get(s.product_id) ?? {}) as any
      return {
        id: s.product_id,
        name: p.canonical_name ?? '?',
        category: p.category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
        regime: (p.regulatory_regime ?? null) as string | null,
        blocker: (p.consignment_blocker ?? 'none') as string,
      }
    }),
  }
}

export default async function OpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ safe?: string }>
}) {
  const sp = await searchParams
  const safeOnly = sp.safe === '1'
  const { rows } = await fetchData()

  // 🛡️ 인증부담 통계
  const blockerCount = rows.filter((r) => r.blocker === 'blocker').length
  const highCount = rows.filter((r) => r.blocker === 'high').length
  // '위탁 즉시판매 가능만' = blocker/high 제외 (none/low 만)
  const visibleRows = safeOnly
    ? rows.filter((r) => r.blocker !== 'blocker' && r.blocker !== 'high')
    : rows

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

      {/* 🛡️ 규제 게이트 필터 */}
      <div className="flex flex-wrap items-center gap-3 rounded border border-gray-200 px-4 py-3 text-xs">
        <span className="text-gray-500">🛡️ 인증·규제 게이트</span>
        <Link
          href={safeOnly ? '/admin/trend-radar/opportunity' : '/admin/trend-radar/opportunity?safe=1'}
          className={`px-3 py-1 rounded font-semibold ${
            safeOnly ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {safeOnly ? '✓ ' : ''}위탁 즉시판매 가능만
        </Link>
        <span className="text-red-600">⛔ 위탁불가 {blockerCount}</span>
        <span className="text-amber-600">⚠️ 인증필요 {highCount}</span>
        <span className="text-gray-400">
          {safeOnly ? `${visibleRows.length}/${rows.length} 표시 중` : `전체 ${rows.length}`}
        </span>
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {rows.length === 0
            ? '아직 데이터 없음. cron 누적 후 다시 방문.'
            : '필터 조건(위탁 즉시판매 가능)에 맞는 후보 없음.'}
        </div>
      ) : (
        <OpportunityScatter rows={visibleRows} />
      )}
    </div>
  )
}
