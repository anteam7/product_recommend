import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import DisplacementMiniChart from './DisplacementMiniChart'

export const dynamic = 'force-dynamic'

interface Point {
  t: string
  v: number
}

interface DisplacementRow {
  id: string
  rising_id: string
  declining_id: string
  category_mid: string | null
  anti_corr: number
  share_shift: number
  rising_slope: number
  declining_slope: number
  window_days: number
  sample_points: number
  trajectories: {
    rising?: Point[]
    declining?: Point[]
    rising_name?: string | null
    declining_name?: string | null
  } | null
  computed_at: string
}

async function fetchPairs(): Promise<DisplacementRow[]> {
  const sb = createAdminClient()

  // jimscanner_trends_displacement 는 신규 마이그레이션 → 타입 미반영, as any 캐스팅
  const { data } = await (sb as any)
    .from('jimscanner_trends_displacement')
    .select(
      'id, rising_id, declining_id, category_mid, anti_corr, share_shift, rising_slope, declining_slope, window_days, sample_points, trajectories, computed_at',
    )
    .order('computed_at', { ascending: false })
    .order('anti_corr', { ascending: true })
    .limit(200)

  const rows = (data ?? []) as DisplacementRow[]

  // 가장 최신 computed_at 배치만 노출 (재계산마다 새 배치)
  if (rows.length === 0) return []
  const latestBatch = rows[0].computed_at
  return rows
    .filter((r) => r.computed_at === latestBatch)
    .sort((a, b) => a.anti_corr - b.anti_corr)
}

function corrStrength(c: number): { label: string; color: string } {
  if (c <= -0.85) return { label: '매우 강함', color: 'text-red-700' }
  if (c <= -0.7) return { label: '강함', color: 'text-red-600' }
  return { label: '뚜렷함', color: 'text-amber-600' }
}

export default async function DisplacementPage() {
  const pairs = await fetchPairs()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">수요 대체 (Displacement)</h1>
          <p className="mt-1 text-sm text-gray-500">
            같은 니드 공간에서 한쪽이 뜨며 다른쪽 수요를 잠식하는 페어. ↗ 떠오르는 쪽은 수요가 이미 검증돼
            진입 리스크가 낮은 <b>최상의 위탁 후보</b>다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {pairs.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 대체 페어 없음. <code>compute-displacement</code> cron 이 trend_score 시계열을 누적·계산하면
          자연스럽게 등장합니다. (최소 {5}일 공통 관측 필요)
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {pairs.map((p) => {
            const traj = p.trajectories ?? {}
            const risingName = traj.rising_name ?? '떠오르는 상품'
            const decliningName = traj.declining_name ?? '쇠퇴 상품'
            const strength = corrStrength(p.anti_corr)
            return (
              <div key={p.id} className="rounded-lg border border-gray-200 p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                    {p.category_mid ?? '클러스터'}
                  </span>
                  <span className={`text-xs font-semibold ${strength.color}`}>
                    음의 상관 {p.anti_corr.toFixed(2)} · {strength.label}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* 떠오르는 쪽 */}
                  <Link
                    href={`/admin/trend-radar/products/${p.rising_id}`}
                    className="rounded border border-emerald-200 bg-emerald-50 p-2 transition hover:border-emerald-400"
                  >
                    <div className="mb-1 inline-flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      ✓ 검증된 수요 이전
                    </div>
                    <div className="line-clamp-2 text-sm font-semibold text-emerald-900">
                      ↗ {risingName}
                    </div>
                    <div className="mt-1 text-[11px] text-emerald-700">
                      기울기 +{p.rising_slope.toFixed(2)}/일 · 소싱 우선
                    </div>
                  </Link>

                  {/* 쇠퇴하는 쪽 */}
                  <Link
                    href={`/admin/trend-radar/products/${p.declining_id}`}
                    className="rounded border border-red-200 bg-red-50 p-2 transition hover:border-red-400"
                  >
                    <div className="mb-1 inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      ⚠ 소싱 회피
                    </div>
                    <div className="line-clamp-2 text-sm font-semibold text-red-900">
                      ↘ {decliningName}
                    </div>
                    <div className="mt-1 text-[11px] text-red-700">
                      기울기 {p.declining_slope.toFixed(2)}/일 · 수요 이탈
                    </div>
                  </Link>
                </div>

                <div className="mt-3 border-t border-gray-100 pt-3">
                  <DisplacementMiniChart
                    rising={traj.rising ?? []}
                    declining={traj.declining ?? []}
                  />
                  <div className="mt-2 flex justify-between text-[11px] text-gray-500">
                    <span>점유 이전 ≈ {p.share_shift.toFixed(1)}점</span>
                    <span>
                      {p.window_days}일 창 · {p.sample_points}포인트
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
