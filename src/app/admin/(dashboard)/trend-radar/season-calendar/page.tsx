import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SeasonRow {
  iso_week: number
  category_top: string
  baseline_volume: number | null
  baseline_rows: number | null
  annual_mean_volume: number | null
  expected_uplift_pct: number | null
  confidence_score: number | null
  anchor_keywords: Array<{ keyword: string; avg_volume: number; rows: number }> | null
}

interface SearchParams {
  cat?: string
  week?: string
}

const CATEGORY_LABEL: Record<string, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  unknown: '미분류',
}

const LEAD_WEEKS = 4 // 권장 위탁 등록 리드타임

// KST 기준 현재 ISO 주차 (1~53)
function currentIsoWeekKst(now = new Date()): { year: number; week: number } {
  // KST = UTC+9
  const kstMs = now.getTime() + 9 * 3600_000
  const d = new Date(kstMs)
  // ISO week calculation (Monday-based)
  const utcDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = utcDate.getUTCDay() || 7
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return { year: utcDate.getUTCFullYear(), week }
}

// W+1 ~ W+12 forward weeks
function forwardWeeks(startIsoWeek: number, count = 12): number[] {
  const out: number[] = []
  for (let i = 1; i <= count; i++) {
    const w = ((startIsoWeek - 1 + i) % 52) + 1
    out.push(w)
  }
  return out
}

// ISO 주차 → 해당 주의 월요일 KST 날짜
function isoWeekToMonday(year: number, week: number): Date {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7))
  const dow = simple.getUTCDay() || 7
  const monday = new Date(simple)
  monday.setUTCDate(simple.getUTCDate() - dow + 1)
  return monday
}

function fmtMonthDay(year: number, week: number): string {
  const m = isoWeekToMonday(year, week)
  const mm = (m.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = m.getUTCDate().toString().padStart(2, '0')
  return `${mm}/${dd}`
}

function upliftToTone(pct: number | null | undefined): { bg: string; text: string; label: string } {
  const v = pct ?? 0
  if (v >= 30) return { bg: 'bg-red-500', text: 'text-white', label: '🔥' }
  if (v >= 15) return { bg: 'bg-orange-400', text: 'text-white', label: '↑↑' }
  if (v >= 5) return { bg: 'bg-amber-200', text: 'text-amber-900', label: '↑' }
  if (v >= -5) return { bg: 'bg-gray-100', text: 'text-gray-700', label: '·' }
  return { bg: 'bg-blue-100', text: 'text-blue-700', label: '↓' }
}

async function fetchSeasonRows(): Promise<{ rows: SeasonRow[]; computedAt: string | null }> {
  const sb = createAdminClient()
  // matview 는 generated types 에 없음 → as any 로 우회 (CLAUDE.md 가이드라인)
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_season_calendar')
    .select(
      'iso_week, category_top, baseline_volume, baseline_rows, annual_mean_volume, expected_uplift_pct, confidence_score, anchor_keywords, computed_at',
    )
    .order('iso_week', { ascending: true })

  if (error || !data) return { rows: [], computedAt: null }
  const rows = data as SeasonRow[]
  const computedAt = (data as any)[0]?.computed_at ?? null
  return { rows, computedAt }
}

export default async function SeasonCalendarPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const focusWeekRaw = sp.week ? parseInt(sp.week, 10) : null
  const focusWeek = focusWeekRaw && focusWeekRaw >= 1 && focusWeekRaw <= 53 ? focusWeekRaw : null

  const { rows, computedAt } = await fetchSeasonRows()

  const { year: kstYear, week: currentWeek } = currentIsoWeekKst()
  const weeks = forwardWeeks(currentWeek, 12)

  // (week, category) → row 맵
  const byKey = new Map<string, SeasonRow>()
  const categorySet = new Set<string>()
  for (const r of rows) {
    byKey.set(`${r.iso_week}|${r.category_top}`, r)
    categorySet.add(r.category_top)
  }
  const categories = ['health', 'living', 'digital'].filter((c) => categorySet.has(c))
  // 누락된 카테고리도 자리는 잡아 둠
  if (categories.length === 0 && categorySet.size > 0) {
    categories.push(...[...categorySet].slice(0, 4))
  }
  if (categories.length === 0) {
    categories.push('health', 'living', 'digital')
  }

  // 셀 선택 (focus 모드)
  const focusRows: SeasonRow[] = focusWeek
    ? categories
        .map((c) => byKey.get(`${focusWeek}|${c}`))
        .filter((x): x is SeasonRow => !!x)
    : []

  // 권장 위탁 등록 alert: 이번 주가 어떤 카테고리의 (피크-4주) 인가?
  // = 향후 LEAD_WEEKS 주차의 uplift 가 큰 셀
  const peakWeekForLead = ((currentWeek - 1 + LEAD_WEEKS) % 52) + 1
  const leadAlerts = categories
    .map((c) => byKey.get(`${peakWeekForLead}|${c}`))
    .filter((x): x is SeasonRow => !!x)
    .filter((r) => (r.expected_uplift_pct ?? 0) >= 10)
    .sort((a, b) => (b.expected_uplift_pct ?? 0) - (a.expected_uplift_pct ?? 0))

  const empty = rows.length === 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">📅 12주 시즌 캘린더</h1>
          <p className="text-sm text-gray-500 mt-1">
            ISO 주차 단위 시즌 곡선 기반 forward-looking 진입 예정 보드 ·
            현재 W{currentWeek}/{kstYear} · 권장 위탁 등록 리드타임 {LEAD_WEEKS}주
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {empty ? (
        <EmptyState />
      ) : (
        <>
          {/* 이번 주 등록 알림 (피크 -4주) */}
          {leadAlerts.length > 0 && (
            <section className="rounded border border-red-300 bg-red-50 px-4 py-3">
              <div className="text-sm font-semibold text-red-900">
                ⏰ 이번 주(W{currentWeek}) 위탁 등록 권장
                <span className="ml-2 text-xs font-normal text-red-700">
                  W{peakWeekForLead} 피크 예측 ({fmtMonthDay(kstYear, peakWeekForLead)} 주) — 지금 등록해야 SEO·재고 리드타임 맞음
                </span>
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {leadAlerts.map((r) => (
                  <li key={r.category_top} className="flex items-center gap-3">
                    <span className="font-mono text-red-900 font-bold w-16">
                      +{(r.expected_uplift_pct ?? 0).toFixed(0)}%
                    </span>
                    <span className="font-semibold text-gray-800 w-20">
                      {CATEGORY_LABEL[r.category_top] ?? r.category_top}
                    </span>
                    <span className="text-xs text-gray-600 truncate">
                      앵커: {(r.anchor_keywords ?? []).slice(0, 3).map((a) => a.keyword).join(' · ') || '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 12주 × 카테고리 그리드 */}
          <section className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 sticky left-0 bg-gray-50">
                    카테고리
                  </th>
                  {weeks.map((w) => (
                    <th key={w} className="px-2 py-2 text-xs font-medium text-gray-500 text-center min-w-[64px]">
                      <div>W{w}</div>
                      <div className="text-[10px] text-gray-400 font-normal">
                        {fmtMonthDay(kstYear, w)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 font-medium text-gray-800 sticky left-0 bg-white">
                      {CATEGORY_LABEL[cat] ?? cat}
                    </td>
                    {weeks.map((w) => {
                      const r = byKey.get(`${w}|${cat}`)
                      const tone = upliftToTone(r?.expected_uplift_pct)
                      const isFocus = focusWeek === w
                      return (
                        <td key={w} className="p-1 align-top">
                          <Link
                            href={`/admin/trend-radar/season-calendar?week=${w}`}
                            className={`block rounded text-center px-1 py-2 ${tone.bg} ${tone.text} hover:opacity-80 transition-opacity ${
                              isFocus ? 'ring-2 ring-black' : ''
                            }`}
                            title={
                              r
                                ? `W${w} ${cat} · uplift ${(r.expected_uplift_pct ?? 0).toFixed(1)}% · 신뢰도 ${(r.confidence_score ?? 0).toFixed(0)}`
                                : '데이터 없음'
                            }
                          >
                            <div className="text-xs font-mono font-bold">
                              {r ? `${(r.expected_uplift_pct ?? 0) >= 0 ? '+' : ''}${(r.expected_uplift_pct ?? 0).toFixed(0)}%` : '—'}
                            </div>
                            <div className="text-[10px] opacity-70">{tone.label}</div>
                          </Link>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 범례 */}
          <section className="flex items-center gap-3 text-xs text-gray-600 flex-wrap">
            <Legend bg="bg-red-500" text="text-white" label="≥ +30% (피크)" />
            <Legend bg="bg-orange-400" text="text-white" label="+15 ~ +30%" />
            <Legend bg="bg-amber-200" text="text-amber-900" label="+5 ~ +15%" />
            <Legend bg="bg-gray-100" text="text-gray-700" label="±5% (baseline)" />
            <Legend bg="bg-blue-100" text="text-blue-700" label="< -5% (비수기)" />
            <span className="text-gray-400">
              · 셀 클릭 = 그 주 진입 예정 앵커 키워드 보기
            </span>
          </section>

          {/* 포커스된 주차 상세 */}
          {focusWeek && (
            <section className="rounded border border-gray-200 p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-semibold">
                  W{focusWeek} ({fmtMonthDay(kstYear, focusWeek)} 주) — 진입 예정 앵커
                </h2>
                <Link
                  href="/admin/trend-radar/season-calendar"
                  className="text-xs text-gray-500 hover:text-black underline"
                >
                  닫기
                </Link>
              </div>
              {focusRows.length === 0 ? (
                <div className="text-sm text-gray-500">이 주차에는 baseline 데이터가 없습니다.</div>
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  {focusRows.map((r) => {
                    // 권장 등록 주: 피크 - LEAD_WEEKS (단순 wrap)
                    const recommendWeek = ((r.iso_week - LEAD_WEEKS - 1 + 52) % 52) + 1
                    const isPast = currentWeek > recommendWeek && currentWeek - recommendWeek < 26
                    return (
                      <div key={r.category_top} className="rounded border border-gray-200 p-3">
                        <div className="flex items-baseline justify-between">
                          <div className="text-sm font-semibold">
                            {CATEGORY_LABEL[r.category_top] ?? r.category_top}
                          </div>
                          <div className="text-xs font-mono">
                            uplift{' '}
                            <span className="font-bold">
                              {(r.expected_uplift_pct ?? 0) >= 0 ? '+' : ''}
                              {(r.expected_uplift_pct ?? 0).toFixed(1)}%
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-gray-600">
                          신뢰도 {(r.confidence_score ?? 0).toFixed(0)} · baseline rows{' '}
                          {r.baseline_rows ?? 0}
                        </div>
                        <div
                          className={`mt-2 text-xs rounded px-2 py-1 ${
                            isPast
                              ? 'bg-red-50 text-red-800'
                              : 'bg-green-50 text-green-800'
                          }`}
                        >
                          권장 위탁 등록: W{recommendWeek} ({fmtMonthDay(kstYear, recommendWeek)} 주)
                          {isPast && ' · ⚠️ 이미 지남'}
                        </div>
                        <div className="mt-3">
                          <div className="text-xs text-gray-500 mb-1">앵커 키워드 (역대 ISO 주 평균)</div>
                          {(r.anchor_keywords ?? []).length === 0 ? (
                            <div className="text-xs text-gray-400">데이터 없음</div>
                          ) : (
                            <ul className="space-y-1">
                              {(r.anchor_keywords ?? []).slice(0, 5).map((a, i) => (
                                <li
                                  key={`${a.keyword}-${i}`}
                                  className="flex justify-between text-xs"
                                >
                                  <span className="truncate text-gray-800">{a.keyword}</span>
                                  <span className="font-mono text-gray-500">
                                    {Number(a.avg_volume).toFixed(1)} ({a.rows})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          <p className="text-xs text-gray-400">
            데이터: jimscanner_trends_season_calendar 매트뷰 ·{' '}
            {computedAt
              ? `last refresh: ${new Date(computedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`
              : 'refresh time 미상'}{' '}
            · 갱신: KST 06:10 recompute cron 직후 REFRESH MATERIALIZED VIEW
          </p>
        </>
      )}
    </div>
  )
}

function Legend({ bg, text, label }: { bg: string; text: string; label: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded ${bg} ${text}`}>{label}</span>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 시즌 캘린더 데이터 없음</p>
      <p className="text-sm mt-2">
        supabase/trends_v5_season_calendar.sql 마이그레이션을 적용한 뒤
        <br />
        <code className="px-1 bg-gray-100 rounded">REFRESH MATERIALIZED VIEW jimscanner_trends_season_calendar</code>{' '}
        을 한 번 실행하세요.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        매트뷰는 jimscanner_trends_keywords (volume_relative IS NOT NULL) 누적 row 로 빌드됩니다.
      </p>
    </div>
  )
}
