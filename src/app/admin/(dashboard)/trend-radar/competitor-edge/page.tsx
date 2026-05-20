import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  type CompetitorListingRow,
  summarize,
  type Lever,
} from '@/lib/competitor-edge'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

async function fetchBoard() {
  const sb = createAdminClient()

  // 1) 최근 final_score 상위 50개 후보
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)
  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  latest.sort((a, b) => Number(b.final_score) - Number(a.final_score))
  const top = latest.slice(0, 50)
  const ids = top.map((t) => t.product_id)
  if (ids.length === 0) return { rows: [] as BoardRow[] }

  // 2) 상품명
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map<string, ProductRow>(
    ((prods ?? []) as ProductRow[]).map((p) => [p.id, p]),
  )

  // 3) competitor listings (latest snapshot 만)
  const { data: listings } = await (sb as any)
    .from('jimscanner_serp_competitor_latest')
    .select('*')
    .in('product_id', ids)
  const byPid = new Map<string, CompetitorListingRow[]>()
  for (const row of ((listings ?? []) as CompetitorListingRow[])) {
    const arr = byPid.get(row.product_id) ?? []
    arr.push(row)
    byPid.set(row.product_id, arr)
  }

  const rows: BoardRow[] = top.map((t) => {
    const p = byId.get(t.product_id)
    const rs = byPid.get(t.product_id) ?? []
    const summary = summarize(rs)
    return {
      id: t.product_id,
      name: p?.canonical_name ?? '?',
      category: p?.category_top ?? '?',
      finalScore: Number(t.final_score),
      gap: summary.gap,
      hasData: summary.hasData,
      topSeller: summary.leader?.seller ?? null,
      levers: summary.levers.slice(0, 3),
    }
  })

  // gap desc — 약점이 큰(=진입 ROI 높은) 핀 먼저
  rows.sort((a, b) => b.gap - a.gap || b.finalScore - a.finalScore)

  return { rows }
}

interface BoardRow {
  id: string
  name: string
  category: string
  finalScore: number
  gap: number
  hasData: boolean
  topSeller: string | null
  levers: Lever[]
}

export default async function CompetitorEdgePage() {
  const { rows } = await fetchBoard()
  const withData = rows.filter((r) => r.hasData).length

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">Beat-Them-On-X 약점 보드</h1>
        <p className="text-sm text-gray-500 mt-1">
          상위 후보 핀의 1위 판매자 실행 변수(옵션·상세컷·동영상·배송 SLA·리뷰 응답)를
          비교해, 우리가 이길 수 있는 레버를 우선순위로 보여준다. {' '}
          <span className="text-gray-400">
            ({withData}/{rows.length} 핀에 SERP 스냅샷 존재)
          </span>
        </p>
      </header>

      <div className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-3 py-2 text-left">상품</th>
              <th className="px-3 py-2 text-left">카테고리</th>
              <th className="px-3 py-2 text-right">final</th>
              <th className="px-3 py-2 text-right">edge gap</th>
              <th className="px-3 py-2 text-left">1위 판매자</th>
              <th className="px-3 py-2 text-left">Top 3 레버</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <Link
                    href={`/admin/trend-radar/products/${r.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.category}</td>
                <td className="px-3 py-2 text-right font-mono">{r.finalScore}</td>
                <td className="px-3 py-2 text-right">
                  {r.hasData ? (
                    <span
                      className={`font-mono font-bold ${
                        r.gap >= 60
                          ? 'text-emerald-600'
                          : r.gap >= 30
                          ? 'text-amber-600'
                          : 'text-gray-400'
                      }`}
                    >
                      {r.gap}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-300">no data</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">{r.topSeller ?? '—'}</td>
                <td className="px-3 py-2">
                  {r.levers.length === 0 ? (
                    <span className="text-xs text-gray-400">—</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {r.levers.map((l) => (
                        <li key={l.key} className="text-xs">
                          <span className="font-medium">{l.label}</span>
                          <span className="text-gray-400"> · 1위 {l.topValue}</span>
                          <span className="text-gray-600"> → {l.action}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">
                  데이터 없음 — scripts/scout-serp-competitors.mjs 를 먼저 실행하세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400">
        수집: scripts/scout-serp-competitors.mjs (주 1회). edge gap 은 1위의 약한 레버
        top 3 priority 평균(0~100) — 클수록 진입 ROI 가 큼.
      </p>
    </div>
  )
}
