import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RecommendRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  ggsan_last_seen: string

  tv_score: number
  search_score: number
  raw_score: number
  imminent_bonus: number
  price_drop_bonus: number | null
  final_score: number

  tv_match_count: number
  tv_top_keyword: string
  tv_total_pushes: number
  search_match_count: number
  search_top_keyword: string
  search_sources: string[]

  price_delta_7d_pct: number | null
  price_delta_30d_pct: number | null
  lowest_price_in_30d: number | null
}

interface SparkPoint {
  observed_day: string
  price_krw: number
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

const DROP_OPTIONS = [
  { v: 0, label: '전체' },
  { v: -5, label: '-5%↓' },
  { v: -10, label: '-10%↓ (기본)' },
  { v: -20, label: '-20%↓' },
] as const

async function fetchRecommend(opts: { days: number }) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: opts.days,
    min_sim: 0.2,
    min_score: 0.0,
    result_limit: 500,
  } as never)
  if (error) return { rows: [] as RecommendRow[], error: error.message }
  return { rows: (data ?? []) as RecommendRow[], error: null as string | null }
}

async function fetchSparklines(goodsNos: string[]) {
  if (goodsNos.length === 0) return new Map<string, SparkPoint[]>()
  const sb = createAdminClient()
  const map = new Map<string, SparkPoint[]>()
  // 병렬 호출 — 최대 30개
  const targets = goodsNos.slice(0, 30)
  const results = await Promise.all(
    targets.map(async (g) => {
      const { data } = await sb.rpc('jimscanner_ggsan_price_sparkline' as never, {
        p_goods_no: g,
        p_days: 30,
      } as never)
      return [g, ((data ?? []) as SparkPoint[])] as const
    })
  )
  for (const [g, pts] of results) map.set(g, pts)
  return map
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/price-momentum' + (qs ? `?${qs}` : '')
}

function Sparkline({ points, currentPrice }: { points: SparkPoint[]; currentPrice: number | null }) {
  if (points.length < 2) {
    return (
      <div className="h-8 w-28 flex items-center justify-center text-[10px] text-gray-400">
        시계열 부족
      </div>
    )
  }
  const W = 112
  const H = 32
  const prices = points.map((p) => Number(p.price_krw))
  if (currentPrice != null) prices.push(currentPrice)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 1
  const step = points.length > 1 ? W / (points.length - 1) : W
  const coords = points.map((p, i) => {
    const x = i * step
    const y = H - ((Number(p.price_krw) - min) / range) * H
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const first = Number(points[0].price_krw)
  const last = Number(points[points.length - 1].price_krw)
  const stroke = last < first ? '#059669' : last > first ? '#e11d48' : '#6b7280'
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={(points.length - 1) * step}
        cy={H - ((last - min) / range) * H}
        r={2}
        fill={stroke}
      />
    </svg>
  )
}

function PriceDeltaBadge({ pct, window }: { pct: number; window: '7d' | '30d' }) {
  const v = Number(pct)
  const isDown = v < 0
  const isFlat = Math.abs(v) < 0.5
  if (isFlat) return <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600 font-mono">– ({window})</span>
  const arrow = isDown ? '▼' : '▲'
  const cls = isDown ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
  return (
    <span className={`px-2 py-0.5 rounded font-mono ${cls}`}>
      {arrow}{Math.abs(v).toFixed(1)}% <span className="opacity-60">({window})</span>
    </span>
  )
}

export default async function PriceMomentumPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; drop?: string; signal?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const dropThreshold = parseInt(sp.drop ?? '-10', 10)
  const validDrop = DROP_OPTIONS.some((d) => d.v === dropThreshold) ? dropThreshold : -10
  const signalOnly = sp.signal !== '0'

  const current: Record<string, string> = {
    days: String(validDays),
    drop: String(validDrop),
    signal: signalOnly ? '' : '0',
  }

  const { rows: allRows, error } = await fetchRecommend({ days: validDays })

  // 1차 필터: 가격 시계열이 있는 상품만
  let rows = allRows.filter((r) => r.price_delta_7d_pct != null || r.price_delta_30d_pct != null)

  // 2차 필터: 7일 하락폭이 임계 이하 (validDrop=-10 이면 d7_pct <= -10)
  if (validDrop < 0) {
    rows = rows.filter((r) => {
      const d7 = r.price_delta_7d_pct
      const d30 = r.price_delta_30d_pct
      const best = d7 != null ? d7 : d30
      return best != null && best <= validDrop
    })
  }

  // 3차 필터: signal_only — TV 또는 검색 매칭이 1건 이상
  if (signalOnly) {
    rows = rows.filter((r) => r.tv_match_count > 0 || r.search_match_count > 0)
  }

  // 정렬: 1) 신호 동시 발생 우선, 2) 7일 하락률 큰 순, 3) final_score
  rows = rows.slice().sort((a, b) => {
    const aSig = (a.tv_match_count > 0 ? 1 : 0) + (a.search_match_count > 0 ? 1 : 0)
    const bSig = (b.tv_match_count > 0 ? 1 : 0) + (b.search_match_count > 0 ? 1 : 0)
    if (aSig !== bSig) return bSig - aSig
    const ad = a.price_delta_7d_pct ?? a.price_delta_30d_pct ?? 0
    const bd = b.price_delta_7d_pct ?? b.price_delta_30d_pct ?? 0
    if (ad !== bd) return ad - bd
    return Number(b.final_score) - Number(a.final_score)
  })

  // 상위 30 sparkline fetch
  const sparkMap = await fetchSparklines(rows.slice(0, 30).map((r) => r.goods_no))

  const total = rows.length
  const dualSignal = rows.filter((r) => r.tv_match_count > 0 && r.search_match_count > 0).length
  const heavyDrop = rows.filter((r) => (r.price_delta_7d_pct ?? 0) <= -10).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📉 가격 인하 모멘텀 (V1)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매가 하락 + TV/검색 시그널 동시 발생 = 위탁 진입 buy-signal
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/admin/trend-radar/recommend" className="text-gray-700 hover:text-black underline">
            ⭐ 추천 뷰
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
        <strong>매수 신호 정의</strong> ·{' '}
        <span className="font-mono">price_drop_bonus = (7일내 -10%↓ → ×1.2 / -5%~-10% → ×1.1) </span>
        가 final_score 에 곱해진다. 본 뷰는 이 보너스가 활성화된 상품을 우선 정렬한다.
        시계열이 누적될수록 노이즈가 줄어든다 (현재 ggsan은 1회 적재 상태 — 매일 cron 누적 필요).
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">시그널 기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">하락폭</span>
            {DROP_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { drop: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDrop === d.v ? 'bg-emerald-100 text-emerald-800 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <Link
            href={buildHref(current, { signal: signalOnly ? '0' : null })}
            className={`px-3 py-1 text-xs rounded ${signalOnly ? 'bg-amber-100 text-amber-800 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {signalOnly ? '✓ ' : ''}TV/검색 매칭 동시 발생만
          </Link>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보" value={total} />
        <Kpi label="TV+검색 동시" value={dualSignal} highlight={dualSignal > 0} />
        <Kpi label="-10%↓ 인하" value={heavyDrop} />
        <Kpi label="sparkline 표시" value={Math.min(rows.length, 30)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            supabase/ggsan_recommend_rpc_v1.sql 미적용 가능성. psql 로 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 모멘텀 후보 없음</div>
          <div className="text-xs text-gray-400">
            가능 원인: 1) jimscanner_ggsan_price_history 시계열 미누적 (1회 적재만 됨) ·
            2) 가격 변동이 임계치 이하 · 3) TV/검색 매칭 동시 발생 상품 없음
            <br />
            <Link href={buildHref(current, { drop: '0', signal: '0' })} className="underline">
              필터 완화하기
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const spark = sparkMap.get(r.goods_no) ?? []
            const d7 = r.price_delta_7d_pct
            const d30 = r.price_delta_30d_pct
            const dualBadge = r.tv_match_count > 0 && r.search_match_count > 0
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                  dualBadge ? 'border-emerald-300 bg-emerald-50/30 hover:bg-emerald-50' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                  <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {dualBadge && (
                      <span className="absolute top-0 left-0 bg-emerald-600 text-white text-[9px] px-1 leading-tight rounded-br">
                        DUAL
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.cate_label ?? r.cate_cd} · {r.goods_no}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      {d7 != null && <PriceDeltaBadge pct={d7} window="7d" />}
                      {d30 != null && <PriceDeltaBadge pct={d30} window="30d" />}
                      {r.lowest_price_in_30d != null && r.price_krw != null && (
                        <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded font-mono">
                          30d-low {r.lowest_price_in_30d.toLocaleString()}원
                        </span>
                      )}
                      {r.tv_match_count > 0 && (
                        <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          📺 {r.tv_top_keyword} ({r.tv_total_pushes})
                        </span>
                      )}
                      {r.search_match_count > 0 && (
                        <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                          🔍 {r.search_top_keyword}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex-shrink-0">
                    <Sparkline points={spark} currentPrice={r.price_krw} />
                  </div>

                  <div className="text-right flex-shrink-0 space-y-1 w-24">
                    <div className="text-base font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                    </div>
                    <div className="text-xl font-bold font-mono text-emerald-700">
                      {Number(r.final_score).toFixed(1)}
                    </div>
                    {r.price_drop_bonus != null && Number(r.price_drop_bonus) > 1.0 && (
                      <div className="text-[10px] text-emerald-700 font-mono">
                        × {Number(r.price_drop_bonus).toFixed(2)} drop
                      </div>
                    )}
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 모멘텀 매수 신호 정의</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          buy_signal = price_drop_bonus &gt; 1.0 AND (tv_match_count &gt; 0 OR search_match_count &gt; 0)
          <br />
          price_drop_bonus = d7 ≤ -10% ? 1.2 : d7 ≤ -5% ? 1.1 : 1.0
          <br />
          d7 = (current - price_7d_ago) / price_7d_ago × 100
        </code>
        <div className="pt-2">
          상위 30개 카드만 sparkline 을 로드한다. ggsan cron 이 매일 jimscanner_ggsan_price_history 에 스냅샷을 적재하면
          d7/d30 정밀도가 올라간다 — 현재 1회 적재 상태이므로 본 뷰는 며칠 누적 후 의미가 생긴다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
