import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  type SaleEvent,
  saleEventPhase,
  daysUntil,
  countryLabel,
} from '@/lib/deals'

/**
 * 홈 상단 슬림 배너. 진행 중 또는 D-14 이내 예정된 가장 급한 이벤트 1개 표시.
 * 조건 안 맞으면 null (렌더 안 함).
 */
export default async function DealsBanner() {
  const { data } = await supabase
    .from('jimscanner_sale_events')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .order('start_at', { ascending: true, nullsFirst: false })
    .limit(20)

  const events = (data ?? []) as SaleEvent[]
  const now = new Date()

  // 1. 진행 중 이벤트 우선, 2. D-14 이내 upcoming, 3. priority DESC
  const ongoing = events.filter((e) => saleEventPhase(e, now) === 'ongoing')
  const upcomingSoon = events
    .filter((e) => {
      if (saleEventPhase(e, now) !== 'upcoming') return false
      if (!e.start_at) return false
      const d = daysUntil(e.start_at, now)
      return d <= 14 && d >= 0
    })
    .sort((a, b) => (daysUntil(a.start_at!, now) - daysUntil(b.start_at!, now)))

  const target = ongoing[0] ?? upcomingSoon[0]
  if (!target) return null

  const isOngoing = saleEventPhase(target, now) === 'ongoing'
  const dayLabel = isOngoing
    ? target.end_at
      ? `종료까지 D-${Math.max(0, daysUntil(target.end_at, now))}`
      : '진행 중'
    : target.start_at
      ? `D-${Math.max(0, daysUntil(target.start_at, now))}`
      : ''

  return (
    <Link
      href="/deals"
      className={`block border-b ${
        isOngoing ? 'bg-red-50 border-red-100' : 'bg-blue-50 border-blue-100'
      }`}
    >
      <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-3 text-sm">
        <span
          className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded ${
            isOngoing ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
          }`}
        >
          {isOngoing ? '🔥 진행중' : '📅 예정'}
        </span>
        <span className="shrink-0 text-xs text-gray-500">{countryLabel(target.country)}</span>
        <span className="font-semibold text-gray-900 truncate min-w-0">{target.name}</span>
        {dayLabel && (
          <span className="shrink-0 text-xs font-semibold text-gray-700">{dayLabel}</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-blue-700 hover:underline">
          전체 세일 일정 →
        </span>
      </div>
    </Link>
  )
}
