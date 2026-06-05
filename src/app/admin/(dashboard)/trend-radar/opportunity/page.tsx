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
  if (ids.length === 0) return { rows: [], goFeed: [] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  // Go 후보 피드 — product_id 별 최신 brief 중 verdict='go'.
  // brief 테이블은 마이그레이션(supabase/trends_briefs.sql) 후 — 미적용 시 error 무시.
  const { data: briefRows } = await (sb as any)
    .from('jimscanner_trends_briefs')
    .select('product_id, verdict, confidence, top_reasons, recommended_action, suggested_price_band, generated_at')
    .order('generated_at', { ascending: false })
    .limit(500)

  const seenBrief = new Set<string>()
  const goFeed: any[] = []
  for (const b of (briefRows ?? []) as any[]) {
    if (seenBrief.has(b.product_id)) continue
    seenBrief.add(b.product_id)
    if (b.verdict !== 'go') continue
    const p = byId.get(b.product_id)
    goFeed.push({
      id: b.product_id,
      name: (p as any)?.canonical_name ?? '?',
      confidence: b.confidence,
      reasons: Array.isArray(b.top_reasons) ? b.top_reasons : [],
      action: b.recommended_action,
      priceBand: b.suggested_price_band,
    })
  }
  goFeed.sort((a, b) => b.confidence - a.confidence)

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,        // 경쟁 약함 → 점수 높음 → 오른쪽
        y: s.trend_score,              // 트렌드 강함 → 위
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
      }
    }),
    goFeed,
  }
}

export default async function OpportunityPage() {
  const { rows, goFeed } = await fetchData()

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
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
          <OpportunityScatter rows={rows} />
          <GoFeed feed={goFeed ?? []} />
        </div>
      )}
    </div>
  )
}

function GoFeed({ feed }: { feed: any[] }) {
  return (
    <aside className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-bold">🟢 Go 후보 피드</span>
        <span className="text-xs text-gray-400">{feed.length}건</span>
      </div>
      {feed.length === 0 ? (
        <p className="text-xs text-gray-400 py-6 text-center">
          아직 GO 평결 브리프 없음.
          <br />
          trends-generate-briefs 크론 누적 후 표시.
        </p>
      ) : (
        <ul className="space-y-2">
          {feed.map((g) => (
            <li key={g.id}>
              <Link
                href={`/admin/trend-radar/products/${g.id}`}
                className="block rounded border border-emerald-100 bg-emerald-50/40 p-3 hover:bg-emerald-50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900 truncate">{g.name}</span>
                  <span className="text-[10px] text-emerald-600 font-mono shrink-0 ml-2">
                    {(g.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                {g.priceBand && (
                  <div className="text-[11px] text-blue-700 mt-0.5">권장가 {g.priceBand}</div>
                )}
                {g.reasons[0] && (
                  <div className="text-xs text-gray-600 mt-1 line-clamp-2">• {g.reasons[0]}</div>
                )}
                {g.action && (
                  <div className="text-[11px] text-emerald-700 mt-1 truncate">→ {g.action}</div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
