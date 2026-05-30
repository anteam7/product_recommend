import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LifecycleRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  brand: string | null
  current_stage: number
  stage_label: string
  distinct_sources: number
  stage_entered_at: string | null
  days_in_stage: number | null
  new_7d: number
  new_prev_7d: number
  arrival_accel: number
  reached_shopping_best: boolean
  is_preemption_candidate: boolean
}

const STAGES = [
  { n: 1, label: '① 커뮤니티', hint: '82cook · natepan · ppomppu · dcinside', color: 'bg-emerald-500' },
  { n: 2, label: '② 뉴스', hint: 'daum_news · naver_news', color: 'bg-sky-500' },
  { n: 3, label: '③ 검색수요', hint: 'naver_search_trend · naver_shopping_insight', color: 'bg-violet-500' },
  { n: 4, label: '④ 쇼핑베스트', hint: 'naver_shopping_hot · musinsa_best · aliex_best · domeggook', color: 'bg-rose-500' },
] as const

async function fetchData() {
  const sb = createAdminClient()
  // 뷰는 마이그레이션(supabase/trends_v4_lifecycle.sql) 적용 후 존재 — 타입 미생성이라 as any.
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_lifecycle')
    .select('*')
    .order('arrival_accel', { ascending: false })
    .limit(3000)

  if (error) {
    console.error('lifecycle view error', error)
    return { rows: [] as LifecycleRow[], missing: true }
  }
  return { rows: (data ?? []) as LifecycleRow[], missing: false }
}

function fmtDays(d: number | null) {
  if (d === null || d === undefined) return '—'
  if (d < 1) return '<1일'
  return `${Math.round(d)}일`
}

export default async function LifecyclePage() {
  const { rows, missing } = await fetchData()

  const stageCounts = STAGES.map((s) => ({
    ...s,
    count: rows.filter((r) => r.current_stage === s.n).length,
  }))
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count))

  const preemption = rows
    .filter((r) => r.is_preemption_candidate)
    .sort((a, b) => b.arrival_accel - a.arrival_accel || (a.days_in_stage ?? 0) - (b.days_in_stage ?? 0))

  const redOcean = rows.filter((r) => r.reached_shopping_best).length

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">트렌드 확산 사다리</h1>
          <p className="text-sm text-gray-500 mt-1">
            소스 <b>도달 순서</b>로 단계화 — 커뮤니티·뉴스 상류 단계의 <b>선점 가능</b> 상품을 끌어올리는 렌즈.
            <br />
            기회 점수(consensus)와 <b>반대 방향</b>: 쇼핑베스트(④)는 레드오션, ①~②는 선점 여지.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline whitespace-nowrap">
          ← 대시보드
        </Link>
      </header>

      {missing ? (
        <div className="rounded border border-dashed border-amber-400 bg-amber-50 p-6 text-sm text-amber-800">
          <p className="font-semibold">뷰가 아직 적용되지 않았습니다.</p>
          <p className="mt-1">
            <code>supabase/trends_v4_lifecycle.sql</code> 마이그레이션을 DB 에 적용한 뒤 다시 방문하세요.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 분류된 상품이 없습니다. alias 매핑 + 키워드 수집 누적 후 다시 방문.
        </div>
      ) : (
        <>
          {/* 단계별 퍼널 */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">단계별 상품 퍼널</h2>
              <span className="text-xs text-gray-500">
                총 {rows.length}개 · 레드오션(④ 도달) {redOcean}개
              </span>
            </div>
            <div className="space-y-2">
              {stageCounts.map((s) => {
                const pct = Math.round((s.count / maxCount) * 100)
                return (
                  <div key={s.n} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 text-sm font-medium text-gray-800">{s.label}</div>
                    <div className="flex-1 bg-gray-100 rounded h-7 overflow-hidden">
                      <div
                        className={`${s.color} h-full rounded flex items-center justify-end pr-2 text-xs font-semibold text-white transition-all`}
                        style={{ width: `${Math.max(pct, s.count > 0 ? 6 : 0)}%` }}
                      >
                        {s.count > 0 ? s.count : ''}
                      </div>
                    </div>
                    <div className="w-12 shrink-0 text-right text-sm tabular-nums text-gray-600">{s.count}</div>
                  </div>
                )
              })}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-1">
              {STAGES.map((s) => (
                <div key={s.n} className="text-[11px] text-gray-400 leading-tight">
                  <span className="font-medium text-gray-500">{s.label}</span>
                  <br />
                  {s.hint}
                </div>
              ))}
            </div>
          </section>

          {/* 선점 후보 */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">
                🎯 선점 후보 <span className="text-sm font-normal text-gray-500">({preemption.length})</span>
              </h2>
              <span className="text-xs text-gray-500">①~② 단계 · 가속 중 · 쇼핑베스트 미도달</span>
            </div>

            {preemption.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                현재 선점 후보 없음. 상류 단계에서 신규 소스가 늘기 시작하는 상품이 여기 올라옵니다.
              </div>
            ) : (
              <div className="overflow-x-auto rounded border border-gray-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">상품</th>
                      <th className="text-left font-semibold px-3 py-2">단계</th>
                      <th className="text-right font-semibold px-3 py-2">체류일</th>
                      <th className="text-right font-semibold px-3 py-2">소스수</th>
                      <th className="text-right font-semibold px-3 py-2" title="최근7일 신규 - 직전7일 신규">
                        가속도
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preemption.map((r) => (
                      <tr key={r.product_id} className="hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-900">{r.canonical_name}</div>
                          <div className="text-xs text-gray-400">
                            {[r.brand, r.category_top].filter(Boolean).join(' · ') || '—'}
                          </div>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                              r.current_stage === 1
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-sky-100 text-sky-700'
                            }`}
                          >
                            {r.stage_label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                          {fmtDays(r.days_in_stage)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">{r.distinct_sources}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="font-semibold text-emerald-600">
                            +{r.arrival_accel}
                          </span>
                          <span className="text-xs text-gray-400 ml-1">
                            ({r.new_7d}/{r.new_prev_7d})
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-gray-400">
              가속도 = 최근 7일 신규 소스 수 − 직전 7일 신규 소스 수 (괄호: 최근7일/직전7일).
            </p>
          </section>
        </>
      )}
    </div>
  )
}
