import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CalendarRow {
  id: string
  event_key: string
  name: string
  event_type: string
  date: string
  origin: string | null
  primary_categories: string[]
  lead_order_days: number
  lead_publish_days: number
  notes: string | null
}
interface LiftRow {
  event_key: string
  category_top: string
  lift_ratio: number | null
  peak_lag_days: number | null
  sample_count: number
  confidence: number | null
}
interface GgsanRow {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  status: string | null
  is_imminent: boolean | null
  last_seen_at: string
}

const ORIGIN_LABEL: Record<string, string> = {
  KR: '🇰🇷',
  CN: '🇨🇳',
  US: '🇺🇸',
  JP: '🇯🇵',
}

const TYPE_LABEL: Record<string, string> = {
  national_holiday: '명절',
  memorial_day: '기념일',
  shopping_event: '쇼핑',
  foreign_event: '해외',
  school_event: '교육',
}

async function fetchData() {
  const sb = createAdminClient()
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const horizon = new Date(today.getTime() + 120 * 86400_000).toISOString().slice(0, 10)

  // 1) 다가오는 이벤트 (오늘 ~ +120d)
  const { data: calData } = await (sb as any)
    .from('jimscanner_retail_calendar')
    .select('id, event_key, name, event_type, date, origin, primary_categories, lead_order_days, lead_publish_days, notes')
    .gte('date', todayIso)
    .lte('date', horizon)
    .order('date', { ascending: true })
  const upcoming = (calData ?? []) as CalendarRow[]

  // 2) Lift 테이블 전체
  const { data: liftData } = await (sb as any)
    .from('jimscanner_event_lifts')
    .select('event_key, category_top, lift_ratio, peak_lag_days, sample_count, confidence')
  const lifts = (liftData ?? []) as LiftRow[]

  // 3) ggsan 최근 7일 active 카탈로그 (오늘 발주 가능 후보)
  const cutoff = new Date(today.getTime() - 7 * 86400_000).toISOString()
  const { data: ggData } = await (sb as any)
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_label, price_krw, status, is_imminent, last_seen_at')
    .gte('last_seen_at', cutoff)
    .eq('status', 'active')
    .limit(2000)
  const ggsan = (ggData ?? []) as GgsanRow[]

  return { upcoming, lifts, ggsan, todayIso }
}

function dDay(eventDate: string, todayIso: string): number {
  const a = new Date(eventDate + 'T00:00:00Z').getTime()
  const b = new Date(todayIso + 'T00:00:00Z').getTime()
  return Math.round((a - b) / 86400_000)
}

function liftCellColor(lift: number | null): string {
  if (lift == null) return 'bg-gray-50 text-gray-400'
  if (lift >= 3) return 'bg-red-200 text-red-900'
  if (lift >= 2) return 'bg-orange-200 text-orange-900'
  if (lift >= 1.4) return 'bg-amber-100 text-amber-900'
  if (lift >= 1) return 'bg-emerald-50 text-emerald-900'
  return 'bg-gray-50 text-gray-500'
}

function recommendAction(d: number, lead_order: number, lead_publish: number): { label: string; tone: string } {
  if (d < 0) return { label: '경과', tone: 'text-gray-400' }
  if (d <= lead_publish) return { label: `D-${d} 🔥 노출시작·재고 클리어`, tone: 'text-red-700 font-semibold' }
  if (d <= lead_order) return { label: `D-${d} 📦 발주 골든윈도우`, tone: 'text-orange-700 font-semibold' }
  if (d <= lead_order + 14) return { label: `D-${d} 🛒 발주 준비`, tone: 'text-amber-700' }
  return { label: `D-${d} 관망`, tone: 'text-gray-500' }
}

export default async function EventWindowPage() {
  const { upcoming, lifts, ggsan, todayIso } = await fetchData()

  // 가장 가까운 이벤트
  const nearest = upcoming[0]
  const nearestD = nearest ? dDay(nearest.date, todayIso) : null

  // lift 매트릭스 (event_key × category)
  const liftMap = new Map<string, Map<string, LiftRow>>()
  const categoriesSet = new Set<string>()
  for (const l of lifts) {
    if (!liftMap.has(l.event_key)) liftMap.set(l.event_key, new Map())
    liftMap.get(l.event_key)!.set(l.category_top, l)
    categoriesSet.add(l.category_top)
  }
  const categories = [...categoriesSet].sort()

  // upcoming 이벤트 중 unique event_key (date 가장 가까운 한 회차만)
  const uniqueEvents: CalendarRow[] = []
  const seenKey = new Set<string>()
  for (const e of upcoming) {
    if (seenKey.has(e.event_key)) continue
    seenKey.add(e.event_key)
    uniqueEvents.push(e)
  }
  const heatmapEvents = uniqueEvents.slice(0, 12)

  // 오늘 발주 가능 D-day 후보: nearest 의 primary_categories 와 ggsan cate_label 부분일치
  const ggsanCandidates = nearest
    ? ggsan.filter((g) => {
        const lbl = (g.cate_label ?? '').toLowerCase()
        return nearest.primary_categories.some((c) => lbl.includes(c) || matchCategoryKo(c, lbl))
      }).slice(0, 30)
    : []

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🗓️ Event Window — D-day 선입고 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            한국 리테일 이벤트 캘린더 × 카테고리 lift × ggsan 재고 — 결정적 진입 윈도우
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 1) 가장 가까운 이벤트 카드 */}
      {nearest ? (
        <section className="rounded border-2 border-amber-300 bg-amber-50 p-5">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <div className="text-xs text-amber-700 font-semibold uppercase">다음 이벤트</div>
              <div className="text-2xl font-bold mt-1">
                {ORIGIN_LABEL[nearest.origin ?? 'KR'] ?? ''} {nearest.name}{' '}
                <span className="text-sm font-normal text-gray-600 ml-2">
                  {TYPE_LABEL[nearest.event_type] ?? nearest.event_type}
                </span>
              </div>
              <div className="text-sm text-gray-700 mt-1">
                {nearest.date} ·{' '}
                <span className={recommendAction(nearestD!, nearest.lead_order_days, nearest.lead_publish_days).tone}>
                  {recommendAction(nearestD!, nearest.lead_order_days, nearest.lead_publish_days).label}
                </span>
              </div>
              {nearest.notes && (
                <div className="text-xs text-gray-500 mt-1">💡 {nearest.notes}</div>
              )}
            </div>
            <div className="text-right">
              <div className="text-5xl font-bold font-mono text-amber-700">
                D-{nearestD}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                📦 발주: D-{nearest.lead_order_days} · 📣 노출: D-{nearest.lead_publish_days}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {nearest.primary_categories.map((c) => (
              <span key={c} className="text-xs px-2 py-1 rounded bg-white border border-amber-200">
                {c}
              </span>
            ))}
          </div>
        </section>
      ) : (
        <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500">
          향후 120일 내 등록된 이벤트가 없습니다. supabase/event_calendar.sql 시드를 확인하세요.
        </div>
      )}

      {/* 2) 카테고리 × 이벤트 lift 히트맵 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          📊 카테고리 × 이벤트 lift 히트맵{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            (peak avg / baseline avg · 1.0 = 평년)
          </span>
        </h2>
        {lifts.length === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 lift 누적 없음. cron <code className="px-1 bg-gray-100 rounded">event_calendar_recompute</code> 가
            과거 회차 데이터를 학습 중. 다음 KST 04:30 자동 갱신.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-xs w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left py-1 pr-3">이벤트</th>
                  {categories.map((c) => (
                    <th key={c} className="text-center px-2 py-1 text-gray-600">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatmapEvents.map((e) => {
                  const eventLifts = liftMap.get(e.event_key)
                  const d = dDay(e.date, todayIso)
                  return (
                    <tr key={e.event_key} className="border-t border-gray-100">
                      <td className="py-1 pr-3">
                        <div className="font-medium">{e.name}</div>
                        <div className="text-gray-500 font-mono">D-{d}</div>
                      </td>
                      {categories.map((c) => {
                        const l = eventLifts?.get(c)
                        return (
                          <td key={c} className={`text-center px-2 py-1 ${liftCellColor(l?.lift_ratio ?? null)}`}>
                            {l?.lift_ratio != null ? (
                              <>
                                <div className="font-mono font-bold">{l.lift_ratio.toFixed(1)}×</div>
                                <div className="text-[10px] opacity-70">
                                  {l.peak_lag_days != null ? (l.peak_lag_days >= 0 ? `+${l.peak_lag_days}` : l.peak_lag_days) + 'd' : ''}
                                  {' · n='}{l.sample_count}
                                </div>
                              </>
                            ) : (
                              <span className="text-gray-300">·</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3) 다가오는 이벤트 + 권장 액션 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          🗓️ 향후 120일 이벤트 ({upcoming.length})
        </h2>
        <div className="space-y-1">
          {upcoming.slice(0, 30).map((e) => {
            const d = dDay(e.date, todayIso)
            const action = recommendAction(d, e.lead_order_days, e.lead_publish_days)
            return (
              <div key={e.id} className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-gray-50 border-b border-gray-100">
                <div className="col-span-1 font-mono text-gray-500">D-{d}</div>
                <div className="col-span-2 text-gray-600">{e.date}</div>
                <div className="col-span-4">
                  <span>{ORIGIN_LABEL[e.origin ?? 'KR'] ?? ''} {e.name}</span>
                  <span className="text-xs text-gray-500 ml-2">{TYPE_LABEL[e.event_type] ?? e.event_type}</span>
                </div>
                <div className="col-span-3 text-xs text-gray-500 truncate">
                  {e.primary_categories.slice(0, 4).join(' · ')}
                </div>
                <div className={`col-span-2 text-xs text-right ${action.tone}`}>{action.label}</div>
              </div>
            )
          })}
        </div>
      </section>

      {/* 4) 오늘 발주 가능한 D-day 후보 (ggsan) */}
      {nearest && (
        <section className="rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            📦 오늘 발주 가능 — {nearest.name} D-day 후보{' '}
            <span className="text-xs font-normal text-gray-500 ml-2">
              (ggsan active · 최근 7일 · 카테고리 매칭 {ggsanCandidates.length})
            </span>
          </h2>
          {ggsanCandidates.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-6">
              이벤트 primary_categories 와 매칭되는 ggsan 활성 상품이 없습니다.
            </div>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
                <div className="col-span-1">#</div>
                <div className="col-span-7">상품명</div>
                <div className="col-span-2">카테고리</div>
                <div className="col-span-1 text-right">도매가</div>
                <div className="col-span-1 text-right">최근</div>
              </div>
              {ggsanCandidates.map((g, i) => (
                <a
                  key={g.goods_no}
                  href={`https://www.ggsan.com/goods/goods_view.php?goodsNo=${g.goods_no}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-gray-50 border-b border-gray-100"
                >
                  <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                  <div className="col-span-7 truncate">
                    {g.is_imminent && <span className="text-red-700 font-semibold mr-1">[임박]</span>}
                    {g.title}
                  </div>
                  <div className="col-span-2 text-xs text-gray-500 truncate">{g.cate_label ?? '-'}</div>
                  <div className="col-span-1 text-right font-mono">{g.price_krw?.toLocaleString() ?? '-'}</div>
                  <div className="col-span-1 text-right text-xs text-gray-400">{g.last_seen_at.slice(5, 10)}</div>
                </a>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

// ggsan cate_label 은 한국어 ('장건강', '눈건강', '주방용품') 이므로 영문 카테고리 → 한국어 키워드 매핑.
function matchCategoryKo(category: string, labelLower: string): boolean {
  const map: Record<string, string[]> = {
    health: ['건강', '영양', '홍삼', '비타민', '다이어트'],
    food: ['식품', '간식', '음료', '커피'],
    living: ['생활', '주방', '욕실', '청소'],
    digital: ['디지털', '가전', '전자'],
    beauty: ['뷰티', '화장품', '미용'],
    fashion: ['패션', '의류', '잡화'],
    flowers: ['플라워', '꽃'],
    toys: ['장난감', '완구', '키즈'],
    study: ['문구', '학습', '도서'],
    outdoor: ['아웃도어', '캠핑', '레저'],
  }
  const keys = map[category]
  if (!keys) return false
  return keys.some((k) => labelLower.includes(k.toLowerCase()))
}
