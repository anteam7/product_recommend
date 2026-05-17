import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface VacancySignal {
  id: number
  detected_at: string
  window_date: string
  keyword: string
  category_top: string | null
  sku_id: string
  title: string | null
  mall_name: string | null
  vacancy_type: 'dropped_out' | 'went_oos' | 'review_crash' | string
  prev_rank: number | null
  prev_review: number | null
  curr_review: number | null
  ma7_delta: number | null
  curr_delta: number | null
  expected_window_hours: number | null
  ggsan_match_goods_no: string | null
  ggsan_match_score: number | null
  status: string
  notes: string | null
}

const TYPE_LABEL: Record<string, { label: string; color: string }> = {
  dropped_out: { label: '🚪 이탈', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  went_oos: { label: '🛑 품절', color: 'bg-red-100 text-red-800 border-red-300' },
  review_crash: { label: '📉 리뷰 급감', color: 'bg-purple-100 text-purple-800 border-purple-300' },
}

async function fetchSignals() {
  const sb = createAdminClient()
  // 새 테이블은 generated types 에 아직 없음 → as any 캐스팅
  const { data, error } = await (sb as any)
    .from('jimscanner_serp_vacancy_signals')
    .select('*')
    .in('status', ['open', 'pinned'])
    .order('window_date', { ascending: false })
    .order('detected_at', { ascending: false })
    .limit(500)

  if (error) {
    return { signals: [] as VacancySignal[], err: error.message }
  }
  return { signals: (data ?? []) as VacancySignal[], err: null as string | null }
}

function hoursRemaining(s: VacancySignal): number | null {
  if (!s.expected_window_hours) return null
  const elapsed = (Date.now() - new Date(s.detected_at).getTime()) / 3_600_000
  return Math.max(0, Math.round(s.expected_window_hours - elapsed))
}

export default async function VacancyBoardPage() {
  const { signals, err } = await fetchSignals()

  // 키워드별 그룹
  const byKeyword = new Map<string, VacancySignal[]>()
  for (const s of signals) {
    const arr = byKeyword.get(s.keyword) ?? []
    arr.push(s)
    byKeyword.set(s.keyword, arr)
  }
  const keywordGroups = [...byKeyword.entries()]
    .map(([k, list]) => ({
      keyword: k,
      list,
      // 우선순위: 잔여시간 짧은 + ggsan 매칭 있는 것 위로
      score:
        list.reduce(
          (acc, s) => acc + (s.ggsan_match_goods_no ? 2 : 0) + (s.vacancy_type === 'went_oos' ? 1 : 0),
          0,
        ) + list.length * 0.1,
    }))
    .sort((a, b) => b.score - a.score)

  const kpi = {
    total: signals.length,
    keywords: keywordGroups.length,
    oos: signals.filter((s) => s.vacancy_type === 'went_oos').length,
    matched: signals.filter((s) => !!s.ggsan_match_goods_no).length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🚪 공백 윈도우 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            경쟁 SKU 가 SERP 에서 빠지거나 품절·리뷰 급감한 짧은 윈도우. 24~72h 내 위탁 즉시 진입 후보.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {err && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          시그널 조회 실패: {err}
          <br />
          <span className="text-xs">
            <code>supabase/competitor_sku_serp_snapshots.sql</code> 적용 후 cron 실행 필요.
          </span>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="open 시그널" value={kpi.total} hint="status=open|pinned" />
        <Kpi label="키워드" value={kpi.keywords} hint="공백 발생 키워드" />
        <Kpi label="품절 전환" value={kpi.oos} hint="went_oos" />
        <Kpi label="ggsan 매칭" value={kpi.matched} hint="즉시 위탁 가능 후보" />
      </section>

      {keywordGroups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">현재 공백 윈도우 없음</p>
          <p className="text-sm mt-2">
            매일 새벽 cron 이 SERP 스냅샷 적재 → <code>detect-serp-vacancy.mjs</code> 가 시그널을 생성합니다.
          </p>
        </div>
      ) : (
        <section className="grid gap-4 md:grid-cols-2">
          {keywordGroups.map(({ keyword, list }) => (
            <article
              key={keyword}
              className="rounded border border-gray-200 bg-white p-4 hover:shadow-md transition-shadow"
            >
              <header className="flex items-baseline justify-between mb-3 pb-2 border-b border-gray-100">
                <div>
                  <h3 className="text-base font-semibold">{keyword}</h3>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {list[0]?.category_top ?? '미분류'} · {list.length}건 공백
                  </div>
                </div>
                <div className="text-xs text-gray-400 font-mono">
                  {list[0]?.window_date}
                </div>
              </header>
              <div className="space-y-2">
                {list.slice(0, 5).map((s) => {
                  const t = TYPE_LABEL[s.vacancy_type] ?? {
                    label: s.vacancy_type,
                    color: 'bg-gray-100 text-gray-700 border-gray-300',
                  }
                  const hrs = hoursRemaining(s)
                  return (
                    <div key={s.id} className="text-sm space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${t.color}`}
                        >
                          {t.label}
                        </span>
                        <span className="text-xs text-gray-500">
                          {s.mall_name ?? '판매처 미상'}
                        </span>
                        {hrs != null && (
                          <span className="text-[10px] text-gray-500 ml-auto">
                            잔여 ~{hrs}h
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-800 line-clamp-2">
                        {s.title ?? `(sku ${s.sku_id})`}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500 font-mono">
                        {s.prev_rank != null && <span>prev #{s.prev_rank}</span>}
                        {s.prev_review != null && s.curr_review != null && (
                          <span>
                            review {s.prev_review} → {s.curr_review}
                          </span>
                        )}
                        {s.vacancy_type === 'review_crash' && s.ma7_delta != null && (
                          <span>
                            Δ {s.curr_delta ?? 0}/d vs MA7 {s.ma7_delta}/d
                          </span>
                        )}
                      </div>
                      {s.ggsan_match_goods_no && (
                        <a
                          href={`https://www.ggsan.com/goods/goods_view.php?goodsNo=${s.ggsan_match_goods_no}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block text-[11px] text-green-700 hover:text-green-900 underline"
                        >
                          → ggsan 매칭 #{s.ggsan_match_goods_no} (sim {s.ggsan_match_score})
                        </a>
                      )}
                    </div>
                  )
                })}
                {list.length > 5 && (
                  <div className="text-xs text-gray-400 pt-1">+ {list.length - 5}건 더</div>
                )}
              </div>
              <footer className="mt-3 pt-2 border-t border-gray-100 flex items-center justify-end gap-2">
                <Link
                  href={`/admin/trend-radar/pins?prefill=${encodeURIComponent(keyword)}`}
                  className="text-[11px] px-2 py-1 rounded border border-gray-300 hover:bg-gray-50"
                >
                  📌 핀 등록
                </Link>
              </footer>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
