import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MatchRow {
  live_id: string
  platform: 'naver' | 'kakao' | 'coupang' | string
  external_id: string
  product_title: string
  brand: string | null
  category: string | null
  mc: string | null
  scheduled_at: string
  live_image_url: string | null
  live_detail_url: string | null
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  is_imminent: boolean
  cate_cd: string | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  ggsan_last_seen: string
  sim: number
  surge_window_ends_at: string
  hours_until_live: number
}

const SIM_OPTIONS = [
  { v: 0.1, label: '0.10 (느슨)' },
  { v: 0.15, label: '0.15' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30' },
  { v: 0.4, label: '0.40 (엄격)' },
] as const

const WINDOW_OPTIONS = [
  { past: 6, future: 12, label: 'D-12h~D+6h' },
  { past: 24, future: 24, label: 'D-24h~D+24h' },
  { past: 24, future: 48, label: 'D-48h~D+24h (기본)' },
  { past: 48, future: 72, label: 'D-72h~D+48h' },
] as const

const PER_LIVE_LIMIT = 3
const RESULT_LIMIT = 400

async function fetchMatches(opts: {
  past: number
  future: number
  minSim: number
  imminentOnly: boolean
  platform: string | null
}) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    // 마이그레이션 후 가정 — 타입 generate 전
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    'jimscanner_live_ggsan_match' as any,
    {
      past_hours: opts.past,
      future_hours: opts.future,
      min_sim: opts.minSim,
      per_live_limit: PER_LIVE_LIMIT,
      result_limit: RESULT_LIMIT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  )
  if (error) {
    console.error('live_ggsan_match rpc error', error)
    return [] as MatchRow[]
  }
  let rows = (data ?? []) as unknown as MatchRow[]
  if (opts.imminentOnly) rows = rows.filter((r) => r.is_imminent)
  if (opts.platform) rows = rows.filter((r) => r.platform === opts.platform)
  return rows
}

interface Group {
  live_id: string
  platform: string
  product_title: string
  brand: string | null
  category: string | null
  mc: string | null
  scheduled_at: string
  live_image_url: string | null
  live_detail_url: string | null
  hours_until_live: number
  surge_window_ends_at: string
  matches: MatchRow[]
  bestSim: number
  hasImminent: boolean
}

function groupByLive(rows: MatchRow[]): Group[] {
  const map = new Map<string, Group>()
  for (const r of rows) {
    let g = map.get(r.live_id)
    if (!g) {
      g = {
        live_id: r.live_id,
        platform: r.platform,
        product_title: r.product_title,
        brand: r.brand,
        category: r.category,
        mc: r.mc,
        scheduled_at: r.scheduled_at,
        live_image_url: r.live_image_url,
        live_detail_url: r.live_detail_url,
        hours_until_live: Number(r.hours_until_live),
        surge_window_ends_at: r.surge_window_ends_at,
        matches: [],
        bestSim: 0,
        hasImminent: false,
      }
      map.set(r.live_id, g)
    }
    g.matches.push(r)
    if (Number(r.sim) > g.bestSim) g.bestSim = Number(r.sim)
    if (r.is_imminent) g.hasImminent = true
  }
  return [...map.values()].sort((a, b) => {
    // 임박 매칭 우선 → 가장 임박한 라이브 우선 (절댓값 작은 hours_until_live)
    if (a.hasImminent !== b.hasImminent) return a.hasImminent ? -1 : 1
    return Math.abs(a.hours_until_live) - Math.abs(b.hours_until_live)
  })
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
  return '/admin/trend-radar/live-push' + (qs ? `?${qs}` : '')
}

function formatCountdown(hours: number): string {
  const abs = Math.abs(hours)
  const h = Math.floor(abs)
  const m = Math.floor((abs - h) * 60)
  if (hours >= 0) return `D-${h}h ${m}m`
  return `D+${h}h ${m}m (방송 중/완료)`
}

function platformBadge(p: string): { label: string; color: string } {
  switch (p) {
    case 'naver':
      return { label: '네이버 쇼핑라이브', color: 'bg-green-100 text-green-700' }
    case 'kakao':
      return { label: '카카오쇼핑라이브', color: 'bg-yellow-100 text-yellow-800' }
    case 'coupang':
      return { label: '쿠팡라이브', color: 'bg-rose-100 text-rose-700' }
    default:
      return { label: p, color: 'bg-gray-100 text-gray-700' }
  }
}

export default async function LivePushPage({
  searchParams,
}: {
  searchParams: Promise<{
    win?: string
    sim?: string
    imminent?: string
    platform?: string
  }>
}) {
  const sp = await searchParams
  const winIdx = parseInt(sp.win ?? '2', 10)
  const validWinIdx =
    winIdx >= 0 && winIdx < WINDOW_OPTIONS.length ? winIdx : 2
  const win = WINDOW_OPTIONS[validWinIdx]
  const minSim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001)
    ? minSim
    : 0.2
  const imminentOnly = sp.imminent === '1'
  const platform = sp.platform && ['naver', 'kakao', 'coupang'].includes(sp.platform)
    ? sp.platform
    : null

  const current: Record<string, string> = {
    win: String(validWinIdx),
    sim: String(validSim),
    imminent: imminentOnly ? '1' : '',
    platform: platform ?? '',
  }

  const rows = await fetchMatches({
    past: win.past,
    future: win.future,
    minSim: validSim,
    imminentOnly,
    platform,
  })
  const groups = groupByLive(rows)

  const totalMatches = rows.length
  const uniqueLives = groups.length
  const imminentCount = rows.filter((r) => r.is_imminent).length
  const upcomingCount = groups.filter((g) => g.hours_until_live > 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔴 라이브 편성 ↔ ggsan 매칭</h1>
          <p className="text-sm text-gray-500 mt-1">
            네이버 · 카카오 · 쿠팡 라이브커머스 편성 × ggsan 도매가.{' '}
            <strong>편성 후 24h surge 윈도우</strong> 가 위탁 등록 골든타임.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">윈도우</span>
          {WINDOW_OPTIONS.map((w, i) => (
            <Link
              key={i}
              href={buildHref(current, { win: String(i) })}
              className={`px-2 py-1 text-xs rounded ${
                validWinIdx === i
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {w.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">유사도 ≥</span>
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
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">플랫폼</span>
          {(['naver', 'kakao', 'coupang'] as const).map((p) => (
            <Link
              key={p}
              href={buildHref(current, { platform: platform === p ? null : p })}
              className={`px-2 py-1 text-xs rounded ${
                platform === p
                  ? 'bg-amber-100 text-amber-700 font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {platformBadge(p).label}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref(current, { imminent: imminentOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${
            imminentOnly
              ? 'bg-red-100 text-red-700 font-semibold'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {imminentOnly ? '✓ ' : ''}임박특가만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="매칭 row" value={totalMatches} />
        <Kpi label="unique 라이브" value={uniqueLives} />
        <Kpi label="🔥 임박특가 매칭" value={imminentCount} highlight={imminentCount > 0} />
        <Kpi label="향후 예정 라이브" value={upcomingCount} />
      </section>

      {/* 핀 보드 */}
      {groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>조건에 맞는 라이브 ↔ ggsan 매칭 없음</div>
          <div className="text-xs text-gray-400">
            collect-live-commerce cron 이 한 번도 돌지 않았거나, 윈도우 안에 매칭
            가능한 ggsan SKU 가 없습니다. 윈도우/유사도를 넓혀보세요.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const badge = platformBadge(g.platform)
            const upcoming = g.hours_until_live > 0
            return (
              <div
                key={g.live_id}
                className="rounded border border-gray-200 overflow-hidden"
              >
                <div
                  className={`px-4 py-3 flex items-center justify-between flex-wrap gap-2 ${
                    g.hasImminent ? 'bg-red-50' : 'bg-gray-50'
                  }`}
                >
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded ${badge.color}`}
                    >
                      {badge.label}
                    </span>
                    <h3 className="font-semibold text-base">{g.product_title}</h3>
                    {g.brand && (
                      <span className="text-xs text-gray-500">{g.brand}</span>
                    )}
                    <span
                      className={`text-xs font-mono ${
                        upcoming ? 'text-amber-700' : 'text-gray-400'
                      }`}
                    >
                      {formatCountdown(g.hours_until_live)}
                    </span>
                    {g.hasImminent && (
                      <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">
                        🔥 임박특가 매칭
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-2">
                    <span>
                      편성 {g.scheduled_at.slice(5, 16).replace('T', ' ')} · surge ~
                      {g.surge_window_ends_at.slice(5, 16).replace('T', ' ')}
                    </span>
                    {g.live_detail_url && (
                      <a
                        href={g.live_detail_url}
                        target="_blank"
                        rel="noopener"
                        className="underline hover:text-black"
                      >
                        라이브 ↗
                      </a>
                    )}
                  </div>
                </div>

                <div className="divide-y divide-gray-100">
                  {g.matches
                    .sort((a, b) => {
                      if (a.is_imminent !== b.is_imminent) return a.is_imminent ? -1 : 1
                      return Number(b.sim) - Number(a.sim)
                    })
                    .map((m) => (
                      <a
                        key={m.goods_no}
                        href={m.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className="flex items-start gap-3 px-4 py-3 hover:bg-amber-50 transition-colors"
                      >
                        <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                          {m.image_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={m.image_url}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          )}
                          {m.is_imminent && (
                            <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                              임박
                            </span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div
                            className="text-sm font-medium leading-snug line-clamp-2"
                            title={m.ggsan_title}
                          >
                            {m.ggsan_title}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {m.cate_label ?? m.cate_cd} · {m.goods_no}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-base font-bold">
                            {m.price_krw ? (
                              `${m.price_krw.toLocaleString()}원`
                            ) : (
                              <span className="text-gray-400 text-xs">가격 X</span>
                            )}
                          </div>
                          <div className="text-xs font-mono text-gray-400 mt-1">
                            sim {Number(m.sim).toFixed(3)}
                          </div>
                        </div>
                      </a>
                    ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>Surge 윈도우:</strong> 방송 시작 후 24h. 대형 라이브의 SERP·자동완성
          지연 surge 가 이 구간에 집중.
        </div>
        <div>
          <strong>운영 동선:</strong> (1) D-H 카운트다운이 짧은 라이브 우선 → (2)
          ggsan 임박특가 매칭이면 즉시 도매 확보 → (3) 핀 큐에 <code>live-push</code>{' '}
          사유로 등록 → (4) 방송 직후 24h 내 자체 마켓 등록.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded border p-3 ${
        highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'
      }`}
    >
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
