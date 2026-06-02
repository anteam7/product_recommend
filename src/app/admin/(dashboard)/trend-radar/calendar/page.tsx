import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 소싱 리드타임: ggsan 입고 + 쿠팡 승인까지 영업일 기준 보수적 추정.
// 이벤트까지 남은 일수가 이 값보다 작으면 '이벤트 전 등록 불가' = 런웨이 종료.
const SOURCING_LEAD_DAYS = 7

interface EventRow {
  id: string
  name: string
  slug: string
  emoji: string | null
  month: number | null
  day: number | null
  event_date: string | null
  category_tags: string[]
  keyword_tags: string[]
  lead_days: number
  is_active: boolean
  notes: string | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  final_score: number
}

interface MatchedProduct extends ProductRow {
  matched_on: string // 'category' | 'keyword:홍삼' 등
}

interface EventCard {
  event: EventRow
  nextDate: Date
  daysUntil: number
  // 런웨이 게이트
  gate: 'sourcing-window' | 'demand-window' | 'too-late' | 'far-off'
  products: MatchedProduct[]
}

// ── 날짜 헬퍼 (서버 TZ 무관하게 KST 기준 자정으로 정규화) ──────────────
function todayKstMidnight(): Date {
  const now = new Date()
  // KST = UTC+9. UTC 기준 시각에 9시간 더해 KST 날짜를 뽑은 뒤 자정으로 자름.
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()))
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000))
}

// event_date 우선, 없으면 month/day 로 '오늘 이후 가장 가까운 발생일' 계산.
function nextOccurrence(ev: EventRow, today: Date): Date | null {
  if (ev.event_date) {
    const d = new Date(ev.event_date + 'T00:00:00Z')
    return d
  }
  if (ev.month == null || ev.day == null) return null
  const y = today.getUTCFullYear()
  let occ = new Date(Date.UTC(y, ev.month - 1, ev.day))
  if (daysBetween(today, occ) < 0) {
    occ = new Date(Date.UTC(y + 1, ev.month - 1, ev.day))
  }
  return occ
}

function classifyGate(daysUntil: number, leadDays: number): EventCard['gate'] {
  if (daysUntil < SOURCING_LEAD_DAYS) return 'too-late'
  // 수요 선행일 안쪽 = 이미 수요 구간 진입 (등록은 가능하나 늦음)
  if (daysUntil <= leadDays) return 'demand-window'
  // 수요 선행일 ~ +30일: 지금 착수하면 여유롭게 등록 가능 = 골든 소싱창
  if (daysUntil <= leadDays + 30) return 'sourcing-window'
  return 'far-off'
}

const GATE_META: Record<EventCard['gate'], { label: string; cls: string; ring: string }> = {
  'sourcing-window': {
    label: '🟢 소싱 착수 적기',
    cls: 'bg-green-100 text-green-800',
    ring: 'border-green-300 bg-green-50/40',
  },
  'demand-window': {
    label: '🟡 수요 구간 (서둘러 등록)',
    cls: 'bg-amber-100 text-amber-800',
    ring: 'border-amber-300 bg-amber-50/40',
  },
  'too-late': {
    label: '🔴 등록 불가 (리드타임 초과)',
    cls: 'bg-red-100 text-red-700',
    ring: 'border-red-200 bg-red-50/30',
  },
  'far-off': {
    label: '⚪ 대기 (아직 멀음)',
    cls: 'bg-gray-100 text-gray-600',
    ring: 'border-gray-200',
  },
}

function matchProducts(ev: EventRow, products: ProductRow[]): MatchedProduct[] {
  const cats = ev.category_tags.map((c) => c.toLowerCase())
  const kws = ev.keyword_tags
  const out: MatchedProduct[] = []
  for (const p of products) {
    let matchedOn: string | null = null
    // 1) 카테고리 매칭
    const ptop = (p.category_top ?? '').toLowerCase()
    const pmid = (p.category_mid ?? '').toLowerCase()
    if (cats.some((c) => c === ptop || c === pmid)) {
      matchedOn = '카테고리'
    }
    // 2) 키워드 부분일치 (canonical_name)
    if (!matchedOn) {
      const name = p.canonical_name ?? ''
      const hit = kws.find((k) => name.includes(k))
      if (hit) matchedOn = `🔑 ${hit}`
    }
    if (matchedOn) out.push({ ...p, matched_on: matchedOn })
  }
  return out.sort((a, b) => Number(b.final_score) - Number(a.final_score)).slice(0, 8)
}

async function fetchData(): Promise<{ cards: EventCard[]; error: string | null; productCount: number }> {
  const sb = createAdminClient()

  // 이벤트 (테이블이 generated 타입 미반영 — supabase/trends_events_calendar.sql 적용 후 gen:types 시 캐스팅 제거)
  const { data: evData, error: evErr } = await (sb as any)
    .from('jimscanner_trends_events')
    .select('*')
    .eq('is_active', true)
  if (evErr) {
    return { cards: [], error: evErr.message, productCount: 0 }
  }
  const events = (evData ?? []) as EventRow[]

  // 최신 final_score 별 products (opportunity 페이지 패턴 재사용)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latestScore = new Map<string, number>()
  for (const s of (scores ?? []) as { product_id: string; final_score: number }[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latestScore.set(s.product_id, Number(s.final_score))
  }

  let products: ProductRow[] = []
  if (latestScore.size > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid')
      .in('id', Array.from(latestScore.keys()))
    products = ((prods ?? []) as any[]).map((p) => ({
      id: p.id,
      canonical_name: p.canonical_name,
      category_top: p.category_top,
      category_mid: p.category_mid ?? null,
      final_score: latestScore.get(p.id) ?? 0,
    }))
  }

  const today = todayKstMidnight()
  const cards: EventCard[] = []
  for (const ev of events) {
    const nextDate = nextOccurrence(ev, today)
    if (!nextDate) continue
    const daysUntil = daysBetween(today, nextDate)
    cards.push({
      event: ev,
      nextDate,
      daysUntil,
      gate: classifyGate(daysUntil, ev.lead_days),
      products: matchProducts(ev, products),
    })
  }
  cards.sort((a, b) => a.daysUntil - b.daysUntil)

  return { cards, error: null, productCount: products.length }
}

function fmtDate(d: Date): string {
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`
}

export default async function CalendarPage() {
  const { cards, error, productCount } = await fetchData()

  // 런웨이 가로 타임라인 최대 스케일 (D+ 최대값 기준, 최소 120일)
  const maxDays = Math.max(120, ...cards.map((c) => c.daysUntil))

  const sourcingNow = cards.filter((c) => c.gate === 'sourcing-window').length
  const demandNow = cards.filter((c) => c.gate === 'demand-window').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📅 이벤트 런웨이 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            한국 고정 이벤트 D-N 타임라인 · 위탁 리드타임(소싱+승인 ~{SOURCING_LEAD_DAYS}일) 차감으로
            &apos;지금 착수하면 이벤트 전 등록 가능한가&apos; 게이트
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <strong>왜 달력 축인가</strong> · 현 파이프라인은 전부 &apos;이미 떠오른 시그널&apos; 반응형.
        위탁 셀러는 리드타임 때문에 이벤트 D-30 에 소싱을 착수해야 하는데, 시그널이 뜰 때(D-7)는 이미 늦음.
        고정 이벤트는 매년 확정 수요라 선제 발굴 가치가 가장 확실.
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          이벤트 로드 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_trends_events</code> 미적용 가능성. supabase/trends_events_calendar.sql 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="추적 이벤트" value={cards.length} />
        <Kpi label="🟢 소싱 적기" value={sourcingNow} highlight={sourcingNow > 0} />
        <Kpi label="🟡 수요 구간" value={demandNow} />
        <Kpi label="매칭 풀 (상품)" value={productCount} />
      </section>

      {/* 가로 런웨이 타임라인 */}
      {cards.length > 0 && (
        <section className="rounded border border-gray-200 p-4 space-y-2 overflow-x-auto">
          <div className="text-xs font-semibold text-gray-600 mb-2">D-N 런웨이 (오늘 = 왼쪽 끝)</div>
          {cards.map((c) => {
            const pct = Math.min(100, (c.daysUntil / maxDays) * 100)
            const meta = GATE_META[c.gate]
            return (
              <div key={c.event.id} className="flex items-center gap-2">
                <div className="w-28 shrink-0 text-xs text-gray-700 truncate" title={c.event.name}>
                  {c.event.emoji ?? '•'} {c.event.name}
                </div>
                <div className="flex-1 relative h-6 bg-gray-100 rounded">
                  {/* 리드타임 마감선 (이 지점 왼쪽 = 등록 불가) */}
                  <div
                    className="absolute top-0 bottom-0 border-l border-dashed border-red-400"
                    style={{ left: `${Math.min(100, (SOURCING_LEAD_DAYS / maxDays) * 100)}%` }}
                    title={`리드타임 마감선 (D-${SOURCING_LEAD_DAYS})`}
                  />
                  {/* 이벤트 마커 */}
                  <div
                    className={`absolute top-0 bottom-0 w-2 rounded ${
                      c.gate === 'too-late'
                        ? 'bg-red-400'
                        : c.gate === 'demand-window'
                          ? 'bg-amber-500'
                          : c.gate === 'sourcing-window'
                            ? 'bg-green-500'
                            : 'bg-gray-400'
                    }`}
                    style={{ left: `calc(${pct}% - 4px)` }}
                    title={`${fmtDate(c.nextDate)} · D-${c.daysUntil}`}
                  />
                </div>
                <div className="w-14 shrink-0 text-right text-xs font-mono text-gray-700">
                  D-{c.daysUntil}
                </div>
                <div className={`w-40 shrink-0 text-[10px] px-1.5 py-0.5 rounded text-center ${meta.cls}`}>
                  {meta.label}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* 이벤트별 상세 카드 + 매칭 상품 */}
      {cards.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          활성 이벤트 없음. supabase/trends_events_calendar.sql 시드 적용 필요.
        </div>
      ) : (
        <div className="space-y-3">
          {cards.map((c) => {
            const meta = GATE_META[c.gate]
            return (
              <div key={c.event.id} className={`rounded border ${meta.ring} p-4 space-y-3`}>
                <div className="flex items-start justify-between flex-wrap gap-2">
                  <div>
                    <div className="text-base font-semibold">
                      {c.event.emoji ?? '📌'} {c.event.name}
                      <span className="ml-2 text-sm font-mono text-gray-500">
                        {fmtDate(c.nextDate)} · D-{c.daysUntil}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      수요 선행 {c.event.lead_days}일 · 태그{' '}
                      {[...c.event.category_tags, ...c.event.keyword_tags].map((t) => (
                        <span key={t} className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded mr-1 mb-0.5">
                          {t}
                        </span>
                      ))}
                    </div>
                    {c.event.notes && (
                      <div className="text-[11px] text-gray-400 mt-1">{c.event.notes}</div>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-1 rounded font-medium ${meta.cls}`}>{meta.label}</span>
                </div>

                {/* 매칭 상품 (최신 final_score) */}
                {c.products.length === 0 ? (
                  <div className="text-xs text-gray-400 border-t border-gray-100 pt-2">
                    매칭 상품 없음 — trends_products 누적 후 자동 채워짐. (recommend·ggsan 페이지 참고)
                  </div>
                ) : (
                  <div className="border-t border-gray-100 pt-2">
                    <div className="text-[11px] font-semibold text-gray-500 mb-1">
                      매칭 후보 {c.products.length}종 (final_score 순)
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {c.products.map((p) => (
                        <div
                          key={p.id}
                          className="flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1 text-xs"
                          title={p.matched_on}
                        >
                          <span className="font-mono text-amber-700 font-bold">
                            {Number(p.final_score).toFixed(0)}
                          </span>
                          <span className="truncate max-w-[160px]">{p.canonical_name}</span>
                          <span className="text-[10px] text-gray-400">{p.matched_on}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 게이트 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 런웨이 게이트 로직</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          D-N = 다음 발생일까지 남은 일수 (음력 명절은 event_date, 고정일은 month/day)
          <br />
          🔴 too-late : D-N &lt; {SOURCING_LEAD_DAYS} (소싱+쿠팡 승인 리드타임 초과 → 이벤트 전 등록 불가)
          <br />
          🟡 demand-window : {SOURCING_LEAD_DAYS} ≤ D-N ≤ lead_days (이미 수요 구간 — 서둘러 등록)
          <br />
          🟢 sourcing-window : lead_days &lt; D-N ≤ lead_days+30 (지금 착수하면 여유 등록 = 골든 타이밍)
          <br />⚪ far-off : 그 이상 (대기)
        </code>
        <div className="pt-2">
          <strong>자기검증 (데이터 누적 후):</strong> 작년 동(同)이벤트 ±2주 trends_scores 스파이크로
          category_tags 적중을 검증 → lead_days 보정.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-green-300 bg-green-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-green-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
