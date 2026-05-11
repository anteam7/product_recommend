export type SaleEventStatus = 'suggested' | 'active' | 'archived' | 'rejected'
export type SaleEventSource = 'manual' | 'ai_routine'

export const SALE_EVENT_STATUSES: SaleEventStatus[] = [
  'suggested',
  'active',
  'archived',
  'rejected',
]

export const SALE_EVENT_STATUS_LABEL: Record<
  SaleEventStatus,
  { label: string; color: string }
> = {
  suggested: { label: '제안', color: 'bg-amber-100 text-amber-800' },
  active: { label: '게시', color: 'bg-green-100 text-green-700' },
  archived: { label: '보관', color: 'bg-gray-100 text-gray-600' },
  rejected: { label: '거부', color: 'bg-red-100 text-red-700' },
}

// 직구 주요 대상 국가. 루틴·어드민 드롭다운 목록.
// GLOBAL 은 제거 — 직구는 결국 특정 국가 배대지 경유라 이벤트는 항상 국가 매칭 필요.
// AliExpress/Temu 는 CN, Farfetch/SSENSE 는 EU/US 처럼 실제 셀러 본거지로 분류.
export const COMMON_COUNTRIES: { code: string; label: string; flag: string }[] = [
  { code: 'US', label: '미국', flag: '🇺🇸' },
  { code: 'JP', label: '일본', flag: '🇯🇵' },
  { code: 'CN', label: '중국', flag: '🇨🇳' },
  { code: 'EU', label: '유럽', flag: '🇪🇺' },
]

export function countryLabel(code: string): string {
  const m = COMMON_COUNTRIES.find((c) => c.code === code)
  return m ? `${m.flag} ${m.label}` : code
}

export type SaleEvent = {
  id: string
  created_at: string
  updated_at: string
  created_by: string | null
  name: string
  slug: string | null
  country: string
  start_at: string | null // ISO date (YYYY-MM-DD)
  end_at: string | null
  categories: string[]
  description: string | null
  external_url: string | null
  recommended_forwarders: string[]
  related_blog_tags: string[]
  priority: number
  status: SaleEventStatus
  source: SaleEventSource
  confidence: number | null
  source_url: string | null
}

export type SaleEventInput = Partial<
  Omit<SaleEvent, 'id' | 'created_at' | 'updated_at' | 'slug'>
> & { name: string; country: string }

export function saleEventPhase(
  e: Pick<SaleEvent, 'start_at' | 'end_at'>,
  now: Date = new Date(),
): 'upcoming' | 'ongoing' | 'past' | 'undated' {
  if (!e.start_at && !e.end_at) return 'undated'
  const start = e.start_at ? new Date(e.start_at + 'T00:00:00+09:00') : null
  const end = e.end_at ? new Date(e.end_at + 'T23:59:59+09:00') : null
  if (start && now < start) return 'upcoming'
  if (end && now > end) return 'past'
  if (start && end && now >= start && now <= end) return 'ongoing'
  if (start && !end && now >= start) return 'ongoing' // 종료 미확정 = 진행 중 간주
  return 'upcoming'
}

export function daysUntil(dateStr: string, now: Date = new Date()): number {
  const target = new Date(dateStr + 'T00:00:00+09:00')
  const diff = target.getTime() - now.getTime()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

/** /compare/[country] 가 실제 지원하는 국가 코드. 그 외는 /compare (전체) 로 폴백. */
const SUPPORTED_COMPARE_COUNTRIES = new Set(['US', 'JP', 'CN'])

export function compareLinkFor(country: string): { href: string; label: string } {
  if (SUPPORTED_COMPARE_COUNTRIES.has(country)) {
    const label =
      { US: '미국 배송비 비교', JP: '일본 배송비 비교', CN: '중국 배송비 비교' }[country] ??
      '배송비 비교'
    return { href: `/compare/${country.toLowerCase()}`, label: `${label} →` }
  }
  return { href: '/compare', label: '전체 배송비 비교 →' }
}

/** 국가 코드별 배경색. 달력·뱃지에 일관된 컬러 맵 제공. */
export const COUNTRY_COLOR: Record<string, { bg: string; text: string; ring: string }> = {
  US: { bg: 'bg-blue-100',   text: 'text-blue-800',   ring: 'ring-blue-300' },
  JP: { bg: 'bg-pink-100',   text: 'text-pink-800',   ring: 'ring-pink-300' },
  CN: { bg: 'bg-red-100',    text: 'text-red-800',    ring: 'ring-red-300' },
  EU: { bg: 'bg-purple-100', text: 'text-purple-800', ring: 'ring-purple-300' },
}
export function countryColor(code: string) {
  return COUNTRY_COLOR[code] ?? { bg: 'bg-slate-100', text: 'text-slate-700', ring: 'ring-slate-300' }
}

/** YYYY-MM 문자열 파싱 — 잘못된 입력은 현재 KST 월로 폴백. */
export function parseMonthParam(s: string | undefined): { year: number; month: number } {
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split('-').map(Number)
    if (m >= 1 && m <= 12) return { year: y, month: m }
  }
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000) // KST
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
}

export function formatMonthParam(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

/**
 * 달력 그리드 — 일요일 시작 6주(42칸). 각 칸은 해당 날짜(YYYY-MM-DD)와 당월 여부.
 */
export function buildMonthGrid(year: number, month: number): { date: string; inMonth: boolean }[] {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const firstDow = first.getUTCDay() // 0=일
  const start = new Date(Date.UTC(year, month - 1, 1 - firstDow))
  const cells: { date: string; inMonth: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i))
    const y = d.getUTCFullYear()
    const m = d.getUTCMonth() + 1
    const day = d.getUTCDate()
    const date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    cells.push({ date, inMonth: m === month })
  }
  return cells
}

/** 특정 날짜에 겹치는 이벤트. start_at 이 있어야 하고, end_at 없으면 start_at 당일만 걸침. */
export function eventsOnDate<T extends { start_at: string | null; end_at: string | null }>(
  events: T[],
  date: string,
): T[] {
  return events.filter((e) => {
    if (!e.start_at) return false
    const end = e.end_at ?? e.start_at
    return e.start_at <= date && date <= end
  })
}

export function saleEventSlugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}
