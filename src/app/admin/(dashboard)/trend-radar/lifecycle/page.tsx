import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import LifecycleBoard from './LifecycleBoard'

export const dynamic = 'force-dynamic'

interface CurveRow {
  week_t: number
  at_risk: number
  events: number
  cohort_size: number
}

interface ExitRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  current_score: number
  prev_score: number | null
  score_delta: number
  weeks_since_first: number
  last_score_at: string
  status: 'recently_broken' | 'd7_warning' | 'watch'
}

interface ActiveSku {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  current_score: number
  weeks_since_first: number
}

async function fetchData(params: { category: string; threshold: number }) {
  const sb = createAdminClient()
  const categoryArg = params.category === 'all' ? null : params.category

  // RPC: KM curve
  // 타입 미반영 — supabase/trends_v4_lifecycle_cohort.sql 적용 후 `npm run gen:types` 시 캐스팅 제거
  const curveRes = await sb.rpc('jimscanner_lifecycle_curve' as never, {
    p_category_top: categoryArg,
    p_category_mid: null,
    p_threshold: params.threshold,
  } as never)

  // RPC: exit queue
  const exitRes = await sb.rpc('jimscanner_lifecycle_exit_queue' as never, {
    p_category_top: categoryArg,
    p_threshold: params.threshold,
    p_band: 10,
    p_limit: 50,
  } as never)

  // Active SKUs (현재 임계치 이상)
  const { data: activeRaw } = await sb
    .from('jimscanner_trends_lifecycle_cohort' as never)
    .select('product_id, canonical_name, category_top, category_mid, current_final_score, age_weeks')
    .gte('current_final_score', params.threshold)
    .order('current_final_score', { ascending: false })
    .limit(300)

  // Distinct categories
  const { data: cats } = await sb
    .from('jimscanner_trends_products')
    .select('category_top')
    .limit(1000)

  const catSet = new Set<string>()
  for (const r of (cats ?? []) as Array<{ category_top: string }>) {
    if (r.category_top) catSet.add(r.category_top)
  }

  const active: ActiveSku[] = ((activeRaw ?? []) as any[])
    .filter((r) => (categoryArg ? r.category_top === categoryArg : true))
    .map((r) => ({
      product_id: r.product_id,
      canonical_name: r.canonical_name,
      category_top: r.category_top,
      category_mid: r.category_mid,
      current_score: Number(r.current_final_score ?? 0),
      weeks_since_first: Number(r.age_weeks ?? 0),
    }))

  return {
    curve: ((curveRes.data ?? []) as CurveRow[]).map((r) => ({
      week_t: Number(r.week_t),
      at_risk: Number(r.at_risk),
      events: Number(r.events),
      cohort_size: Number(r.cohort_size),
    })),
    exitQueue: ((exitRes.data ?? []) as any[]).map(
      (r): ExitRow => ({
        product_id: r.product_id,
        canonical_name: r.canonical_name,
        category_top: r.category_top,
        category_mid: r.category_mid,
        current_score: Number(r.current_score),
        prev_score: r.prev_score == null ? null : Number(r.prev_score),
        score_delta: Number(r.score_delta),
        weeks_since_first: Number(r.weeks_since_first),
        last_score_at: r.last_score_at,
        status: r.status,
      }),
    ),
    active,
    categories: ['all', ...Array.from(catSet).sort()],
    curveError: curveRes.error?.message ?? null,
    exitError: exitRes.error?.message ?? null,
  }
}

export default async function LifecyclePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; threshold?: string }>
}) {
  const sp = await searchParams
  const category = sp.category ?? 'all'
  const threshold = Math.max(0, Math.min(100, Number(sp.threshold ?? 50)))

  const { curve, exitQueue, active, categories, curveError, exitError } = await fetchData({
    category,
    threshold,
  })

  const rpcMissing = !!(curveError && /function .* does not exist/i.test(curveError)) ||
    !!(exitError && /function .* does not exist/i.test(exitError))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Lifecycle 코호트 — KM Exit Timing</h1>
          <p className="text-sm text-gray-500 mt-1">
            first_seen_at 주차로 코호트 묶음 → Kaplan-Meier 생존곡선 S(t) = P(final_score ≥ {threshold} | 첫등장 후 t주).
            우측은 활성 SKU 들을 자신의 cohort 곡선 위에 오버레이.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 폼 */}
      <form className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-3 bg-gray-50">
        <div>
          <label className="block text-xs text-gray-500 mb-1">category_top</label>
          <select
            name="category"
            defaultValue={category}
            className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">threshold (final_score)</label>
          <input
            type="number"
            name="threshold"
            min={0}
            max={100}
            defaultValue={threshold}
            className="border border-gray-300 rounded px-2 py-1 text-sm w-24 bg-white"
          />
        </div>
        <button
          type="submit"
          className="rounded bg-black text-white px-3 py-1.5 text-sm hover:bg-gray-800"
        >
          적용
        </button>
        <div className="text-xs text-gray-500 ml-2">
          cohort_size: <b>{curve[0]?.cohort_size ?? 0}</b> SKU
        </div>
      </form>

      {rpcMissing && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          RPC <code>jimscanner_lifecycle_curve</code> / <code>jimscanner_lifecycle_exit_queue</code> 가 DB에 없습니다.
          <code className="mx-1">supabase/trends_v4_lifecycle_cohort.sql</code>
          적용이 필요합니다.
        </div>
      )}

      {/* KM 곡선 + 오버레이 */}
      {curve.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          코호트 데이터 없음. trends_scores 시계열이 충분히 쌓인 뒤 다시 방문.
        </div>
      ) : (
        <LifecycleBoard curve={curve} active={active} threshold={threshold} category={category} />
      )}

      {/* 출구 큐 */}
      <section className="rounded border border-gray-200">
        <header className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">
            출구 큐 — 임계치 하향돌파 D-7 / 최근 이탈
          </h2>
          <span className="text-xs text-gray-500">
            band ±10, 직전 점수 대비 하락 SKU 우선
          </span>
        </header>
        {exitQueue.length === 0 ? (
          <div className="p-6 text-sm text-gray-400 text-center">
            출구 큐 비어있음 — 모든 활성 SKU 가 임계치보다 충분히 위에 있거나 상승 중.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {exitQueue.map((e) => (
              <Link
                key={e.product_id}
                href={`/admin/trend-radar/products/${e.product_id}`}
                className="grid grid-cols-12 items-center px-4 py-2 text-sm hover:bg-gray-50"
              >
                <div className="col-span-5">
                  <div className="font-medium">{e.canonical_name}</div>
                  <div className="text-xs text-gray-500">
                    {e.category_top}
                    {e.category_mid ? ` / ${e.category_mid}` : ''}
                  </div>
                </div>
                <div className="col-span-2 text-xs">
                  <span
                    className={
                      e.status === 'recently_broken'
                        ? 'inline-block rounded bg-red-100 text-red-700 px-2 py-0.5'
                        : e.status === 'd7_warning'
                          ? 'inline-block rounded bg-amber-100 text-amber-700 px-2 py-0.5'
                          : 'inline-block rounded bg-gray-100 text-gray-600 px-2 py-0.5'
                    }
                  >
                    {e.status === 'recently_broken'
                      ? '🔴 이탈'
                      : e.status === 'd7_warning'
                        ? '🟠 D-7'
                        : '⚪ 관찰'}
                  </span>
                </div>
                <div className="col-span-2 text-xs font-mono text-gray-700">
                  {e.current_score.toFixed(1)}
                  <span className={e.score_delta < 0 ? 'text-red-600 ml-1' : 'text-emerald-600 ml-1'}>
                    {e.score_delta >= 0 ? '+' : ''}
                    {e.score_delta.toFixed(1)}
                  </span>
                </div>
                <div className="col-span-2 text-xs text-gray-500 font-mono">
                  {e.weeks_since_first.toFixed(1)}주차
                </div>
                <div className="col-span-1 text-right text-xs text-gray-400 font-mono">
                  {e.last_score_at?.slice(5, 16)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-gray-400">
        * KM 추정치 = Π(1 - d_t / n_t). cohort_size 가 30 미만이면 추정 변동이 큽니다.
        median survival 은 S(t) ≤ 0.5 첫 도달 t. 잔여수명 추정 = median − 현재 주차 (음수면 이미 평균 이상 생존).
      </p>
    </div>
  )
}
