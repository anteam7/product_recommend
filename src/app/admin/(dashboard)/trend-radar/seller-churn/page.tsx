import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ChurnRow {
  category_top: string
  week_offset: number
  cohort_size: number
  surviving: number
  survival_rate: number | null
}

interface CategoryStat {
  category_top: string
  cohortSize: number
  survival90d: number | null
  curve: { week: number; rate: number | null }[]
  isTrap: boolean
}

async function fetchChurnData() {
  const sb = createAdminClient()
  // 신설 RPC — 타입 미생성 상태로 as any 캐스팅
  const { data, error } = await (sb as any).rpc('jimscanner_seller_churn_rpc', {
    weeks_window: 12,
  })
  if (error) {
    return { rows: [] as ChurnRow[], error: error.message }
  }
  return { rows: (data ?? []) as ChurnRow[], error: null }
}

async function fetchSnapshotMeta() {
  const sb = createAdminClient()
  const { count } = await (sb as any)
    .from('jimscanner_serp_seller_snapshots')
    .select('*', { count: 'exact', head: true })
  const { data: latest } = await (sb as any)
    .from('jimscanner_serp_seller_snapshots')
    .select('captured_at')
    .order('captured_at', { ascending: false })
    .limit(1)
  return {
    totalRows: count ?? 0,
    lastCapturedAt: (latest as any[])?.[0]?.captured_at ?? null,
  }
}

function aggregate(rows: ChurnRow[]): CategoryStat[] {
  const byCategory = new Map<string, ChurnRow[]>()
  for (const r of rows) {
    if (!byCategory.has(r.category_top)) byCategory.set(r.category_top, [])
    byCategory.get(r.category_top)!.push(r)
  }
  const out: CategoryStat[] = []
  for (const [cat, list] of byCategory) {
    list.sort((a, b) => a.week_offset - b.week_offset)
    // 90일 ≈ 12주차 (실제 코호트는 12주 전 → 현재까지 생존했는지)
    // RPC 정의상 week_offset 12 가 분석시점 (≈ 현재) 의 생존율
    const last = list.find((x) => x.week_offset === 12) ?? list[list.length - 1]
    const survival90d = last?.survival_rate != null ? Number(last.survival_rate) : null
    const cohortSize = last?.cohort_size ?? 0
    out.push({
      category_top: cat,
      cohortSize,
      survival90d,
      curve: list.map((x) => ({ week: x.week_offset, rate: x.survival_rate != null ? Number(x.survival_rate) : null })),
      // churn ≥ 60% → 생존율 ≤ 40% 면 함정 카테고리
      isTrap: survival90d != null && survival90d <= 40,
    })
  }
  return out.sort((a, b) => {
    // trap 먼저, 그다음 cohortSize 큰 순
    if (a.isTrap !== b.isTrap) return a.isTrap ? -1 : 1
    return b.cohortSize - a.cohortSize
  })
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

export default async function SellerChurnPage() {
  const [{ rows, error }, meta] = await Promise.all([fetchChurnData(), fetchSnapshotMeta()])
  const stats = aggregate(rows)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">셀러 Churn 생존곡선</h1>
          <p className="text-sm text-gray-500 mt-1">
            쿠팡 SERP 상위 셀러의 카테고리별 12주 잔존율. 생존율 ≤ 40% 카테고리는 진입 함정.
          </p>
        </div>
        <div className="text-xs text-gray-500 text-right">
          <div>스냅샷 누적: {meta.totalRows.toLocaleString()} row</div>
          <div>
            최근 수집:{' '}
            {meta.lastCapturedAt
              ? meta.lastCapturedAt.slice(0, 19).replace('T', ' ')
              : '— (cron 미실행)'}
          </div>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          RPC 호출 실패: {error}
          <div className="text-xs text-red-600 mt-1">
            마이그레이션 미적용 가능성: supabase/trends_v5_seller_churn.sql
          </div>
        </div>
      )}

      {/* KPI 카드 */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.length === 0 ? (
          <div className="md:col-span-3 rounded border border-dashed border-gray-300 p-8 text-center text-gray-500">
            <p className="text-base font-medium">아직 셀러 스냅샷이 충분하지 않습니다</p>
            <p className="text-sm mt-2">
              주 1회 KST 일요일 03:00 cron 누적 → 12주 후 첫 생존율 산출.
              <br />
              로컬 수동 실행:{' '}
              <code className="px-1 bg-gray-100 rounded">
                node --env-file=.env.local scripts/coupang-serp-snapshot.mjs
              </code>
            </p>
          </div>
        ) : (
          stats.map((s) => (
            <ChurnCard key={s.category_top} stat={s} />
          ))
        )}
      </section>

      {/* 생존곡선 표 (라인차트 간이 표현) */}
      {stats.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">카테고리 × 주차별 생존율 (%)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-right">코호트</th>
                  {Array.from({ length: 12 }, (_, i) => (
                    <th key={i} className="px-2 py-2 text-right font-mono">
                      w{i + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stats.map((s) => (
                  <tr key={s.category_top} className={s.isTrap ? 'bg-red-50' : ''}>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {CATEGORY_LABEL[s.category_top] ?? s.category_top}
                      </div>
                      <div className="text-[10px] text-gray-500">{s.category_top}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-600">
                      {s.cohortSize}
                    </td>
                    {Array.from({ length: 12 }, (_, i) => {
                      const cell = s.curve.find((c) => c.week === i + 1)
                      const rate = cell?.rate
                      return (
                        <td key={i} className="px-2 py-2 text-right font-mono">
                          {rate == null ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span
                              className={
                                rate <= 40
                                  ? 'text-red-700 font-bold'
                                  : rate <= 60
                                    ? 'text-amber-700'
                                    : 'text-gray-700'
                              }
                            >
                              {rate.toFixed(0)}
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            wN = 코호트 진입 후 N주차 잔존율. 빨강 = ≤ 40% (진입 함정), 주황 = ≤ 60%.
          </p>
        </section>
      )}

      <section className="text-[11px] text-gray-500 border-t border-gray-100 pt-3">
        데이터 출처: jimscanner_serp_seller_snapshots · RPC: jimscanner_seller_churn_rpc(12) · 수집:
        scripts/coupang-serp-snapshot.mjs (주 1회 KST 일요일 03:00)
      </section>
    </div>
  )
}

function ChurnCard({ stat }: { stat: CategoryStat }) {
  const trap = stat.isTrap
  const noData = stat.survival90d == null
  return (
    <div
      className={`rounded border p-4 ${
        trap ? 'border-red-300 bg-red-50' : 'border-gray-200'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">
          {CATEGORY_LABEL[stat.category_top] ?? stat.category_top}
        </div>
        {trap && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-red-200 text-red-800 font-bold">
            ⚠ 진입 함정
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className={`text-3xl font-bold ${trap ? 'text-red-700' : 'text-gray-900'}`}>
          {noData ? '—' : `${stat.survival90d!.toFixed(1)}%`}
        </div>
        <div className="text-xs text-gray-500">90일 생존율</div>
      </div>
      <div className="text-[11px] text-gray-500 mt-2">
        코호트 크기 (12주 전 셀러): <span className="font-mono">{stat.cohortSize}</span>
      </div>
    </div>
  )
}
