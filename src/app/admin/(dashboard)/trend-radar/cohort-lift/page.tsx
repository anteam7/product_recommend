import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LiftRow {
  product_id: string
  canonical_name: string
  category_top: string
  cohort_size: number
  final_score: number
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_mean: number
  final_sd: number
  final_z: number
  trend_z: number
  commerce_z: number
  alias_count: number
  last_seen_at: string
  computed_at: string
}

interface CohortStat {
  category_top: string
  cohort_size: number
  final_mean: number
  final_sd: number
  final_min: number
  final_q1: number
  final_median: number
  final_q3: number
  final_max: number
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

async function fetchData(minZ: number) {
  const sb = createAdminClient()
  const [{ data: lift }, { data: stats }] = await Promise.all([
    sb.rpc('jimscanner_cohort_lift_v1' as any, {
      min_z: minZ,
      min_cohort_size: 3,
      result_limit: 200,
    } as any),
    sb.rpc('jimscanner_cohort_stats_v1' as any),
  ])
  return {
    rows: ((lift ?? []) as unknown as LiftRow[]),
    stats: ((stats ?? []) as unknown as CohortStat[]),
  }
}

function fmt(n: number, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return Number(n).toFixed(digits)
}

function BoxPlot({ stat }: { stat: CohortStat }) {
  const range = Math.max(1, stat.final_max - stat.final_min)
  const pct = (v: number) => ((v - stat.final_min) / range) * 100
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold text-gray-700">
          {CATEGORY_LABEL[stat.category_top] ?? stat.category_top}
        </span>
        <span className="text-gray-500">
          n={stat.cohort_size} · μ={fmt(stat.final_mean, 1)} · σ={fmt(stat.final_sd, 1)}
        </span>
      </div>
      <div className="relative h-5 bg-gray-100 rounded">
        {/* whiskers min-max */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-px bg-gray-400"
          style={{ left: `${pct(stat.final_min)}%`, width: `${pct(stat.final_max) - pct(stat.final_min)}%` }}
        />
        {/* box q1-q3 */}
        <div
          className="absolute top-0 bottom-0 bg-blue-200 border border-blue-400 rounded-sm"
          style={{ left: `${pct(stat.final_q1)}%`, width: `${Math.max(0.5, pct(stat.final_q3) - pct(stat.final_q1))}%` }}
        />
        {/* median */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-blue-800"
          style={{ left: `${pct(stat.final_median)}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-gray-400 font-mono">
        <span>{fmt(stat.final_min, 0)}</span>
        <span>q1 {fmt(stat.final_q1, 0)}</span>
        <span>med {fmt(stat.final_median, 0)}</span>
        <span>q3 {fmt(stat.final_q3, 0)}</span>
        <span>{fmt(stat.final_max, 0)}</span>
      </div>
    </div>
  )
}

function ZBar({ z }: { z: number }) {
  const clamped = Math.max(-4, Math.min(4, z))
  const widthPct = Math.min(50, (Math.abs(clamped) / 4) * 50)
  const pos = clamped >= 0
  return (
    <div className="relative w-full h-3 bg-gray-50 rounded">
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-300" />
      <div
        className={`absolute top-0 bottom-0 ${pos ? 'bg-emerald-500' : 'bg-rose-500'} rounded`}
        style={{
          [pos ? 'left' : 'right']: '50%',
          width: `${widthPct}%`,
        } as React.CSSProperties}
      />
    </div>
  )
}

export default async function CohortLiftPage({
  searchParams,
}: {
  searchParams: Promise<{ z?: string }>
}) {
  const sp = await searchParams
  const minZ = Math.max(0, Math.min(5, Number(sp.z) || 2.0))
  const { rows, stats } = await fetchData(minZ)

  // group by category
  const byCat = new Map<string, LiftRow[]>()
  for (const r of rows) {
    if (!byCat.has(r.category_top)) byCat.set(r.category_top, [])
    byCat.get(r.category_top)!.push(r)
  }
  const cats = [...byCat.keys()].sort()

  const Z_OPTIONS = [1.0, 1.5, 2.0, 2.5, 3.0]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Cohort Lift — z-score outlier</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 baseline (mean/sd) 대비 final_score 가 얼마나 튀는가.
            절대 점수 정렬에서 묻혀 있던 조용한 카테고리의 진짜 outlier 를 노출.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드 (절대 점수 정렬)
        </Link>
      </header>

      {/* z threshold toggle */}
      <nav className="flex gap-2 items-center text-sm">
        <span className="text-gray-500">최소 z:</span>
        {Z_OPTIONS.map((z) => (
          <Link
            key={z}
            href={`/admin/trend-radar/cohort-lift?z=${z}`}
            className={`px-2 py-1 rounded border ${
              Math.abs(minZ - z) < 0.01
                ? 'bg-black text-white border-black font-semibold'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            ≥ {z.toFixed(1)}
          </Link>
        ))}
        <span className="text-xs text-gray-400 ml-2">
          (z=2.0 ≈ 상위 ~2.5% · z=3.0 ≈ 상위 ~0.13%)
        </span>
      </nav>

      {/* baseline 분포 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          카테고리 baseline 분포 (final_score)
        </h2>
        {stats.length === 0 ? (
          <div className="text-sm text-gray-500">분포 데이터 없음</div>
        ) : (
          <div className="grid md:grid-cols-3 gap-6">
            {stats.map((s) => (
              <BoxPlot key={s.category_top} stat={s} />
            ))}
          </div>
        )}
      </section>

      {/* outlier 핀 */}
      <section className="space-y-6">
        {cats.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">
              z ≥ {minZ.toFixed(1)} outlier 없음
            </p>
            <p className="text-sm mt-2">
              임계값을 낮추거나 다른 카테고리를 확인해 보세요.
              <br />
              baseline 분포가 평탄하면 z-score 가 잘 안 솟습니다 (cohort 누적 부족).
            </p>
          </div>
        ) : (
          cats.map((cat) => {
            const items = byCat.get(cat)!
            const label = CATEGORY_LABEL[cat] ?? cat
            return (
              <div key={cat} className="rounded border border-gray-200">
                <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">
                    {label}{' '}
                    <span className="text-xs font-normal text-gray-500 ml-1">
                      n={items[0].cohort_size} · outlier {items.length}건
                    </span>
                  </h3>
                  <span className="text-xs text-gray-500">
                    μ={fmt(items[0].final_mean, 1)} · σ={fmt(items[0].final_sd, 1)}
                  </span>
                </div>
                <div className="divide-y divide-gray-100">
                  <div className="grid grid-cols-12 text-xs text-gray-500 px-4 py-1">
                    <div className="col-span-4">상품명</div>
                    <div className="col-span-1 text-right">final</div>
                    <div className="col-span-1 text-right">trend</div>
                    <div className="col-span-1 text-right">commerce</div>
                    <div className="col-span-1 text-right">z(final)</div>
                    <div className="col-span-3">z bar</div>
                    <div className="col-span-1 text-right">aliases</div>
                  </div>
                  {items.map((r) => (
                    <Link
                      key={r.product_id}
                      href={`/admin/trend-radar/products/${r.product_id}`}
                      className="grid grid-cols-12 px-4 py-2 text-sm items-center hover:bg-gray-50"
                    >
                      <div className="col-span-4 truncate">
                        <span className="font-medium">{r.canonical_name}</span>
                      </div>
                      <div className="col-span-1 text-right font-mono font-bold">
                        {fmt(r.final_score, 0)}
                      </div>
                      <div className="col-span-1 text-right font-mono text-gray-600">
                        {fmt(r.trend_score, 0)}
                      </div>
                      <div className="col-span-1 text-right font-mono text-gray-600">
                        {fmt(r.commerce_score, 0)}
                      </div>
                      <div className="col-span-1 text-right font-mono font-bold text-emerald-700">
                        {fmt(r.final_z, 2)}σ
                      </div>
                      <div className="col-span-3 px-2">
                        <ZBar z={Number(r.final_z) || 0} />
                      </div>
                      <div className="col-span-1 text-right text-xs text-gray-500">
                        {r.alias_count}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </section>

      <footer className="text-xs text-gray-500 pt-2 border-t border-gray-100">
        z-score = (final_score − category μ) / category σ ·{' '}
        cohort size 3 미만 카테고리는 제외 (sd 신뢰도 부족) ·{' '}
        절대 점수 정렬은{' '}
        <Link href="/admin/trend-radar" className="underline">메인 보드</Link>{' '}
        에서.
      </footer>
    </div>
  )
}
