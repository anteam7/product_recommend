import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MatchRow {
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  cate_cd: string | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  first_seen_at: string
  hours_since_arrival: number
  trend_name: string
  category_top: string | null
  trend_score: number | null
  final_score: number | null
  sim: number
}

const SIM_OPTIONS = [
  { v: 0.1, label: '0.10 (느슨)' },
  { v: 0.15, label: '0.15' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30' },
  { v: 0.4, label: '0.40 (엄격)' },
] as const

const DAYS_OPTIONS = [
  { v: 3, label: '3일' },
  { v: 7, label: '7일 (기본)' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
] as const

const PER_GOODS_LIMIT = 3
const RESULT_LIMIT = 500

async function fetchMatches(opts: { days: number; minSim: number; imminentOnly: boolean }) {
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb.rpc as any)('jimscanner_ggsan_newarrival_match', {
    days_window: opts.days,
    min_sim: opts.minSim,
    per_goods_limit: PER_GOODS_LIMIT,
    result_limit: RESULT_LIMIT,
  })
  if (error) {
    console.error('rpc error', error)
    return [] as MatchRow[]
  }
  let rows = (data ?? []) as MatchRow[]
  if (opts.imminentOnly) rows = rows.filter((r) => r.is_imminent)
  return rows
}

interface GoodsGroup {
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  cate_cd: string | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  first_seen_at: string
  hours_since_arrival: number
  matches: MatchRow[]
  bestFinal: number
  bestSim: number
}

function groupByGoods(rows: MatchRow[]): GoodsGroup[] {
  const map = new Map<string, GoodsGroup>()
  for (const r of rows) {
    let g = map.get(r.goods_no)
    if (!g) {
      g = {
        goods_no: r.goods_no,
        ggsan_title: r.ggsan_title,
        price_krw: r.price_krw,
        cate_cd: r.cate_cd,
        cate_label: r.cate_label,
        image_url: r.image_url,
        detail_url: r.detail_url,
        is_imminent: r.is_imminent,
        first_seen_at: r.first_seen_at,
        hours_since_arrival: Number(r.hours_since_arrival),
        matches: [],
        bestFinal: 0,
        bestSim: 0,
      }
      map.set(r.goods_no, g)
    }
    g.matches.push(r)
    const fin = Number(r.final_score ?? 0)
    if (fin > g.bestFinal) g.bestFinal = fin
    if (r.sim > g.bestSim) g.bestSim = r.sim
  }
  // 갓 들어온 순(입고경과 오름차순) × 수요 강도(final_score) 내림차순
  return [...map.values()].sort((a, b) => {
    if (a.hours_since_arrival !== b.hours_since_arrival)
      return a.hours_since_arrival - b.hours_since_arrival
    return b.bestFinal - a.bestFinal
  })
}

function elapsedLabel(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}분 전`
  if (hours < 24) return `${Math.round(hours)}시간 전`
  const days = hours / 24
  return `${days.toFixed(1)}일 전`
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/new-arrival' + (qs ? `?${qs}` : '')
}

const GGSAN_SEARCH = 'https://www.ggsan.com/goods/goods_search.php?keyword='
const COUPANG_SEARCH = 'https://www.coupang.com/np/search?q='

export default async function NewArrivalPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; imminent?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '7', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 7
  const minSim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - minSim) < 0.001) ? minSim : 0.2
  const imminentOnly = sp.imminent === '1'

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    imminent: imminentOnly ? '1' : '',
  }

  const rows = await fetchMatches({ days: validDays, minSim: validSim, imminentOnly })
  const groups = groupByGoods(rows)

  const totalMatches = rows.length
  const uniqueGoods = groups.length
  const imminentCount = groups.filter((g) => g.is_imminent).length
  const freshCount = groups.filter((g) => g.hours_since_arrival < 24).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🟢 입고 골든윈도우</h1>
          <p className="text-sm text-gray-500 mt-1">
            도매처(ggsan)가 <strong>막 취급 시작한 신규 SKU</strong> 중 마침 수요가 뜨는 후보.{' '}
            <strong>남들이 리스팅하기 전에</strong> 먼저 등록 · 입고경과 오름차순 × 수요 강도
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">입고 N일내</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
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
              className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
        <Link
          href={buildHref(current, { imminent: imminentOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${imminentOnly ? 'bg-red-100 text-red-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {imminentOnly ? '✓ ' : ''}임박특가만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="신규입고 SKU" value={uniqueGoods} />
        <Kpi label="수요 매칭 row" value={totalMatches} />
        <Kpi label="🆕 24h 이내 입고" value={freshCount} highlight={freshCount > 0} />
        <Kpi label="🔥 임박특가" value={imminentCount} highlight={imminentCount > 0} />
      </section>

      {/* 결과 — 신규입고 SKU 별 그룹 */}
      {groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>조건에 맞는 신규입고 매칭 없음</div>
          <div className="text-xs text-gray-400">
            기간을 늘리거나 유사도를 낮춰보세요. 수요(trends) 점수가 있는 상품만 매칭됩니다.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const fresh = g.hours_since_arrival < 24
            return (
              <div key={g.goods_no} className="rounded border border-gray-200 overflow-hidden">
                {/* 신규입고 SKU 헤더 */}
                <div
                  className={`px-4 py-3 flex items-start justify-between flex-wrap gap-3 ${
                    g.is_imminent ? 'bg-red-50' : fresh ? 'bg-emerald-50' : 'bg-gray-50'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                      {g.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={g.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                      )}
                      {g.is_imminent && (
                        <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                          임박
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-xs px-2 py-0.5 rounded font-semibold ${
                            fresh ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700'
                          }`}
                        >
                          {fresh ? '🆕 ' : ''}입고 {elapsedLabel(g.hours_since_arrival)}
                        </span>
                        {g.is_imminent && (
                          <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded">🔥 임박특가</span>
                        )}
                        <span className="text-xs text-gray-500 font-mono">
                          {g.first_seen_at.slice(0, 10)}
                        </span>
                      </div>
                      <div
                        className="text-sm font-semibold leading-snug line-clamp-2 mt-1"
                        title={g.ggsan_title}
                      >
                        {g.ggsan_title}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {g.cate_label ?? g.cate_cd} · {g.goods_no}
                        {g.price_krw ? ` · ${g.price_krw.toLocaleString()}원` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <div className="text-xs text-gray-500">
                      수요매칭 {g.matches.length} · best final{' '}
                      <strong className="font-mono">{g.bestFinal.toFixed(0)}</strong>
                    </div>
                    <div className="flex gap-1.5">
                      {g.detail_url && (
                        <a
                          href={g.detail_url}
                          target="_blank"
                          rel="noopener"
                          className="text-xs px-2 py-1 rounded bg-gray-800 text-white hover:bg-black"
                        >
                          ggsan 상세
                        </a>
                      )}
                      <a
                        href={GGSAN_SEARCH + encodeURIComponent(g.ggsan_title)}
                        target="_blank"
                        rel="noopener"
                        className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
                      >
                        ggsan 검색
                      </a>
                      <a
                        href={COUPANG_SEARCH + encodeURIComponent(g.ggsan_title)}
                        target="_blank"
                        rel="noopener"
                        className="text-xs px-2 py-1 rounded bg-rose-100 text-rose-700 hover:bg-rose-200"
                      >
                        쿠팡 검색
                      </a>
                    </div>
                  </div>
                </div>

                {/* 매칭된 수요(trends) */}
                <div className="divide-y divide-gray-100">
                  {g.matches
                    .slice()
                    .sort((a, b) => Number(b.final_score ?? 0) - Number(a.final_score ?? 0))
                    .map((m) => (
                      <div
                        key={`${m.goods_no}-${m.trend_name}`}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-emerald-50/50 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium leading-snug truncate" title={m.trend_name}>
                            📈 {m.trend_name}
                          </div>
                          <div className="text-xs text-gray-400 mt-0.5">{m.category_top ?? '—'}</div>
                        </div>
                        <div className="flex items-center gap-4 flex-shrink-0 text-right">
                          <div>
                            <div className="text-[10px] text-gray-400 uppercase">trend</div>
                            <div className="text-sm font-mono">
                              {m.trend_score != null ? Number(m.trend_score).toFixed(0) : '—'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-gray-400 uppercase">final</div>
                            <div className="text-sm font-mono font-bold text-emerald-700">
                              {m.final_score != null ? Number(m.final_score).toFixed(0) : '—'}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-gray-400 uppercase">sim</div>
                            <div className="text-sm font-mono text-gray-500">{Number(m.sim).toFixed(3)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          공급측 신규취급 이벤트(<code>first_seen_at</code> 최근 N일) × 수요(trends{' '}
          <code>final_score</code>) 매칭. pg_trgm <code>similarity()</code> fuzzy 비교.
        </div>
        <div>
          <strong>의사결정 단서:</strong>{' '}
          (1) 입고경과가 짧을수록 경쟁 셀러가 아직 리스팅하지 않았을 확률이 큼 ·
          (2) final_score 가 높을수록 수요가 강함 ·
          (3) 쿠팡 검색 결과가 적으면(블루오션) 선점 가치 ↑ ·
          (4) 임박특가는 도매가가 평소보다 낮을 가능성.
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
