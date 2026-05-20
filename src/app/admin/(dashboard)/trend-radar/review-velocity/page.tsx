import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

interface VelocityRow {
  category_top: string
  day_bucket: number
  reviews_p50: number
  reviews_p90: number
  samples_n: number
  computed_at: string
}

interface ProductScoreRow {
  id: string
  canonical_name: string
  category_top: string
  final_score: number
  commerce_score: number
  first_seen_at: string
}

async function fetchVelocity(category: Category) {
  const sb = createAdminClient()

  // 최신 스냅샷 — 가장 최근 computed_at 기준 모든 카테고리/버킷
  const query = sb
    .from('jimscanner_trends_review_velocity' as never)
    .select('category_top, day_bucket, reviews_p50, reviews_p90, samples_n, computed_at')
    .order('computed_at', { ascending: false })
    .limit(500)

  const { data } = await query
  const rows = ((data ?? []) as unknown) as VelocityRow[]
  if (rows.length === 0) return { rows: [], latestAt: null }

  // 가장 최근 computed_at 만 keep
  const latestAt = rows[0].computed_at
  const latest = rows.filter((r) => r.computed_at === latestAt)
  const filtered = category === 'all' ? latest : latest.filter((r) => r.category_top === category)

  return { rows: filtered, latestAt }
}

async function fetchCandidates(category: Category) {
  const sb = createAdminClient()
  // 최근 60일 안에 처음 등장한 (= 신규 진입 후보) product 중 final_score 상위
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const q = sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, first_seen_at')
    .gte('first_seen_at', since)
    .order('first_seen_at', { ascending: false })
    .limit(100)
  if (category !== 'all') q.eq('category_top', category)
  const { data: products } = await q
  const ids = (products ?? []).map((p: any) => p.id)
  if (ids.length === 0) return []

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, commerce_score, computed_at')
    .in('product_id', ids)
    .order('computed_at', { ascending: false })
    .limit(1000)
  const latestScore = new Map<string, { final: number; commerce: number }>()
  for (const s of (scores ?? []) as any[]) {
    if (latestScore.has(s.product_id)) continue
    latestScore.set(s.product_id, { final: s.final_score, commerce: s.commerce_score })
  }

  return (products ?? [])
    .map((p: any) => ({
      ...p,
      final_score: latestScore.get(p.id)?.final ?? 0,
      commerce_score: latestScore.get(p.id)?.commerce ?? 0,
    }))
    .filter((p: any) => p.final_score > 0)
    .sort((a: any, b: any) => b.final_score - a.final_score)
    .slice(0, 20) as ProductScoreRow[]
}

export default async function ReviewVelocityPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const [{ rows, latestAt }, candidates] = await Promise.all([
    fetchVelocity(category),
    fetchCandidates(category),
  ])

  // 카테고리별로 묶기
  const byCat = new Map<string, VelocityRow[]>()
  for (const r of rows) {
    if (!byCat.has(r.category_top)) byCat.set(r.category_top, [])
    byCat.get(r.category_top)!.push(r)
  }
  for (const arr of byCat.values()) arr.sort((a, b) => a.day_bucket - b.day_bucket)

  // 최대값 — 시각화 스케일
  const maxP90 = Math.max(1, ...rows.map((r) => r.reviews_p90))

  // 신규 핀별 30/60/90일차 요구 리뷰 (SLA) — p90 기준
  function slaFor(cat: string, day: number) {
    const arr = byCat.get(cat) ?? byCat.get('all') ?? []
    const exact = arr.find((r) => r.day_bucket === day)
    if (exact) return exact.reviews_p90
    return 0
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Review Velocity 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 SERP 상위 셀러의 리뷰 누적 곡선 → 신규 진입 핀의 주차별 리뷰 SLA
          </p>
          {latestAt && (
            <p className="text-xs text-gray-400 mt-1 font-mono">
              최신 스냅샷: {latestAt.slice(0, 19).replace('T', ' ')}
            </p>
          )}
        </div>
      </header>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/review-velocity?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              category === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <section>
          <h2 className="text-sm font-semibold mb-3">리뷰 누적 분포 (p50 / p90)</h2>
          <div className="space-y-4">
            {[...byCat.entries()].map(([cat, arr]) => (
              <div key={cat} className="rounded border border-gray-200 p-4">
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="font-semibold">
                    {CATEGORY_LABEL[cat as Category] ?? cat}
                  </h3>
                  <span className="text-xs text-gray-500">
                    표본 n = {arr[0]?.samples_n ?? 0}
                  </span>
                </div>
                <div className="space-y-2">
                  <div className="grid grid-cols-12 text-xs text-gray-500 px-1">
                    <div className="col-span-2">day</div>
                    <div className="col-span-1 text-right">p50</div>
                    <div className="col-span-1 text-right">p90</div>
                    <div className="col-span-8">분포 (bar = p90)</div>
                  </div>
                  {arr.map((r) => {
                    const widthP50 = (r.reviews_p50 / maxP90) * 100
                    const widthP90 = (r.reviews_p90 / maxP90) * 100
                    return (
                      <div key={r.day_bucket} className="grid grid-cols-12 items-center text-xs">
                        <div className="col-span-2 font-mono text-gray-600">D+{r.day_bucket}</div>
                        <div className="col-span-1 text-right font-mono">
                          {r.reviews_p50.toFixed(0)}
                        </div>
                        <div className="col-span-1 text-right font-mono font-bold">
                          {r.reviews_p90.toFixed(0)}
                        </div>
                        <div className="col-span-8 relative h-4 bg-gray-100 rounded">
                          <div
                            className="absolute top-0 left-0 h-4 bg-blue-200 rounded"
                            style={{ width: `${widthP90}%` }}
                          />
                          <div
                            className="absolute top-0 left-0 h-4 bg-blue-500 rounded"
                            style={{ width: `${widthP50}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 신규 핀별 30/60/90 SLA 타임라인 */}
      <section>
        <h2 className="text-sm font-semibold mb-3">
          신규 진입 핀 — 30/60/90일차 필요 리뷰 수 (p90)
        </h2>
        {candidates.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            최근 60일 안에 등록된 신규 핀이 없습니다.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">상품명</th>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-right">final</th>
                  <th className="px-3 py-2 text-right">D+30 SLA</th>
                  <th className="px-3 py-2 text-right">D+60 SLA</th>
                  <th className="px-3 py-2 text-right">D+90 SLA</th>
                  <th className="px-3 py-2 text-right">first_seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {candidates.map((p) => {
                  const sla30 = slaFor(p.category_top, 30)
                  const sla60 = slaFor(p.category_top, 60)
                  const sla90 = slaFor(p.category_top, 90)
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/trend-radar/products/${p.id}`}
                          className="hover:underline"
                        >
                          {p.canonical_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{p.category_top}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">
                        {p.final_score}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{Math.round(sla30)}</td>
                      <td className="px-3 py-2 text-right font-mono">{Math.round(sla60)}</td>
                      <td className="px-3 py-2 text-right font-mono">{Math.round(sla90)}</td>
                      <td className="px-3 py-2 text-right text-xs text-gray-400 font-mono">
                        {p.first_seen_at?.slice(0, 10)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">
          ※ SLA 값은 같은 카테고리 SERP 상위 셀러 분포의 90 퍼센타일. 핀이 광고예산·UGC캠페인으로
          이 곡선 위로 올라가지 못하면 페이지1 진입 가능성이 급락한다.
        </p>
      </section>

      <section className="text-xs text-gray-500 pt-4 border-t border-gray-200">
        <p>
          데이터 출처: <code className="bg-gray-100 px-1 rounded">jimscanner_trends_review_velocity</code>
          {' · '}
          cron: <code className="bg-gray-100 px-1 rounded">scripts/sample-review-curves.mjs</code>
        </p>
      </section>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 리뷰 누적 분포 데이터가 없습니다</p>
      <p className="text-sm mt-2">
        WSL/로컬에서 cron 을 한 번 돌려 분포를 적재하세요:
        <br />
        <code className="ml-1 px-2 py-1 bg-gray-100 rounded mt-2 inline-block">
          node --env-file=.env.local scripts/sample-review-curves.mjs
        </code>
      </p>
    </div>
  )
}
