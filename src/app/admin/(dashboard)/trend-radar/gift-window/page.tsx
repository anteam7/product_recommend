import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface UpcomingHoliday {
  slug: string
  name_ko: string
  category: string
  gift_intent_tokens: string[]
  lead_time_days: number
  notes: string | null
  next_date: string
  d_minus: number
  purchase_deadline: string
}

interface CandidateRow {
  keyword: string
  matched_tokens: string[]
  current_volume: number | null
  last_year_volume: number | null
  lift_ratio: number | null
  last_seen_at: string | null
}

const HOLIDAY_BADGE: Record<string, string> = {
  family: 'bg-rose-50 text-rose-700 border-rose-200',
  romance: 'bg-pink-50 text-pink-700 border-pink-200',
  season: 'bg-amber-50 text-amber-700 border-amber-200',
  commerce: 'bg-violet-50 text-violet-700 border-violet-200',
}

async function fetchUpcomingHolidays(): Promise<UpcomingHoliday[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_upcoming_holidays')
    .select('*')
    .order('next_date', { ascending: true })
    .limit(20)

  if (error) {
    console.error('[gift-window] fetchUpcomingHolidays', error.message)
    return []
  }
  return (data ?? []) as UpcomingHoliday[]
}

async function fetchCandidates(slug: string, limit = 20): Promise<CandidateRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any).rpc('jimscanner_gift_window_candidates', {
    p_holiday_slug: slug,
    p_limit: limit,
  })
  if (error) {
    console.error('[gift-window] candidates', slug, error.message)
    return []
  }
  return (data ?? []) as CandidateRow[]
}

function formatDate(iso: string) {
  return iso.slice(5, 10).replace('-', '/')
}

function liftLabel(lift: number | null): { text: string; cls: string } {
  if (lift == null || !isFinite(lift)) return { text: '–', cls: 'text-gray-400' }
  const pct = Math.round((lift - 1) * 100)
  if (pct >= 30) return { text: `+${pct}%`, cls: 'text-red-600 font-semibold' }
  if (pct >= 0) return { text: `+${pct}%`, cls: 'text-emerald-600' }
  return { text: `${pct}%`, cls: 'text-gray-500' }
}

export default async function GiftWindowPage() {
  const holidays = await fetchUpcomingHolidays()

  // 90일 이내 다가오는 기념일만 핀 큐로 표시.
  const imminent = holidays.filter((h) => h.d_minus <= 90 && h.d_minus >= 0)

  // 각 기념일별 후보 키워드 (병렬).
  const candidatesPerHoliday = await Promise.all(
    imminent.slice(0, 6).map(async (h) => ({ holiday: h, rows: await fetchCandidates(h.slug, 15) })),
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🎁 Gift-Window — 기념일 D-day 진입 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            기념일 캘린더 × 선물의도 키워드 매칭. 도매 매입 데드라인 = 피크일 − 리드타임.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 다가오는 기념일 카드 (90일 이내) */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          📅 다가오는 기념일 ({imminent.length}건 · 90일 이내)
        </h2>
        {imminent.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            90일 이내 매핑된 기념일이 없습니다.<br />
            <code className="text-xs">supabase/holiday_calendar.sql</code> 적용 후 occurrences 시드를 확인하세요.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {imminent.map((h) => {
              const badgeCls = HOLIDAY_BADGE[h.category] ?? 'bg-gray-50 text-gray-700 border-gray-200'
              const dDayUrgent = h.d_minus <= h.lead_time_days
              return (
                <div
                  key={h.slug}
                  className={`rounded border px-3 py-3 ${
                    dDayUrgent ? 'border-red-300 bg-red-50/40' : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`inline-block text-[10px] px-2 py-0.5 rounded border ${badgeCls}`}>
                      {h.category}
                    </span>
                    <span
                      className={`text-xs font-mono ${
                        dDayUrgent ? 'text-red-700 font-bold' : 'text-gray-500'
                      }`}
                    >
                      D-{h.d_minus}
                    </span>
                  </div>
                  <div className="mt-2 font-semibold text-sm">{h.name_ko}</div>
                  <div className="mt-1 text-xs text-gray-500 font-mono">
                    {formatDate(h.next_date)} · 매입 ~{formatDate(h.purchase_deadline)}
                  </div>
                  <div className="mt-2 text-[11px] text-gray-500 line-clamp-2">
                    {h.gift_intent_tokens.slice(0, 4).join(' · ')}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 후보 키워드 큐 — 상위 6개 기념일 */}
      <section className="space-y-6">
        {candidatesPerHoliday.map(({ holiday, rows }) => {
          const badgeCls = HOLIDAY_BADGE[holiday.category] ?? 'bg-gray-50 text-gray-700 border-gray-200'
          return (
            <div key={holiday.slug} className="rounded border border-gray-200 p-4">
              <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
                <h3 className="text-base font-semibold">
                  <span
                    className={`inline-block text-[10px] px-2 py-0.5 rounded border align-middle mr-2 ${badgeCls}`}
                  >
                    Gift-Window: D-{holiday.d_minus} {holiday.name_ko}
                  </span>
                  <span className="text-xs text-gray-500 font-normal">
                    매입 데드라인 {formatDate(holiday.purchase_deadline)} · 리드타임 {holiday.lead_time_days}d
                  </span>
                </h3>
                <span className="text-xs text-gray-500">{rows.length}개 후보</span>
              </div>

              {rows.length === 0 ? (
                <div className="text-sm text-gray-500 py-4">
                  매칭된 키워드가 없습니다. (선물의도 토큰: {holiday.gift_intent_tokens.join(' / ')})
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b border-gray-100">
                        <th className="py-1.5 px-2 text-left w-[36%]">키워드</th>
                        <th className="py-1.5 px-2 text-left w-[24%]">매칭 토큰</th>
                        <th className="py-1.5 px-2 text-right">현재 검색량</th>
                        <th className="py-1.5 px-2 text-right">작년 동기</th>
                        <th className="py-1.5 px-2 text-right">YoY lift</th>
                        <th className="py-1.5 px-2 text-right">최근 수집</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const lift = liftLabel(r.lift_ratio)
                        return (
                          <tr key={r.keyword} className="border-b border-gray-50 hover:bg-gray-50/60">
                            <td className="py-1.5 px-2 font-medium">{r.keyword}</td>
                            <td className="py-1.5 px-2 text-xs text-gray-500">
                              {(r.matched_tokens ?? []).join(' · ')}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono">
                              {r.current_volume != null ? r.current_volume.toFixed(1) : '–'}
                            </td>
                            <td className="py-1.5 px-2 text-right font-mono text-gray-500">
                              {r.last_year_volume != null ? r.last_year_volume.toFixed(1) : '–'}
                            </td>
                            <td className={`py-1.5 px-2 text-right font-mono ${lift.cls}`}>{lift.text}</td>
                            <td className="py-1.5 px-2 text-right text-xs text-gray-400 font-mono">
                              {r.last_seen_at ? r.last_seen_at.slice(5, 10) : '–'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </section>

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        Event-time alignment: 다가오는 기념일을 D-0 으로 보고, 작년 동일 D-N 구간(14일 윈도우 평균) 대비 lift 산출.
        음력 명절(설/추석)은 <code>jimscanner_holiday_occurrences</code> 양력 매핑 사용.
      </footer>
    </div>
  )
}
