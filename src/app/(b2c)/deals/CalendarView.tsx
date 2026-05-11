import Link from 'next/link'
import {
  type SaleEvent,
  addMonths,
  buildMonthGrid,
  countryColor,
  eventsOnDate,
  formatMonthParam,
  compareLinkFor,
} from '@/lib/deals'

type Props = {
  events: SaleEvent[]
  year: number
  month: number
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function todayKSTISO(): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const d = now.getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export default function CalendarView({ events, year, month }: Props) {
  const grid = buildMonthGrid(year, month)
  const prev = addMonths(year, month, -1)
  const next = addMonths(year, month, 1)
  const today = todayKSTISO()

  // 이 달에 걸리는 이벤트만 (undated · 이 달에 안 겹치는 건 제외)
  const monthFirst = `${year}-${String(month).padStart(2, '0')}-01`
  const monthLast = `${year}-${String(month).padStart(2, '0')}-31`
  const eventsInMonth = events.filter((e) => {
    if (!e.start_at) return false
    const end = e.end_at ?? e.start_at
    return end >= monthFirst && e.start_at <= monthLast
  })

  return (
    <div className="space-y-4">
      {/* 월 네비게이션 */}
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/deals?view=calendar&month=${formatMonthParam(prev.year, prev.month)}`}
          className="text-sm px-3 py-1.5 border rounded hover:bg-gray-50"
        >
          ← {prev.year}년 {prev.month}월
        </Link>
        <h2 className="text-lg font-bold text-gray-900">
          {year}년 {month}월
        </h2>
        <Link
          href={`/deals?view=calendar&month=${formatMonthParam(next.year, next.month)}`}
          className="text-sm px-3 py-1.5 border rounded hover:bg-gray-50"
        >
          {next.year}년 {next.month}월 →
        </Link>
      </div>

      {/* 달력 그리드 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        {/* 요일 헤더 */}
        <div className="grid grid-cols-7 border-b bg-gray-50">
          {WEEKDAYS.map((d, i) => (
            <div
              key={d}
              className={`px-1 sm:px-2 py-2 text-xs font-semibold text-center ${
                i === 0 ? 'text-red-600' : i === 6 ? 'text-blue-600' : 'text-gray-700'
              }`}
            >
              {d}
            </div>
          ))}
        </div>

        {/* 날짜 칸 */}
        <div className="grid grid-cols-7">
          {grid.map((cell, i) => {
            const dayOfWeek = i % 7
            const dayNum = parseInt(cell.date.slice(-2), 10)
            const cellEvents = eventsOnDate(eventsInMonth, cell.date)
            const isToday = cell.date === today

            return (
              <div
                key={cell.date}
                className={`min-h-[84px] sm:min-h-[112px] p-1 border-b border-r last:border-r-0 text-xs ${
                  cell.inMonth ? 'bg-white' : 'bg-gray-50 text-gray-400'
                }`}
              >
                <div
                  className={`flex items-center justify-center w-6 h-6 mb-1 rounded-full text-xs font-medium ${
                    isToday
                      ? 'bg-blue-600 text-white'
                      : !cell.inMonth
                        ? 'text-gray-400'
                        : dayOfWeek === 0
                          ? 'text-red-600'
                          : dayOfWeek === 6
                            ? 'text-blue-600'
                            : 'text-gray-900'
                  }`}
                >
                  {dayNum}
                </div>

                <div className="space-y-0.5">
                  {cellEvents.slice(0, 3).map((ev) => {
                    const c = countryColor(ev.country)
                    const isStart = ev.start_at === cell.date
                    return (
                      <div
                        key={ev.id}
                        className={`truncate text-[10px] sm:text-[11px] px-1 py-0.5 rounded ${c.bg} ${c.text} ${
                          isStart ? 'font-semibold' : 'opacity-80'
                        }`}
                        title={`${ev.name} (${ev.start_at}${ev.end_at && ev.end_at !== ev.start_at ? ` ~ ${ev.end_at}` : ''})`}
                      >
                        {ev.name}
                      </div>
                    )
                  })}
                  {cellEvents.length > 3 && (
                    <div className="text-[10px] text-gray-500 px-1">
                      +{cellEvents.length - 3} 더
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 범례 + 이번달 리스트 */}
      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-700">국가 색상:</span>
          {(['US', 'JP', 'CN', 'EU'] as const).map((code) => {
            const c = countryColor(code)
            const label = { US: '🇺🇸 미국', JP: '🇯🇵 일본', CN: '🇨🇳 중국', EU: '🇪🇺 유럽' }[code]
            return (
              <span key={code} className={`text-[11px] px-2 py-0.5 rounded ${c.bg} ${c.text}`}>
                {label}
              </span>
            )
          })}
        </div>

        {eventsInMonth.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-2">
              이 달 이벤트 ({eventsInMonth.length}건)
            </div>
            <ul className="space-y-1">
              {eventsInMonth
                .slice()
                .sort((a, b) => (a.start_at ?? '').localeCompare(b.start_at ?? ''))
                .map((ev) => {
                  const c = countryColor(ev.country)
                  return (
                    <li key={ev.id} className="flex items-center gap-2 text-xs">
                      <span className={`shrink-0 w-2 h-2 rounded-full ${c.bg.replace('bg-', 'bg-')}`} />
                      <span className="text-gray-500 tabular-nums shrink-0">
                        {ev.start_at?.slice(5)}
                        {ev.end_at && ev.end_at !== ev.start_at ? `~${ev.end_at.slice(5)}` : ''}
                      </span>
                      <span className="text-gray-900 truncate">{ev.name}</span>
                      {ev.external_url && (
                        <a
                          href={ev.external_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-blue-600 hover:underline"
                        >
                          ↗
                        </a>
                      )}
                      <Link
                        href={compareLinkFor(ev.country).href}
                        className="shrink-0 text-blue-600 hover:underline ml-auto"
                      >
                        비교 →
                      </Link>
                    </li>
                  )
                })}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
