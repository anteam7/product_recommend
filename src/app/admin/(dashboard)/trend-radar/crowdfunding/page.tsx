import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ProjectRow {
  id: string
  source: string
  source_project_id: string
  title: string
  maker: string | null
  category: string | null
  category_top: string | null
  funded_amount_krw: number
  goal_amount_krw: number | null
  achievement_rate: number | null
  supporter_count: number | null
  ended_at: string
  project_url: string | null
  is_verified: boolean
  verified_reason: string | null
}

interface LiftRow {
  category_top: string
  lag_bucket: string
  n_projects: number
  avg_lift: number | null
  p50_lift: number | null
}

interface ImminentRow {
  id: string
  source: string
  title: string
  category_top: string | null
  funded_amount_krw: number
  achievement_rate: number | null
  supporter_count: number | null
  ended_at: string
  project_url: string | null
  days_to_p50_default: number
  p50_eta: string
  days_since_end: number
}

interface RecommendRow {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  final_score: number
}

function formatKrw(n: number | null | undefined) {
  if (n === null || n === undefined) return '-'
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(1)}억`
  if (n >= 10000) return `${(n / 10000).toFixed(0)}만`
  return n.toLocaleString()
}

async function fetchVerifiedProjects(): Promise<ProjectRow[]> {
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_crowdfunding_projects')
    .select(
      'id, source, source_project_id, title, maker, category, category_top, funded_amount_krw, goal_amount_krw, achievement_rate, supporter_count, ended_at, project_url, is_verified, verified_reason',
    )
    .eq('is_verified', true)
    .order('ended_at', { ascending: false })
    .limit(50)
  return (data ?? []) as ProjectRow[]
}

async function fetchLagLift(): Promise<LiftRow[]> {
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_crowdfunding_lag_lift')
    .select('category_top, lag_bucket, n_projects, avg_lift, p50_lift')
  return (data ?? []) as LiftRow[]
}

async function fetchImminentQueue(): Promise<ImminentRow[]> {
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_crowdfunding_imminent_queue')
    .select(
      'id, source, title, category_top, funded_amount_krw, achievement_rate, supporter_count, ended_at, project_url, days_to_p50_default, p50_eta, days_since_end',
    )
    .limit(40)
  return (data ?? []) as ImminentRow[]
}

async function fetchGgsanCandidates(): Promise<Map<string, RecommendRow[]>> {
  const sb = createAdminClient()
  try {
    const { data } = await (sb as any).rpc('jimscanner_ggsan_recommend', {
      days_window: 60,
      min_sim: 0.2,
      min_score: 0.4,
      result_limit: 100,
    })
    const rows = (data ?? []) as Array<RecommendRow & { cate_label?: string | null }>
    const byCat = new Map<string, RecommendRow[]>()
    for (const r of rows) {
      const cat = (r.cate_label ?? 'misc').toString()
      let arr = byCat.get(cat)
      if (!arr) {
        arr = []
        byCat.set(cat, arr)
      }
      arr.push(r)
    }
    return byCat
  } catch (err) {
    console.warn('ggsan_recommend RPC failed', err)
    return new Map()
  }
}

function lagBadge(row: LiftRow) {
  const lift = row.p50_lift ?? row.avg_lift
  if (lift == null) return <span className="text-gray-400">-</span>
  const tone =
    lift >= 1.5
      ? 'text-red-700 font-semibold'
      : lift >= 1.1
        ? 'text-amber-700'
        : 'text-gray-600'
  return <span className={`font-mono ${tone}`}>{lift.toFixed(2)}x</span>
}

export default async function CrowdfundingBoardPage() {
  const [projects, liftRows, queue, ggsanByCat] = await Promise.all([
    fetchVerifiedProjects(),
    fetchLagLift(),
    fetchImminentQueue(),
    fetchGgsanCandidates(),
  ])

  const categories = Array.from(
    new Set(liftRows.map((r) => r.category_top).filter(Boolean)),
  ).sort()
  const liftByCatBucket = new Map<string, LiftRow>()
  for (const r of liftRows) {
    liftByCatBucket.set(`${r.category_top}::${r.lag_bucket}`, r)
  }

  const totalVerified = projects.length
  const totalImminent = queue.length
  const last30dVerified = projects.filter(
    (p) => Date.now() - new Date(p.ended_at).getTime() < 30 * 86400_000,
  ).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">와디즈·텀블벅 펀딩 → 리테일 선점 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            펀딩액 1억+ / 달성률 1000%+ 만 검증 통과 · 카테고리별 D+30/60/90 검색
            lift 자동 학습 · ggsan 대체 SKU 매칭
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="검증 통과 (최근 50)" value={totalVerified} hint="1억+ or 1000%+" />
        <KpiCard label="최근 30일 종료" value={last30dVerified} hint="펀딩 종료 기준" />
        <KpiCard
          label="리테일 진입 임박"
          value={totalImminent}
          hint="lag p50 ±21일"
        />
        <KpiCard
          label="학습 카테고리"
          value={categories.length}
          hint="lift 회귀 입력"
        />
      </section>

      {/* 카테고리별 lag distribution */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          카테고리별 retail lag distribution{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            (펀딩 종료 후 D+30/60/90 naver_search_trend lift · p50)
          </span>
        </h2>
        {categories.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 학습 데이터 없음. 펀딩 종료 후 30일+ 누적 필요.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-200">
                  <th className="text-left py-2 px-2">카테고리</th>
                  <th className="text-right py-2 px-2">D+30 lift</th>
                  <th className="text-right py-2 px-2">D+60 lift</th>
                  <th className="text-right py-2 px-2">D+90 lift</th>
                  <th className="text-right py-2 px-2">n</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => {
                  const d30 = liftByCatBucket.get(`${cat}::d30`)
                  const d60 = liftByCatBucket.get(`${cat}::d60`)
                  const d90 = liftByCatBucket.get(`${cat}::d90`)
                  const n = Math.max(
                    d30?.n_projects ?? 0,
                    d60?.n_projects ?? 0,
                    d90?.n_projects ?? 0,
                  )
                  return (
                    <tr key={cat} className="border-b border-gray-100">
                      <td className="py-2 px-2 font-medium">{cat}</td>
                      <td className="py-2 px-2 text-right">
                        {d30 ? lagBadge(d30) : '-'}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {d60 ? lagBadge(d60) : '-'}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {d90 ? lagBadge(d90) : '-'}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-gray-500">
                        {n}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 리테일 진입 임박 큐 */}
      <section className="rounded border border-red-200 bg-red-50/40 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          🔥 리테일 진입 임박 (lag p50 도달 ±21일)
        </h2>
        {queue.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 임박 프로젝트 없음. 펀딩 종료 후 카테고리 p50 도달 시점에 노출.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
              <div className="col-span-5">프로젝트</div>
              <div className="col-span-2">카테고리</div>
              <div className="col-span-1 text-right">펀딩</div>
              <div className="col-span-1 text-right">달성</div>
              <div className="col-span-2 text-right">종료</div>
              <div className="col-span-1 text-right">p50 ETA</div>
            </div>
            {queue.slice(0, 20).map((q) => {
              const etaDays =
                Math.round(
                  (new Date(q.p50_eta).getTime() - Date.now()) / 86400_000,
                )
              return (
                <a
                  key={q.id}
                  href={q.project_url ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="grid grid-cols-12 px-2 py-2 rounded bg-white hover:bg-amber-50 transition-colors text-sm"
                >
                  <div className="col-span-5">
                    <div className="font-medium truncate">{q.title}</div>
                    <div className="text-xs text-gray-500">
                      {q.source} · 서포터 {q.supporter_count ?? 0}
                    </div>
                  </div>
                  <div className="col-span-2 text-xs text-gray-600">
                    {q.category_top ?? '-'}
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold">
                    {formatKrw(q.funded_amount_krw)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {q.achievement_rate ? `${Math.round(q.achievement_rate)}%` : '-'}
                  </div>
                  <div className="col-span-2 text-right text-xs text-gray-500">
                    {q.ended_at.slice(0, 10)} (D+{q.days_since_end})
                  </div>
                  <div className="col-span-1 text-right text-xs">
                    <span
                      className={
                        Math.abs(etaDays) <= 7
                          ? 'text-red-700 font-semibold'
                          : 'text-gray-600'
                      }
                    >
                      {etaDays >= 0 ? `+${etaDays}d` : `${etaDays}d`}
                    </span>
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </section>

      {/* 검증 통과 프로젝트 리스트 + ggsan 대체 SKU 매칭 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          검증 통과 프로젝트 (펀딩액 1억+ / 달성률 1000%+){' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            카테고리별 ggsan 도매 대체 SKU 매칭
          </span>
        </h2>
        {projects.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 검증 통과 프로젝트 없음.{' '}
            <code className="text-xs">scripts/wadiz-tumblbug-fetcher.mjs</code>{' '}
            실행 후 KST 03:30 cron 누적 대기.
          </div>
        ) : (
          <div className="space-y-3">
            {projects.slice(0, 20).map((p) => {
              const lookup =
                ggsanByCat.get(p.category ?? '') ??
                ggsanByCat.get(p.category_top ?? '') ??
                []
              const candidates = lookup.slice(0, 3)
              return (
                <div
                  key={p.id}
                  className="border border-gray-200 rounded p-3 bg-white"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <a
                        href={p.project_url ?? '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium hover:underline truncate block"
                      >
                        {p.title}
                      </a>
                      <div className="text-xs text-gray-500 mt-1">
                        {p.source} · {p.category ?? '-'} ·{' '}
                        {p.category_top && (
                          <span className="text-gray-400">{p.category_top}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-bold">
                        {formatKrw(p.funded_amount_krw)}{' '}
                        <span className="text-gray-500 font-normal text-xs">
                          ({p.achievement_rate ? Math.round(p.achievement_rate) : 0}
                          %)
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {p.ended_at.slice(0, 10)} · {p.verified_reason}
                      </div>
                    </div>
                  </div>
                  {candidates.length > 0 ? (
                    <div className="mt-2 pl-3 border-l-2 border-gray-200">
                      <div className="text-xs text-gray-500 mb-1">
                        ggsan 도매 대체 후보
                      </div>
                      <div className="space-y-1">
                        {candidates.map((c) => (
                          <a
                            key={c.goods_no}
                            href={c.detail_url ?? '#'}
                            target="_blank"
                            rel="noreferrer"
                            className="block text-sm text-gray-700 hover:text-black hover:underline truncate"
                          >
                            <span className="font-mono text-xs text-gray-400 mr-2">
                              {c.final_score.toFixed(2)}
                            </span>
                            {c.title}
                            {c.price_krw && (
                              <span className="text-xs text-gray-500 ml-2">
                                {c.price_krw.toLocaleString()}원
                              </span>
                            )}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-gray-400">
                      같은 카테고리 ggsan 후보 없음
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        수집기: <code>scripts/wadiz-tumblbug-fetcher.mjs</code> · 표:{' '}
        <code>jimscanner_crowdfunding_projects</code> · view:{' '}
        <code>jimscanner_crowdfunding_lag_lift</code>,{' '}
        <code>jimscanner_crowdfunding_imminent_queue</code>
      </footer>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  return (
    <div className="rounded border border-gray-200 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  )
}
