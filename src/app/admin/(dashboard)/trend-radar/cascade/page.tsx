import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Cascade 보드 · 트렌드 레이더' }

interface CascadeEvent {
  id: string
  category_key: string
  started_at: string
  ended_at: string | null
  top_n: number
  out_of_stock_count: number
  affected_product_ids: string[]
  affected_titles: string[] | null
  recommended_boost_minutes: number | null
  recommended_ad_uplift_pct: number | null
  matched_listing_ids: string[] | null
  matched_trend_product_ids: string[] | null
  is_active: boolean
}

interface CategoryRow {
  category_key: string
  category_label: string
  category_top: string | null
  serp_keyword: string
  top_n: number
  active: boolean
}

interface ListingLite {
  id: string
  registered_title: string
  display_category_name: string | null
  status: string
  list_price_krw: number | null
  estimated_margin_pct: number | null
}

interface TrendProductLite {
  id: string
  canonical_name: string
  category_top: string
}

interface PollRun {
  id: string
  started_at: string
  finished_at: string | null
  categories_checked: number
  snapshots_inserted: number
  events_opened: number
  events_closed: number
  status: string | null
}

async function fetchData() {
  // 신규 테이블 — generated types 갱신 전 임시 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  const [evActive, evRecentClosed, catsRes, lastRun] = await Promise.all([
    sb
      .from('jimscanner_cascade_events')
      .select(
        'id, category_key, started_at, ended_at, top_n, out_of_stock_count, affected_product_ids, affected_titles, recommended_boost_minutes, recommended_ad_uplift_pct, matched_listing_ids, matched_trend_product_ids, is_active',
      )
      .eq('is_active', true)
      .order('started_at', { ascending: false })
      .limit(50),
    sb
      .from('jimscanner_cascade_events')
      .select(
        'id, category_key, started_at, ended_at, top_n, out_of_stock_count, affected_product_ids, affected_titles, recommended_boost_minutes, recommended_ad_uplift_pct, matched_listing_ids, matched_trend_product_ids, is_active',
      )
      .eq('is_active', false)
      .order('started_at', { ascending: false })
      .limit(20),
    sb.from('jimscanner_cascade_categories').select('*'),
    sb
      .from('jimscanner_cascade_poll_runs')
      .select('id, started_at, finished_at, categories_checked, snapshots_inserted, events_opened, events_closed, status')
      .order('started_at', { ascending: false })
      .limit(1),
  ])

  const activeEvents = (evActive.data ?? []) as CascadeEvent[]
  const closedEvents = (evRecentClosed.data ?? []) as CascadeEvent[]
  const categories = (catsRes.data ?? []) as CategoryRow[]
  const run = ((lastRun.data ?? []) as PollRun[])[0] ?? null

  // 매칭 SKU/트렌드 상품 일괄 조회
  const allListingIds = Array.from(
    new Set(activeEvents.flatMap((e) => e.matched_listing_ids ?? [])),
  )
  const allTrendIds = Array.from(
    new Set(activeEvents.flatMap((e) => e.matched_trend_product_ids ?? [])),
  )
  let listingsById = new Map<string, ListingLite>()
  let trendsById = new Map<string, TrendProductLite>()
  if (allListingIds.length > 0) {
    const { data } = await sb
      .from('jimscanner_coupang_listings')
      .select('id, registered_title, display_category_name, status, list_price_krw, estimated_margin_pct')
      .in('id', allListingIds)
    listingsById = new Map(((data ?? []) as ListingLite[]).map((l) => [l.id, l]))
  }
  if (allTrendIds.length > 0) {
    const { data } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', allTrendIds)
    trendsById = new Map(((data ?? []) as TrendProductLite[]).map((t) => [t.id, t]))
  }

  const categoryByKey = new Map(categories.map((c) => [c.category_key, c]))

  return { activeEvents, closedEvents, categoryByKey, categories, listingsById, trendsById, run }
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', { hour12: false })
}

function ageMinutes(iso: string) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000)
}

function fmtDuration(min: number | null) {
  if (!min || min <= 0) return '—'
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`
}

export default async function CascadeBoardPage() {
  const { activeEvents, closedEvents, categoryByKey, categories, listingsById, trendsById, run } =
    await fetchData()

  return (
    <div className="p-6 space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Cascade 수혜타이밍 보드</h1>
        <p className="text-sm text-gray-600">
          카테고리별 쿠팡 SERP Top-N 셀러의 동시 품절·예약발송 전환을 감지해 자사 발행 SKU 가 흡수할
          수 있는 단기 surge 윈도우를 보여줍니다.
        </p>
        <div className="text-xs text-gray-500">
          최근 폴링:{' '}
          {run
            ? `${fmtTime(run.started_at)} · 카테고리 ${run.categories_checked} · 스냅샷 ${run.snapshots_inserted} · open ${run.events_opened} · close ${run.events_closed} · ${run.status ?? '?'}`
            : '아직 실행 기록이 없습니다.'}
        </div>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          🔥 활성 Cascade 이벤트 ({activeEvents.length})
        </h2>
        {activeEvents.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-sm text-gray-500">
            현재 활성 cascade 이벤트가 없습니다. 다음 폴링까지 대기 중.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {activeEvents.map((ev) => {
              const cat = categoryByKey.get(ev.category_key)
              const elapsedMin = ageMinutes(ev.started_at)
              const remaining =
                ev.recommended_boost_minutes != null
                  ? Math.max(ev.recommended_boost_minutes - elapsedMin, 0)
                  : null
              const matchedListings = (ev.matched_listing_ids ?? [])
                .map((id) => listingsById.get(id))
                .filter((x): x is ListingLite => !!x)
              const matchedTrends = (ev.matched_trend_product_ids ?? [])
                .map((id) => trendsById.get(id))
                .filter((x): x is TrendProductLite => !!x)
              return (
                <article
                  key={ev.id}
                  className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 space-y-3"
                >
                  <header className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold">
                        {cat?.category_label ?? ev.category_key}
                      </div>
                      <div className="text-xs text-gray-600">
                        {ev.category_key} · 시작 {fmtTime(ev.started_at)} ({elapsedMin}분 경과)
                      </div>
                    </div>
                    <span className="rounded-full bg-rose-100 text-rose-700 text-xs px-2 py-0.5 font-medium">
                      Top-3 중 {ev.out_of_stock_count}개 OOS
                    </span>
                  </header>

                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="rounded bg-white border border-gray-200 p-2">
                      <div className="text-[11px] text-gray-500">권장 부스트 윈도우</div>
                      <div className="text-sm font-semibold">
                        {fmtDuration(ev.recommended_boost_minutes)}
                      </div>
                      {remaining != null && (
                        <div className="text-[11px] text-gray-500">잔여 {fmtDuration(remaining)}</div>
                      )}
                    </div>
                    <div className="rounded bg-white border border-gray-200 p-2">
                      <div className="text-[11px] text-gray-500">권장 광고비 인상</div>
                      <div className="text-sm font-semibold">
                        +{ev.recommended_ad_uplift_pct ?? 0}%
                      </div>
                    </div>
                    <div className="rounded bg-white border border-gray-200 p-2">
                      <div className="text-[11px] text-gray-500">수혜 SKU</div>
                      <div className="text-sm font-semibold">
                        {matchedListings.length} / 트렌드 {matchedTrends.length}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      영향받은 경쟁 SKU
                    </div>
                    <ul className="text-xs text-gray-700 space-y-1 max-h-24 overflow-y-auto">
                      {(ev.affected_titles ?? []).map((t, i) => {
                        const pid = ev.affected_product_ids[i]
                        return (
                          <li key={`${ev.id}-aff-${i}`} className="truncate">
                            ·{' '}
                            {pid ? (
                              <a
                                href={`https://www.coupang.com/vp/products/${pid}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                {t}
                              </a>
                            ) : (
                              t
                            )}
                          </li>
                        )
                      })}
                      {(!ev.affected_titles || ev.affected_titles.length === 0) && (
                        <li className="text-gray-400">없음</li>
                      )}
                    </ul>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-gray-700 mb-1">
                      매칭된 자사 발행 SKU ({matchedListings.length})
                    </div>
                    {matchedListings.length === 0 ? (
                      <div className="text-xs text-gray-400">매칭된 발행 SKU 없음.</div>
                    ) : (
                      <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
                        {matchedListings.slice(0, 8).map((l) => (
                          <li key={l.id} className="flex items-center justify-between gap-2">
                            <span className="truncate">{l.registered_title}</span>
                            <span className="text-gray-500 shrink-0">
                              {l.list_price_krw != null
                                ? l.list_price_krw.toLocaleString() + '원'
                                : '—'}
                              {l.estimated_margin_pct != null
                                ? ` · 마진 ${l.estimated_margin_pct.toFixed(1)}%`
                                : ''}
                            </span>
                          </li>
                        ))}
                        {matchedListings.length > 8 && (
                          <li className="text-gray-500">+ {matchedListings.length - 8}개 더</li>
                        )}
                      </ul>
                    )}
                  </div>

                  {matchedTrends.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-gray-700 mb-1">
                        트렌드 핀 후보 ({matchedTrends.length})
                      </div>
                      <ul className="text-xs text-gray-600 max-h-20 overflow-y-auto space-y-0.5">
                        {matchedTrends.slice(0, 8).map((t) => (
                          <li key={t.id} className="truncate">· {t.canonical_name}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="text-[11px] text-gray-500 pt-2 border-t border-amber-200">
                    SERP 키워드:{' '}
                    <code className="bg-white px-1 rounded">{cat?.serp_keyword ?? '?'}</code>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">📊 폴링 중인 카테고리 ({categories.length})</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">카테고리</th>
                <th className="px-3 py-2 text-left font-medium">SERP 키워드</th>
                <th className="px-3 py-2 text-left font-medium">Top-N</th>
                <th className="px-3 py-2 text-left font-medium">활성</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.category_key} className="border-t border-gray-200">
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.category_label}</div>
                    <div className="text-xs text-gray-500">{c.category_key}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{c.serp_keyword}</td>
                  <td className="px-3 py-2">{c.top_n}</td>
                  <td className="px-3 py-2">
                    {c.active ? (
                      <span className="text-emerald-700">on</span>
                    ) : (
                      <span className="text-gray-400">off</span>
                    )}
                  </td>
                </tr>
              ))}
              {categories.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-gray-500">
                    카테고리 시드가 없습니다. supabase/cascade_events.sql 을 적용하세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {closedEvents.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">
            🕘 최근 종료된 Cascade ({closedEvents.length})
          </h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">카테고리</th>
                  <th className="px-3 py-2 text-left font-medium">시작</th>
                  <th className="px-3 py-2 text-left font-medium">종료</th>
                  <th className="px-3 py-2 text-left font-medium">지속</th>
                  <th className="px-3 py-2 text-left font-medium">OOS</th>
                </tr>
              </thead>
              <tbody>
                {closedEvents.map((ev) => {
                  const cat = categoryByKey.get(ev.category_key)
                  const dur =
                    ev.ended_at != null
                      ? Math.round(
                          (new Date(ev.ended_at).getTime() - new Date(ev.started_at).getTime()) /
                            60000,
                        )
                      : null
                  return (
                    <tr key={ev.id} className="border-t border-gray-200">
                      <td className="px-3 py-2">{cat?.category_label ?? ev.category_key}</td>
                      <td className="px-3 py-2 text-xs">{fmtTime(ev.started_at)}</td>
                      <td className="px-3 py-2 text-xs">
                        {ev.ended_at ? fmtTime(ev.ended_at) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs">{fmtDuration(dur)}</td>
                      <td className="px-3 py-2">{ev.out_of_stock_count}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="pt-6 border-t border-gray-200 text-xs text-gray-500 space-y-1">
        <div>
          데이터 흐름: <code>/api/cron/competitor-stock-poll</code> →{' '}
          <code>jimscanner_competitor_stock_snapshot</code> →{' '}
          <code>jimscanner_cascade_events</code>
        </div>
        <div>
          로컬 폴링: <code>node scripts/competitor-stock-poll.mjs</code> (CRON_SECRET 필요)
        </div>
        <div>
          <Link href="/admin/trend-radar" className="text-blue-600 hover:underline">
            ← 트렌드 레이더로
          </Link>
        </div>
      </footer>
    </div>
  )
}
