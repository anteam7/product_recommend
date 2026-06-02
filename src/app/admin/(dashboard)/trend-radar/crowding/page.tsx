import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CrowdingScatter, { type CrowdRow } from './CrowdingScatter'

export const dynamic = 'force-dynamic'

// trends_v4_crowding_rpc.sql 적용 후 상태 가정 (생성 타입에 아직 없음 → as any)
interface CrowdRpcRow {
  product_id: string
  canonical_name: string | null
  category_top: string | null
  competition_latest: number | null
  trend_latest: number | null
  final_latest: number | null
  competition_slope: number | null
  trend_slope: number | null
  competition_delta: number | null
  trend_delta: number | null
  n_points: number
  first_at: string
  last_at: string
}

async function fetchData(): Promise<CrowdRow[]> {
  const sb = createAdminClient()
  const { data } = await (sb.rpc as any)('jimscanner_trends_crowding', {
    days_window: 7,
    min_points: 3,
    result_limit: 500,
  })
  const rows = ((data ?? []) as CrowdRpcRow[]).filter((r) => r.competition_slope != null)
  return rows.map((r) => ({
    id: r.product_id,
    name: r.canonical_name ?? '?',
    category: r.category_top ?? 'all',
    compSlope: Number(r.competition_slope ?? 0),
    trendSlope: Number(r.trend_slope ?? 0),
    compLatest: Number(r.competition_latest ?? 0),
    trendLatest: Number(r.trend_latest ?? 0),
    final: Number(r.final_latest ?? 0),
    nPoints: r.n_points,
  }))
}

export default async function CrowdingPage() {
  const rows = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">경쟁 혼잡화 속도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            competition_score 7일 기울기(경쟁 유입 가속도) × trend Δ(수요 가속도) — 진입창이
            열려있는지/닫히는지 분리. X = 경쟁 가속, Y = 수요 가속, 크기 = final.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 기울기 산출 데이터 없음. recompute 가 7일 내 최소 3회 누적돼야 회귀 기울기가
          나옵니다. cron 누적 후 다시 방문.
        </div>
      ) : (
        <CrowdingScatter rows={rows} />
      )}
    </div>
  )
}
