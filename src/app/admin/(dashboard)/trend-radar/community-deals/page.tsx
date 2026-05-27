import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MatchRow {
  quasar_id: string
  deal_title: string
  deal_clean_title: string
  site_label: string | null
  source_url: string
  reply_count: number | null
  reply_velocity: number | string | null
  hours_since_post: number | string | null
  posted_at: string | null
  captured_at: string
  sold_out: boolean
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  is_imminent: boolean
  cate_cd: string | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  sim: number | string
}

interface DealRow {
  quasar_id: string
  title: string
  clean_title: string
  site_label: string | null
  source_url: string
  reply_count: number | null
  reply_velocity: number | string | null
  hours_since_post: number | string | null
  posted_at: string | null
  captured_at: string
  sold_out: boolean
}

const SIM_OPTIONS = [
  { v: 0.12, label: '0.12 (느슨)' },
  { v: 0.18, label: '0.18 (기본)' },
  { v: 0.25, label: '0.25' },
  { v: 0.35, label: '0.35 (엄격)' },
] as const

const DAYS_OPTIONS = [
  { v: 1, label: '24h' },
  { v: 3, label: '3일' },
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
] as const

const VELOCITY_OPTIONS = [
  { v: 0, label: '전체' },
  { v: 1, label: '≥ 1' },
  { v: 3, label: '≥ 3' },
  { v: 10, label: '≥ 10' },
] as const

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchMatches(opts: { days: number; minSim: number; minVelocity: number }): Promise<MatchRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_quasar_ggsan_match' as never,
    {
      days_window: opts.days,
      min_sim: opts.minSim,
      per_deal_limit: 3,
      result_limit: 400,
      min_velocity: opts.minVelocity,
    } as never,
  )
  if (error) {
    console.error('quasar_ggsan_match rpc error', error)
    return []
  }
  return (data ?? []) as MatchRow[]
}

async function fetchDeals(opts: { days: number; minVelocity: number }): Promise<DealRow[]> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - opts.days * 86_400_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_quasar_deals' as never)
    .select(
      'quasar_id, title, clean_title, site_label, source_url, reply_count, reply_velocity, hours_since_post, posted_at, captured_at, sold_out',
    )
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(500)
  if (error) {
    console.error('quasar_deals fetch error', error)
    return []
  }
  return ((data ?? []) as unknown as DealRow[]).filter((d) => {
    const v = toNum(d.reply_velocity)
    return v == null || v >= opts.minVelocity
  })
}

interface DealGroup {
  quasar_id: string
  deal_title: string
  deal_clean_title: string
  site_label: string | null
  source_url: string
  reply_count: number | null
  reply_velocity: number | null
  hours_since_post: number | null
  posted_at: string | null
  captured_at: string
  sold_out: boolean
  matches: MatchRow[]
  bestSim: number
  hasImminent: boolean
}

function groupByDeal(rows: MatchRow[]): DealGroup[] {
  const map = new Map<string, DealGroup>()
  for (const r of rows) {
    let g = map.get(r.quasar_id)
    if (!g) {
      g = {
        quasar_id: r.quasar_id,
        deal_title: r.deal_title,
        deal_clean_title: r.deal_clean_title,
        site_label: r.site_label,
        source_url: r.source_url,
        reply_count: r.reply_count,
        reply_velocity: toNum(r.reply_velocity),
        hours_since_post: toNum(r.hours_since_post),
        posted_at: r.posted_at,
        captured_at: r.captured_at,
        sold_out: r.sold_out,
        matches: [],
        bestSim: 0,
        hasImminent: false,
      }
      map.set(r.quasar_id, g)
    }
    g.matches.push(r)
    const sim = toNum(r.sim) ?? 0
    if (sim > g.bestSim) g.bestSim = sim
    if (r.is_imminent) g.hasImminent = true
  }
  return [...map.values()].sort((a, b) => {
    if (a.hasImminent !== b.hasImminent) return a.hasImminent ? -1 : 1
    const av = a.reply_velocity ?? 0
    const bv = b.reply_velocity ?? 0
    if (av !== bv) return bv - av
    return b.bestSim - a.bestSim
  })
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/community-deals' + (qs ? `?${qs}` : '')
}

function classifyQuadrant(d: { reply_velocity: number | null; hours_since_post: number | null; hasGgsan: boolean }) {
  const v = d.reply_velocity ?? 0
  const isHot = v >= 3
  const isFresh = d.hours_since_post != null && d.hours_since_post <= 24
  if (isHot && d.hasGgsan && isFresh) return 'jackpot' as const
  if (isHot && d.hasGgsan) return 'sourceable' as const
  if (isHot && isFresh) return 'demand-only' as const
  return 'background' as const
}

const QUADRANT_LABEL: Record<ReturnType<typeof classifyQuadrant>, { label: string; cls: string }> = {
  jackpot:      { label: '🎯 잭팟 (속도×재고×신선)', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  sourceable:   { label: '📦 소싱가능 (속도×재고)', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
  'demand-only':{ label: '🔥 수요만 (속도×신선)',   cls: 'bg-rose-100 text-rose-800 border-rose-300' },
  background:   { label: '· 배경',                   cls: 'bg-gray-100 text-gray-600 border-gray-200' },
}

export default async function CommunityDealsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; velocity?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '3', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 3
  const minSim = parseFloat(sp.sim ?? '0.18')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001) ? minSim : 0.18
  const velocity = parseFloat(sp.velocity ?? '0')
  const validVelocity = VELOCITY_OPTIONS.some((v) => Math.abs(v.v - velocity) < 0.001) ? velocity : 0

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    velocity: String(validVelocity),
  }

  const [matchRows, allDeals] = await Promise.all([
    fetchMatches({ days: validDays, minSim: validSim, minVelocity: validVelocity }),
    fetchDeals({ days: validDays, minVelocity: validVelocity }),
  ])

  const groups = groupByDeal(matchRows)
  const matchedIds = new Set(groups.map((g) => g.quasar_id))

  // 사분면 집계 (전체 deal 대상)
  const counts = { jackpot: 0, sourceable: 0, 'demand-only': 0, background: 0 } as Record<
    ReturnType<typeof classifyQuadrant>,
    number
  >
  for (const d of allDeals) {
    const q = classifyQuadrant({
      reply_velocity: toNum(d.reply_velocity),
      hours_since_post: toNum(d.hours_since_post),
      hasGgsan: matchedIds.has(d.quasar_id),
    })
    counts[q]++
  }

  const totalDeals = allDeals.length
  const withVelocity = allDeals.filter((d) => toNum(d.reply_velocity) != null).length
  const soldOutCount = allDeals.filter((d) => d.sold_out).length

  // velocity 상위 10건 — ggsan 매칭이 없어도 보여줌 (수요 시그널 자체로 가치)
  const topVelocity = [...allDeals]
    .filter((d) => toNum(d.reply_velocity) != null)
    .sort((a, b) => (toNum(b.reply_velocity) ?? 0) - (toNum(a.reply_velocity) ?? 0))
    .slice(0, 10)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⚡ 커뮤니티 핫딜 ↔ ggsan 매칭</h1>
          <p className="text-sm text-gray-500 mt-1">
            퀘이사존 핫딜 <strong>reply-velocity</strong> (replies/h) × ggsan 도매재고 × 24h 신규 사분면.
            진행중 댓글 폭주는 실수요의 직접 증거입니다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-fuchsia-100 text-fuchsia-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">유사도 ≥</span>
          {SIM_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sim: String(s.v) })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-fuchsia-100 text-fuchsia-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">댓글속도</span>
          {VELOCITY_OPTIONS.map((v) => (
            <Link
              key={v.v}
              href={buildHref(current, { velocity: String(v.v) })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(validVelocity - v.v) < 0.001 ? 'bg-fuchsia-100 text-fuchsia-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {v.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="수집된 핫딜" value={totalDeals} />
        <Kpi label="velocity 산출됨" value={`${withVelocity}/${totalDeals}`} />
        <Kpi label="🎯 잭팟" value={counts.jackpot} highlight={counts.jackpot > 0} />
        <Kpi label="📦 소싱가능" value={counts.sourceable} />
      </section>

      {/* 사분면 분포 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(Object.keys(QUADRANT_LABEL) as Array<keyof typeof QUADRANT_LABEL>).map((q) => (
          <div key={q} className={`rounded border p-3 ${QUADRANT_LABEL[q].cls}`}>
            <div className="text-xs font-semibold">{QUADRANT_LABEL[q].label}</div>
            <div className="text-2xl font-bold mt-1 tabular-nums">{counts[q]}</div>
          </div>
        ))}
      </section>

      {/* velocity 상위 10 (ggsan 매칭 무관) */}
      {topVelocity.length > 0 && (
        <section className="rounded border border-gray-200">
          <div className="bg-gray-50 px-4 py-2 border-b text-sm font-semibold text-gray-800">
            🔥 reply-velocity 상위 10건 (도매재고 매칭 여부 표시)
          </div>
          <div className="divide-y divide-gray-100">
            {topVelocity.map((d) => {
              const hasGgsan = matchedIds.has(d.quasar_id)
              const v = toNum(d.reply_velocity)
              const h = toNum(d.hours_since_post)
              const isFresh = h != null && h <= 24
              return (
                <div key={d.quasar_id} className="px-4 py-2 flex items-start gap-3 hover:bg-fuchsia-50/30">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {d.site_label && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700">
                          {d.site_label}
                        </span>
                      )}
                      {d.sold_out && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-300 text-gray-700">
                          품절
                        </span>
                      )}
                      {isFresh && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
                          신규 24h
                        </span>
                      )}
                      {hasGgsan && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                          ggsan 재고
                        </span>
                      )}
                    </div>
                    <a
                      href={d.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-gray-900 hover:text-blue-600 hover:underline line-clamp-1 mt-0.5"
                    >
                      {d.clean_title || d.title}
                    </a>
                  </div>
                  <div className="text-right shrink-0 text-xs">
                    <div className="font-mono font-bold text-fuchsia-700">
                      {v != null ? `${v.toFixed(2)} /h` : '—'}
                    </div>
                    <div className="text-gray-500">
                      💬 {d.reply_count ?? '—'} · {h != null ? `${h.toFixed(1)}h 경과` : '경과 ?'}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 매칭 그룹: deal 단위 */}
      {groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>매칭된 ggsan 도매재고 없음</div>
          <div className="text-xs text-gray-400">
            기간을 늘리거나 유사도 임계값을 낮춰 보세요. ggsan 카탈로그가 비어 있으면 결과가 안 나옵니다.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const quadrant = classifyQuadrant({
              reply_velocity: g.reply_velocity,
              hours_since_post: g.hours_since_post,
              hasGgsan: true,
            })
            const qmeta = QUADRANT_LABEL[quadrant]
            return (
              <div key={g.quasar_id} className="rounded border border-gray-200 overflow-hidden">
                <div className={`px-4 py-3 flex items-center justify-between flex-wrap gap-2 border-b ${qmeta.cls.replace('text-', 'border-').split(' ').filter((c) => c.startsWith('bg-')).join(' ') || 'bg-gray-50'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${qmeta.cls}`}>
                        {qmeta.label}
                      </span>
                      {g.site_label && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700">
                          {g.site_label}
                        </span>
                      )}
                      {g.sold_out && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-300 text-gray-700">
                          품절
                        </span>
                      )}
                      {g.hasImminent && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white">
                          🔥 임박특가 매칭
                        </span>
                      )}
                    </div>
                    <a
                      href={g.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-base text-gray-900 hover:text-blue-600 hover:underline line-clamp-1"
                    >
                      {g.deal_clean_title || g.deal_title}
                    </a>
                    <div className="text-xs text-gray-600 mt-0.5 flex items-center gap-3 flex-wrap font-mono">
                      <span className="text-fuchsia-700 font-bold">
                        {g.reply_velocity != null ? `${g.reply_velocity.toFixed(2)} /h` : 'velocity —'}
                      </span>
                      <span>💬 {g.reply_count ?? '—'}</span>
                      <span>{g.hours_since_post != null ? `${g.hours_since_post.toFixed(1)}h 경과` : ''}</span>
                      <span className="text-gray-400">sim best {g.bestSim.toFixed(3)}</span>
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-gray-100">
                  {g.matches
                    .slice()
                    .sort((a, b) => {
                      if (a.is_imminent !== b.is_imminent) return a.is_imminent ? -1 : 1
                      return (toNum(b.sim) ?? 0) - (toNum(a.sim) ?? 0)
                    })
                    .map((m) => {
                      const marginSimUrl = `/admin/trend-radar/recommend?goods_no=${encodeURIComponent(m.goods_no)}`
                      return (
                        <div
                          key={m.goods_no}
                          className="flex items-start gap-3 px-4 py-3 hover:bg-fuchsia-50/30 transition-colors"
                        >
                          <a
                            href={m.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative"
                          >
                            {m.image_url && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={m.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                            )}
                            {m.is_imminent && (
                              <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                                임박
                              </span>
                            )}
                          </a>
                          <div className="flex-1 min-w-0">
                            <a
                              href={m.detail_url ?? '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm font-medium leading-snug line-clamp-2 hover:text-blue-600 hover:underline"
                              title={m.ggsan_title}
                            >
                              {m.ggsan_title}
                            </a>
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
                              sim {(toNum(m.sim) ?? 0).toFixed(3)}
                            </div>
                            <Link
                              href={marginSimUrl}
                              className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                            >
                              마진 시뮬 →
                            </Link>
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>reply_velocity = replies / hours_since_post.</strong>{' '}
          posted_at 이 metadata 에 없는 옛 row 는 captured_at 으로 보정하므로 보수적으로 낮게 잡힙니다.
        </div>
        <div>
          <strong>사분면:</strong> 잭팟 = velocity≥3 × ggsan 재고 × 24h 신규 / 소싱가능 = velocity≥3 × ggsan 재고 / 수요만 = velocity≥3 × 24h 신규.
        </div>
        <div className="text-gray-400">
          품절: {soldOutCount}건. 매칭은 pg_trgm similarity (오타·어순 무관 부분 일치). 카탈로그가 비어 있으면 매칭 0.
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
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
