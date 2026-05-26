import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface WinnerRow {
  winner_id: string
  announcement_date: string
  comparison_topic: string
  category_mid: string | null
  rank: number
  brand: string
  full_name: string
  evaluation_dimensions: Record<string, string> | null
  seo_handle: string | null
  trust_signal_until: string | null
  source_url: string

  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  ggsan_detail_url: string | null
  ggsan_image_url: string | null
  ggsan_is_imminent: boolean | null
  sim: number | null

  trend_keyword: string | null
  trend_volume: number | null
  trend_source: string | null
  trend_collected_at: string | null
}

const WINDOW_OPTIONS = [
  { v: 30,  label: '30일' },
  { v: 90,  label: '90일' },
  { v: 180, label: '180일 (기본)' },
  { v: 365, label: '1년' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.20, label: '0.20 (기본)' },
  { v: 0.30, label: '0.30' },
  { v: 0.40, label: '0.40 (엄격)' },
] as const

async function fetchWinners(opts: {
  daysWindow: number
  minSim: number
  activeOnly: boolean
}): Promise<WinnerRow[]> {
  const sb = createAdminClient()
  // 마이그레이션 미적용 환경에서도 빌드되도록 `as any` 캐스팅 (RPC 타입 미생성)
  // 적용 후 generate-types 시점에 해제.
  const { data, error } = await (sb as any).rpc('jimscanner_kca_winners_matched', {
    days_window: opts.daysWindow,
    min_sim: opts.minSim,
    trend_days: 30,
    active_only: opts.activeOnly,
  })
  if (error) {
    console.error('kca_winners_matched rpc error', error)
    return []
  }
  return (data ?? []) as WinnerRow[]
}

async function fetchMeta() {
  const sb = createAdminClient()
  const [{ count: totalWinners }, { data: lastRaw }] = await Promise.all([
    (sb as any).from('jimscanner_kca_winners').select('*', { count: 'exact', head: true }),
    sb
      .from('jimscanner_market_raw')
      .select('captured_at, title')
      .eq('source', 'kca_comparative')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  return {
    totalWinners: (totalWinners as number | null) ?? 0,
    lastRaw,
  }
}

function buildHref(
  current: Record<string, string>,
  override: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/kca-winners' + (qs ? `?${qs}` : '')
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso + 'T00:00:00').getTime()
  const now = Date.now()
  return Math.floor((t - now) / (1000 * 60 * 60 * 24))
}

function rankBadge(rank: number): { label: string; cls: string } {
  if (rank === 1) return { label: '🥇 소비자원 1위', cls: 'bg-amber-100 text-amber-800 border-amber-300' }
  if (rank === 2) return { label: '🥈 2위', cls: 'bg-gray-100 text-gray-700 border-gray-300' }
  if (rank === 3) return { label: '🥉 3위', cls: 'bg-orange-100 text-orange-700 border-orange-300' }
  return { label: `${rank}위`, cls: 'bg-gray-50 text-gray-500 border-gray-200' }
}

export default async function KcaWinnersPage({
  searchParams,
}: {
  searchParams: Promise<{
    window?: string
    sim?: string
    active?: string
    cat?: string
    ggsan?: string
  }>
}) {
  const sp = await searchParams
  const daysWindow = parseInt(sp.window ?? '180', 10)
  const validWindow = WINDOW_OPTIONS.some((w) => w.v === daysWindow) ? daysWindow : 180
  const minSim = parseFloat(sp.sim ?? '0.20')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001) ? minSim : 0.20
  const activeOnly = sp.active !== '0'
  const catFilter = sp.cat ?? ''
  const ggsanOnly = sp.ggsan === '1'

  const current: Record<string, string> = {
    window: String(validWindow),
    sim: String(validSim),
    active: activeOnly ? '' : '0',
    cat: catFilter,
    ggsan: ggsanOnly ? '1' : '',
  }

  const [rows, meta] = await Promise.all([
    fetchWinners({ daysWindow: validWindow, minSim: validSim, activeOnly }),
    fetchMeta(),
  ])

  // 카테고리 집계
  const catCounts = new Map<string, number>()
  for (const r of rows) {
    if (!r.category_mid) continue
    catCounts.set(r.category_mid, (catCounts.get(r.category_mid) ?? 0) + 1)
  }
  const categories = [...catCounts.entries()].sort((a, b) => b[1] - a[1])

  // 필터 적용
  let filtered = rows
  if (catFilter) filtered = filtered.filter((r) => r.category_mid === catFilter)
  if (ggsanOnly) filtered = filtered.filter((r) => r.ggsan_goods_no != null)

  const totalAll = rows.length
  const withGgsan = rows.filter((r) => r.ggsan_goods_no != null).length
  const withTrend = rows.filter((r) => r.trend_keyword != null).length
  const triplePass = rows.filter(
    (r) => r.ggsan_goods_no != null && r.trend_keyword != null,
  ).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">KCA 비교공감 Winner 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            한국소비자원이 보증한 1~3위 SKU. <strong>정부 인증 + ggsan 위탁 가능 + 검색량 상승</strong> 3중 게이트.
            발표일로부터 3-6개월간 '소비자원 1위 [카테고리]' 검색 트래픽 지속.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {/* 카운터 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded border border-gray-200 px-4 py-3">
          <div className="text-xs text-gray-500">누적 Winner</div>
          <div className="text-2xl font-bold">{meta.totalWinners.toLocaleString()}</div>
          <div className="text-[10px] text-gray-400 mt-1">
            마지막 raw: {meta.lastRaw?.captured_at?.slice(0, 16)?.replace('T', ' ') ?? '없음'}
          </div>
        </div>
        <div className="rounded border border-gray-200 px-4 py-3">
          <div className="text-xs text-gray-500">현재 활성 (창 안)</div>
          <div className="text-2xl font-bold">{totalAll}</div>
        </div>
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-xs text-amber-700">ggsan 매칭</div>
          <div className="text-2xl font-bold text-amber-800">{withGgsan}</div>
          <div className="text-[10px] text-amber-600 mt-1">위탁 가능 후보</div>
        </div>
        <div className="rounded border border-green-300 bg-green-50 px-4 py-3">
          <div className="text-xs text-green-700">3중 게이트 통과</div>
          <div className="text-2xl font-bold text-green-800">{triplePass}</div>
          <div className="text-[10px] text-green-600 mt-1">
            정부 + ggsan + 트렌드({withTrend})
          </div>
        </div>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">발표 창</span>
          {WINDOW_OPTIONS.map((w) => (
            <Link
              key={w.v}
              href={buildHref(current, { window: String(w.v) })}
              className={`px-2 py-1 text-xs rounded ${
                validWindow === w.v
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {w.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">ggsan 유사도</span>
          {SIM_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sim: String(s.v) })}
              className={`px-2 py-1 text-xs rounded ${
                Math.abs(validSim - s.v) < 0.001
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref(current, { ggsan: ggsanOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${
            ggsanOnly
              ? 'bg-amber-200 text-amber-900 font-semibold'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {ggsanOnly ? '✓ ' : ''}ggsan 매칭만
        </Link>
        <Link
          href={buildHref(current, { active: activeOnly ? '0' : null })}
          className={`px-3 py-1 text-xs rounded ${
            activeOnly
              ? 'bg-green-100 text-green-700 font-semibold'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {activeOnly ? '✓ ' : ''}진입 창 활성만
        </Link>
      </div>

      {/* 카테고리 탭 */}
      {categories.length > 0 && (
        <nav className="flex flex-wrap gap-1 border-b border-gray-200">
          <Link
            href={buildHref(current, { cat: null })}
            className={`px-3 py-2 text-sm border-b-2 ${
              catFilter === ''
                ? 'border-amber-500 font-semibold'
                : 'border-transparent text-gray-500 hover:text-black'
            }`}
          >
            전체 <span className="text-xs text-gray-400">{totalAll}</span>
          </Link>
          {categories.map(([cat, n]) => (
            <Link
              key={cat}
              href={buildHref(current, { cat })}
              className={`px-3 py-2 text-sm border-b-2 ${
                catFilter === cat
                  ? 'border-amber-500 font-semibold'
                  : 'border-transparent text-gray-500 hover:text-black'
              }`}
            >
              {cat} <span className="text-xs text-gray-400">{n}</span>
            </Link>
          ))}
        </nav>
      )}

      <div className="text-xs text-gray-500">{filtered.length.toLocaleString()}건 표시</div>

      {/* 카드 그리드 */}
      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {meta.totalWinners === 0
            ? '아직 정형화된 Winner 가 없습니다. /api/cron/collect-kca-comparative 가 raw 를 수집하고, 후속 LLM 정형화 cron 이 jimscanner_kca_winners 를 채웁니다.'
            : '조건에 맞는 Winner 없음 — 필터를 완화해 보세요.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((w) => {
            const rb = rankBadge(w.rank)
            const dday = daysUntil(w.trust_signal_until)
            const dims = w.evaluation_dimensions ?? {}
            const dimEntries = Object.entries(dims).slice(0, 4)
            const triplePass = !!w.ggsan_goods_no && !!w.trend_keyword
            return (
              <article
                key={w.winner_id}
                className={`rounded border ${
                  triplePass ? 'border-green-400 shadow-sm' : 'border-gray-200'
                } overflow-hidden flex flex-col`}
              >
                {/* 헤더 */}
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded border ${rb.cls}`}
                  >
                    {rb.label}
                  </span>
                  <span className="text-xs text-gray-500 font-mono">
                    {w.announcement_date}
                  </span>
                </div>

                {/* 본문 */}
                <div className="p-4 space-y-3 flex-1">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">{w.comparison_topic}</div>
                    <div className="text-base font-bold leading-snug">{w.full_name}</div>
                    <div className="text-xs text-gray-400 mt-1">
                      {w.brand} · {w.category_mid ?? '미분류'}
                    </div>
                  </div>

                  {/* 평가 차원 */}
                  {dimEntries.length > 0 && (
                    <div className="rounded bg-gray-50 px-3 py-2 space-y-1">
                      <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide">
                        검증 차원
                      </div>
                      {dimEntries.map(([k, v]) => (
                        <div key={k} className="flex justify-between text-xs">
                          <span className="text-gray-600">{k}</span>
                          <span className="font-medium text-gray-900">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* SEO 핸들 */}
                  {w.seo_handle && (
                    <div className="rounded bg-blue-50 px-3 py-2">
                      <div className="text-[10px] text-blue-700 font-semibold uppercase">
                        SEO 핸들
                      </div>
                      <div className="text-sm font-mono text-blue-900 break-all">
                        {w.seo_handle}
                      </div>
                    </div>
                  )}

                  {/* ggsan 매칭 */}
                  {w.ggsan_goods_no ? (
                    <a
                      href={w.ggsan_detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="block rounded border border-amber-300 bg-amber-50 px-3 py-2 hover:bg-amber-100"
                    >
                      <div className="text-[10px] text-amber-700 font-semibold uppercase flex items-center justify-between">
                        <span>ggsan 위탁 가능</span>
                        <span className="text-amber-600">
                          sim {w.sim != null ? Number(w.sim).toFixed(2) : '-'}
                          {w.ggsan_is_imminent && ' · 임박'}
                        </span>
                      </div>
                      <div className="text-xs text-amber-900 line-clamp-2 mt-1">
                        {w.ggsan_title}
                      </div>
                      {w.ggsan_price_krw && (
                        <div className="text-sm font-bold text-amber-900 mt-1">
                          {w.ggsan_price_krw.toLocaleString()}원
                        </div>
                      )}
                    </a>
                  ) : (
                    <div className="rounded border border-dashed border-gray-200 px-3 py-2 text-xs text-gray-400 text-center">
                      ggsan 매칭 없음
                    </div>
                  )}

                  {/* 트렌드 시그널 */}
                  {w.trend_keyword && (
                    <div className="rounded bg-green-50 px-3 py-2">
                      <div className="text-[10px] text-green-700 font-semibold uppercase flex items-center justify-between">
                        <span>검색 시그널</span>
                        <span className="text-green-600">{w.trend_source}</span>
                      </div>
                      <div className="text-xs text-green-900 mt-1 truncate">
                        {w.trend_keyword}
                        {w.trend_volume != null && ` · ${Number(w.trend_volume).toFixed(1)}`}
                      </div>
                    </div>
                  )}
                </div>

                {/* 푸터: D-day + 원문 링크 */}
                <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between text-xs">
                  <span
                    className={
                      dday == null
                        ? 'text-gray-400'
                        : dday > 60
                          ? 'text-green-700 font-semibold'
                          : dday > 0
                            ? 'text-amber-700 font-semibold'
                            : 'text-red-700'
                    }
                  >
                    {dday == null
                      ? '진입 창 미정'
                      : dday > 0
                        ? `진입 창 D-${dday}`
                        : `만료 D+${-dday}`}
                  </span>
                  <a
                    href={w.source_url}
                    target="_blank"
                    rel="noopener"
                    className="text-gray-500 hover:text-black underline"
                  >
                    원문 ↗
                  </a>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
