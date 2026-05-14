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

interface ScatterRow {
  id: string
  name: string
  category: string
  x: number
  y: number
  size: number
  final: number
  supplier: number
  deltaFinal: number
  deltaTrend: number
  hasPrev: boolean
}

interface LeaderRow {
  id: string
  name: string
  category: string
  final: number
  prevFinal: number
  deltaFinal: number
}

async function fetchData(): Promise<{ rows: ScatterRow[]; risers: LeaderRow[]; fallers: LeaderRow[] }> {
  const sb = createAdminClient()

  // product_id 별 최신 2개를 뽑기 위해 더 넉넉히 받아옴
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(4000)

  const byProduct = new Map<string, ScoreRow[]>()
  for (const s of (scores ?? []) as ScoreRow[]) {
    const arr = byProduct.get(s.product_id) ?? []
    if (arr.length < 2) {
      arr.push(s)
      byProduct.set(s.product_id, arr)
    }
  }

  const ids = Array.from(byProduct.keys())
  if (ids.length === 0) return { rows: [], risers: [], fallers: [] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const rows: ScatterRow[] = []
  const leaders: LeaderRow[] = []

  for (const [pid, arr] of byProduct.entries()) {
    const latest = arr[0]
    const prev = arr[1]
    const p = byId.get(pid) ?? {}
    const name = (p as any).canonical_name ?? '?'
    const category = (p as any).category_top ?? 'all'
    const hasPrev = !!prev
    const deltaFinal = hasPrev ? Number((latest.final_score - prev.final_score).toFixed(2)) : 0
    const deltaTrend = hasPrev ? Number((latest.trend_score - prev.trend_score).toFixed(2)) : 0

    rows.push({
      id: pid,
      name,
      category,
      x: latest.competition_score,
      y: latest.trend_score,
      size: Math.max(50, latest.commerce_score * 4),
      final: latest.final_score,
      supplier: latest.supplier_score,
      deltaFinal,
      deltaTrend,
      hasPrev,
    })

    if (hasPrev && Math.abs(deltaFinal) > 0.01) {
      leaders.push({
        id: pid,
        name,
        category,
        final: latest.final_score,
        prevFinal: prev.final_score,
        deltaFinal,
      })
    }
  }

  const sortedByDelta = [...leaders].sort((a, b) => b.deltaFinal - a.deltaFinal)
  const risers = sortedByDelta.filter((l) => l.deltaFinal > 0).slice(0, 3)
  const fallers = sortedByDelta.filter((l) => l.deltaFinal < 0).slice(-3).reverse()

  return { rows, risers, fallers }
}

function MomentumTable({
  title,
  rows,
  tone,
  emptyHint,
}: {
  title: string
  rows: LeaderRow[]
  tone: 'up' | 'down'
  emptyHint: string
}) {
  const bg = tone === 'up' ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'
  const arrow = tone === 'up' ? '▲' : '▼'
  const arrowColor = tone === 'up' ? 'text-emerald-600' : 'text-rose-600'
  return (
    <div className={`rounded border ${bg} p-4`}>
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <span className={arrowColor}>{arrow}</span>
        {title}
      </h3>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-500">{emptyHint}</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-[11px] text-gray-500 uppercase tracking-wide">
            <tr>
              <th className="text-left font-normal pb-1">#</th>
              <th className="text-left font-normal pb-1">상품</th>
              <th className="text-right font-normal pb-1">Δfinal</th>
              <th className="text-right font-normal pb-1">final</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-white/50">
                <td className="py-1.5 text-gray-400 font-mono text-xs">{i + 1}</td>
                <td className="py-1.5">
                  <Link
                    href={`/admin/trend-radar/products/${r.id}`}
                    className="hover:underline"
                  >
                    {r.name}
                  </Link>
                  <span className="ml-2 text-[10px] text-gray-400">{r.category}</span>
                </td>
                <td className={`py-1.5 text-right font-mono font-semibold ${arrowColor}`}>
                  {r.deltaFinal > 0 ? '+' : ''}
                  {r.deltaFinal.toFixed(1)}
                </td>
                <td className="py-1.5 text-right font-mono text-gray-600">{r.final}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default async function OpportunityPage() {
  const { rows, risers, fallers } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Opportunity Matrix</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 화살표 = 직전 대비 final 변화
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
        <>
          <OpportunityScatter rows={rows} />

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MomentumTable
              title="모멘텀 상승 TOP3"
              rows={risers}
              tone="up"
              emptyHint="아직 상승 종목 없음. recompute_scores 2회 이상 누적 필요."
            />
            <MomentumTable
              title="모멘텀 하락 TOP3"
              rows={fallers}
              tone="down"
              emptyHint="하락 종목 없음."
            />
          </section>
        </>
      )}
    </div>
  )
}
