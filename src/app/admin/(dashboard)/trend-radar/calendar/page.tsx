import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface EventRow {
  id: string
  event_key: string
  event_name: string
  category: string | null
  anchor_month: number | null
  anchor_day: number | null
  lead_days: number
  tail_days: number
  related_keywords: string[]
  yoy_lift_median: number | null
  yoy_lift_stddev: number | null
  learned_peak_doy: number | null
  learned_peak_stddev: number | null
  sample_years: number
  last_learned_at: string | null
  is_active: boolean
}

interface PinCandidate {
  goods_no: string
  title: string
  image_url: string | null
  detail_url: string | null
  price_krw: number | null
}

function nextAnchor(now: Date, month: number, day: number): Date {
  const year = now.getUTCFullYear()
  const cand = new Date(Date.UTC(year, month - 1, day))
  if (cand.getTime() < startOfDayUTC(now).getTime()) {
    return new Date(Date.UTC(year + 1, month - 1, day))
  }
  return cand
}
function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}
function fmt(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${m}-${day}`
}

function windowOf(dToAnchor: number, lead: number, tail: number) {
  if (dToAnchor > lead) return { label: 'idle', tone: 'gray' } as const
  if (dToAnchor > 7) return { label: '진입권장', tone: 'amber' } as const
  if (dToAnchor > 0) return { label: '🔥 피크접근', tone: 'red' } as const
  if (dToAnchor >= -tail) return { label: '피크중', tone: 'emerald' } as const
  if (dToAnchor >= -tail - 7) return { label: '⚠ 철수권장', tone: 'rose' } as const
  return { label: '종료', tone: 'gray' } as const
}

async function fetchEvents(): Promise<EventRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_event_calendar' as never)
    .select('*')
    .eq('is_active', true)
    .order('anchor_month', { ascending: true })
    .order('anchor_day', { ascending: true })
  return (data ?? []) as unknown as EventRow[]
}

async function fetchPinCandidates(keywords: string[], limit: number): Promise<PinCandidate[]> {
  if (!keywords.length) return []
  const sb = createAdminClient()
  const ors = keywords.slice(0, 5).map((kw) => `title.ilike.%${kw.replace(/[%,]/g, '')}%`).join(',')
  if (!ors) return []
  const { data } = await sb
    .from('jimscanner_ggsan_products' as never)
    .select('goods_no, title, image_url, detail_url, price_krw')
    .or(ors)
    .limit(limit)
  return (data ?? []) as unknown as PinCandidate[]
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ horizon?: string }>
}) {
  const sp = await searchParams
  const horizon = parseInt(sp.horizon ?? '30', 10)
  const validHorizon = [30, 60, 90].includes(horizon) ? horizon : 30

  const events = await fetchEvents()
  const now = new Date()
  const today = startOfDayUTC(now)

  // 큐 — 향후 horizon 일 내 anchor 또는 이미 진입창에 들어와 있는 이벤트
  const queue = events
    .filter((e) => e.anchor_month && e.anchor_day)
    .map((e) => {
      const anchor = nextAnchor(now, e.anchor_month!, e.anchor_day!)
      const dToAnchor = daysBetween(today, anchor)
      return { ev: e, anchor, dToAnchor, win: windowOf(dToAnchor, e.lead_days, e.tail_days) }
    })
    .filter(({ dToAnchor, ev }) => dToAnchor <= validHorizon && dToAnchor >= -(ev.tail_days + 7))
    .sort((a, b) => a.dToAnchor - b.dToAnchor)

  // 핀 후보는 큐 상위 6개만 (DB 부담 줄임)
  const pinLookups = await Promise.all(
    queue.slice(0, 6).map((q) => fetchPinCandidates(q.ev.related_keywords, 4)),
  )
  const pinByKey = new Map<string, PinCandidate[]>()
  queue.slice(0, 6).forEach((q, i) => pinByKey.set(q.ev.event_key, pinLookups[i]))

  // 연간 갠트차트 — 12개월 가로 줄
  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))
  const yearEnd = new Date(Date.UTC(today.getUTCFullYear(), 11, 31))
  const yearLen = daysBetween(yearStart, yearEnd) + 1
  const todayOffsetPct = (daysBetween(yearStart, today) / yearLen) * 100

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📅 이벤트 캘린더 — D-day 진입·철수 플래너</h1>
          <p className="text-sm text-gray-500 mt-1">
            한국형 반복 이벤트의 진입권장일(D-{Math.max(...events.map((e) => e.lead_days), 0)} ~ D-7)과 철수권장일(D+tail) 큐.
            <strong className="text-gray-700"> 추천 RPC 의 event_proximity_score 와 연동.</strong>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* horizon 선택 */}
      <div className="flex gap-1">
        {[30, 60, 90].map((h) => (
          <Link
            key={h}
            href={`/admin/trend-radar/calendar?horizon=${h}`}
            className={`px-3 py-1 text-xs rounded ${
              validHorizon === h ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            D+{h}
          </Link>
        ))}
        <div className="ml-auto text-xs text-gray-500 self-center">
          기준일 <code className="font-mono">{fmt(today)}</code> · 활성 이벤트 {events.length}건
        </div>
      </div>

      {/* 연간 갠트 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <div className="text-sm font-semibold">연간 갠트차트 ({today.getUTCFullYear()})</div>
        <div className="relative">
          {/* 월 눈금 */}
          <div className="relative h-5 border-b border-gray-200 mb-2">
            {Array.from({ length: 12 }).map((_, i) => {
              const monthStart = new Date(Date.UTC(today.getUTCFullYear(), i, 1))
              const offsetPct = (daysBetween(yearStart, monthStart) / yearLen) * 100
              return (
                <div
                  key={i}
                  className="absolute top-0 text-[10px] text-gray-400 font-mono"
                  style={{ left: `${offsetPct}%` }}
                >
                  {i + 1}월
                </div>
              )
            })}
          </div>
          {/* 오늘 라인 */}
          <div
            className="absolute top-0 bottom-0 w-px bg-red-400 z-10"
            style={{ left: `${todayOffsetPct}%` }}
            title={`today ${fmt(today)}`}
          />
          {/* 이벤트 바 */}
          <div className="space-y-1.5">
            {events
              .filter((e) => e.anchor_month && e.anchor_day)
              .map((e) => {
                const anchor = new Date(Date.UTC(today.getUTCFullYear(), e.anchor_month! - 1, e.anchor_day!))
                const winStart = new Date(anchor.getTime() - e.lead_days * 86400000)
                const winEnd = new Date(anchor.getTime() + e.tail_days * 86400000)
                const leftPct = Math.max(0, (daysBetween(yearStart, winStart) / yearLen) * 100)
                const widthPct = Math.max(0.5, (daysBetween(winStart, winEnd) / yearLen) * 100)
                const anchorPct = (daysBetween(yearStart, anchor) / yearLen) * 100
                return (
                  <div key={e.id} className="relative h-5 flex items-center">
                    <div className="w-32 text-[11px] text-gray-700 shrink-0 truncate pr-2">{e.event_name}</div>
                    <div className="flex-1 relative h-full">
                      <div
                        className="absolute h-3 top-1 bg-amber-200/70 border border-amber-400 rounded-sm"
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        title={`${fmt(winStart)} ~ ${fmt(winEnd)}`}
                      />
                      <div
                        className="absolute top-0 h-full w-px bg-red-500"
                        style={{ left: `${anchorPct}%` }}
                        title={`anchor ${fmt(anchor)}`}
                      />
                    </div>
                  </div>
                )
              })}
          </div>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 bg-amber-200 border border-amber-400 rounded-sm" /> 진입~철수 윈도우
          </span>
          <span className="flex items-center gap-1">
            <span className="w-px h-3 bg-red-500" /> anchor
          </span>
          <span className="flex items-center gap-1">
            <span className="w-px h-3 bg-red-400" /> 오늘
          </span>
        </div>
      </section>

      {/* D-day 카드 큐 */}
      <section className="space-y-3">
        <div className="text-sm font-semibold">D-day 큐 (향후 {validHorizon}일)</div>
        {queue.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
            기간 내 활성 이벤트 없음 — horizon 을 늘려보세요
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {queue.map((q) => {
              const tone = q.win.tone
              const toneCls = {
                gray: 'border-gray-200',
                amber: 'border-amber-300 bg-amber-50/50',
                red: 'border-red-300 bg-red-50/50',
                emerald: 'border-emerald-300 bg-emerald-50/50',
                rose: 'border-rose-300 bg-rose-50/50',
              }[tone]
              const entryDate = new Date(q.anchor.getTime() - q.ev.lead_days * 86400000)
              const exitDate = new Date(q.anchor.getTime() + q.ev.tail_days * 86400000)
              const pins = pinByKey.get(q.ev.event_key) ?? []
              const liftLabel = q.ev.yoy_lift_median
                ? `×${q.ev.yoy_lift_median.toFixed(1)} (lift, ${q.ev.sample_years}년)`
                : '학습 대기'
              return (
                <div key={q.ev.id} className={`rounded border ${toneCls} p-3 space-y-2`}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-bold">{q.ev.event_name}</div>
                      <div className="text-[11px] text-gray-500 font-mono">{q.ev.event_key}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-mono text-gray-500">{fmt(q.anchor)}</div>
                      <div
                        className={`text-xl font-bold font-mono ${
                          q.dToAnchor < 0 ? 'text-rose-700' : q.dToAnchor <= 7 ? 'text-red-700' : 'text-amber-700'
                        }`}
                      >
                        D{q.dToAnchor >= 0 ? '−' : '+'}
                        {Math.abs(q.dToAnchor)}
                      </div>
                    </div>
                  </div>
                  <div className="text-[11px]">
                    <span className={`inline-block px-2 py-0.5 rounded ${
                      tone === 'red' ? 'bg-red-100 text-red-800' :
                      tone === 'amber' ? 'bg-amber-100 text-amber-800' :
                      tone === 'emerald' ? 'bg-emerald-100 text-emerald-800' :
                      tone === 'rose' ? 'bg-rose-100 text-rose-800' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {q.win.label}
                    </span>
                    <span className="text-gray-500 ml-2">{liftLabel}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-[11px] text-gray-600">
                    <div>
                      <div className="text-[10px] text-gray-400">진입권장</div>
                      <div className="font-mono">{fmt(entryDate)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-400">철수권장</div>
                      <div className="font-mono">{fmt(exitDate)}</div>
                    </div>
                  </div>
                  {q.ev.related_keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {q.ev.related_keywords.slice(0, 5).map((kw) => (
                        <span key={kw} className="text-[10px] bg-white border border-gray-200 px-1.5 py-0.5 rounded text-gray-600">
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                  {pins.length > 0 && (
                    <div className="border-t border-gray-200 pt-2">
                      <div className="text-[10px] text-gray-400 mb-1">핀 후보 ({pins.length})</div>
                      <div className="space-y-1">
                        {pins.slice(0, 3).map((p) => (
                          <a
                            key={p.goods_no}
                            href={p.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener"
                            className="flex items-center gap-2 text-[11px] hover:bg-white/60 rounded px-1 py-0.5"
                          >
                            {p.image_url && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={p.image_url} alt="" className="w-7 h-7 object-cover rounded shrink-0" loading="lazy" />
                            )}
                            <div className="flex-1 min-w-0 truncate">{p.title}</div>
                            {p.price_krw != null && (
                              <span className="font-mono text-gray-500 shrink-0">{p.price_krw.toLocaleString()}원</span>
                            )}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 보너스 합산 공식 (RPC V0.1)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          final_score = ((tv×1.5 + search×1.0) + event_proximity) × imminent_bonus
          <br />
          event_proximity = Σ (window_bonus × similarity(event_keyword, ggsan_title))
          <br />
          window_bonus: pre_window=+0.30 · peak=+0.50 · tail=+0.10 · exit=−0.30
        </code>
        <div className="pt-2">
          학습 갱신: <code className="font-mono">node --env-file=.env.local scripts/learn-event-anchors.mjs</code> (주간 권장)
        </div>
      </section>
    </div>
  )
}
