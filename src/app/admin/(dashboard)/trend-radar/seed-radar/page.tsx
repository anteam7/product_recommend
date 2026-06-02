import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PromoteButton, PruneButton, ReactivateButton } from './RadarButtons'

export const dynamic = 'force-dynamic'

interface UncoveredRow {
  token: string
  frequency: number
  source_count: number
  sources: string[]
  sample_title: string | null
  last_seen: string
}

interface RoiRow {
  seed_id: string
  source: string
  kind: string
  label: string
  is_active: boolean
  keyword_count: number
  product_count: number
  avg_final_score: number | null
  last_keyword_at: string | null
}

async function fetchData() {
  // seed_radar RPC 는 generated 타입에 아직 없어 `as any` 우회 (rpc_type_workaround 패턴).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  const [uncoveredRes, roiRes] = await Promise.all([
    sb.rpc('jimscanner_seed_radar_uncovered', { p_days: 14, p_min_freq: 2, p_limit: 80 }),
    sb.rpc('jimscanner_seed_radar_roi', { p_days: 90 }),
  ])

  return {
    uncovered: (uncoveredRes.data ?? []) as UncoveredRow[],
    roi: (roiRes.data ?? []) as RoiRow[],
    uncoveredErr: uncoveredRes.error?.message as string | undefined,
    roiErr: roiRes.error?.message as string | undefined,
  }
}

function formatAge(iso: string | null): string {
  if (!iso) return '—'
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 60) return `${min}m 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h 전`
  return `${Math.floor(h / 24)}d 전`
}

export default async function SeedRadarPage() {
  const { uncovered, roi, uncoveredErr, roiErr } = await fetchData()

  const deadSeeds = roi.filter((r) => r.is_active && r.product_count === 0 && r.keyword_count === 0)
  const activeRoi = roi.filter((r) => r.is_active)
  const prunedRoi = roi.filter((r) => !r.is_active)

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">시드 사각지대 레이더</h1>
          <p className="mt-1 text-sm text-gray-500">
            깔때기 입구(seed) 커버리지 피드백 — 미커버 수요어 시드화 + 죽은 시드 가지치기
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {/* ── 1) 미커버 핫텀 큐 ───────────────────────── */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-gray-700">
          미커버 핫텀 — 커뮤니티/뉴스엔 뜨는데 어떤 활성 시드로도 안 잡히는 토큰
        </h2>
        <p className="mb-3 text-xs text-gray-500">
          market_raw(최근 14일) 빈출 토큰 ∖ (활성 seed 어휘 ∪ 이미 funnel 진입 키워드). 클릭 한 번에
          naver_search_trend 키워드그룹 시드로 승격 → 다음 수집부터 검색량 검증.
        </p>
        {uncoveredErr && (
          <p className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">
            RPC 오류: {uncoveredErr} — supabase/seed_radar.sql 적용 필요
          </p>
        )}
        <div className="divide-y divide-gray-100 rounded border border-gray-200">
          {uncovered.length === 0 && !uncoveredErr && (
            <p className="px-3 py-4 text-sm text-gray-400">사각지대 토큰 없음 (또는 데이터 부족).</p>
          )}
          {uncovered.map((u) => (
            <div key={u.token} className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-sm">
              <div className="col-span-2 font-mono font-semibold">{u.token}</div>
              <div className="col-span-1 text-right text-gray-600">×{u.frequency}</div>
              <div className="col-span-2 text-right text-xs text-gray-500">
                {u.source_count} 소스
              </div>
              <div className="col-span-3 truncate text-xs text-gray-400" title={u.sample_title ?? ''}>
                {u.sample_title ?? '—'}
              </div>
              <div className="col-span-2 text-right text-xs text-gray-400">
                {formatAge(u.last_seen)}
              </div>
              <div className="col-span-2 text-right">
                <PromoteButton token={u.token} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 2) seed ROI / 가지치기 ───────────────────── */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-gray-700">
          시드 ROI — 각 시드가 만들어낸 키워드·분류 상품·평균 점수
        </h2>
        <p className="mb-3 text-xs text-gray-500">
          seed → trends_keywords → alias → product → 최신 final_score 경로 집계(최근 90일). productivity 0 인
          시드는 가지치기(비활성) 추천.
        </p>
        {roiErr && (
          <p className="mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">
            RPC 오류: {roiErr} — supabase/seed_radar.sql 적용 필요
          </p>
        )}

        {deadSeeds.length > 0 && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            ⚠ 죽은 시드 {deadSeeds.length}개 (90일간 키워드·상품 0): {deadSeeds.map((d) => d.label).join(', ')}
          </div>
        )}

        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">시드</th>
                <th className="px-3 py-2 text-left">source / kind</th>
                <th className="px-3 py-2 text-right">키워드</th>
                <th className="px-3 py-2 text-right">상품</th>
                <th className="px-3 py-2 text-right">평균점수</th>
                <th className="px-3 py-2 text-right">최근 산출</th>
                <th className="px-3 py-2 text-right">액션</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {activeRoi.map((r) => {
                const dead = r.product_count === 0 && r.keyword_count === 0
                return (
                  <tr key={r.seed_id} className={dead ? 'bg-red-50/40' : undefined}>
                    <td className="px-3 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">
                      {r.source} · {r.kind}
                    </td>
                    <td className="px-3 py-2 text-right">{r.keyword_count}</td>
                    <td className="px-3 py-2 text-right font-semibold">{r.product_count}</td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {r.avg_final_score ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-gray-400">
                      {formatAge(r.last_keyword_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PruneButton seedId={r.seed_id} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {prunedRoi.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold text-gray-500">가지치기됨 (비활성)</h3>
            <div className="divide-y divide-gray-100 rounded border border-gray-200">
              {prunedRoi.map((r) => (
                <div key={r.seed_id} className="flex items-center justify-between px-3 py-2 text-sm text-gray-500">
                  <span>
                    {r.label}{' '}
                    <span className="font-mono text-xs text-gray-400">
                      ({r.source} · {r.kind})
                    </span>
                  </span>
                  <ReactivateButton seedId={r.seed_id} />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
