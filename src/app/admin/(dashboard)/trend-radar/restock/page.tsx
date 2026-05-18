import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CadenceRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  current_status: string | null
  is_imminent: boolean
  last_seen_at: string
  restock_count_30d: number
  mean_oos_days: number | null
  last_restock_at: string | null
  mean_interval_days: number | null
  restock_cv: number | null
  min_price_30d: number | null
  max_price_30d: number | null
  price_obs_30d: number | null
  restock_velocity: number
}

interface TimelineEvent {
  at: string
  s: string
  p: number | null
}

interface TimelineRow {
  goods_no: string
  events: TimelineEvent[]
}

const MIN_RESTOCK_OPTIONS = [
  { v: 1, label: '≥1회' },
  { v: 2, label: '≥2회' },
  { v: 3, label: '≥3회' },
  { v: 5, label: '≥5회' },
] as const

const SORT_OPTIONS = [
  { v: 'velocity', label: '재입고 속도순' },
  { v: 'count', label: '재입고 횟수순' },
  { v: 'oos', label: '평균 품절기간 짧은순' },
  { v: 'cv', label: '주기 규칙성순 (CV ↑)' },
  { v: 'recent', label: '최근 재입고순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '장건강' },
  { code: '002', label: '눈건강' },
  { code: '003', label: '간건강' },
  { code: '005', label: '혈행건강' },
  { code: '006', label: '관절건강' },
  { code: '007', label: '면역건강' },
  { code: '008', label: '체지방' },
  { code: '009', label: '건기식기타' },
  { code: '010', label: '전통건강식품' },
  { code: '011', label: '전립선' },
  { code: '012', label: '식품분말' },
  { code: '013', label: '가공식품기타' },
  { code: '014', label: '신선식품' },
  { code: '020', label: '임박특가' },
]

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/restock' + (qs ? `?${qs}` : '')
}

async function fetchCadence(opts: { minRestock: number; cate: string }) {
  const sb = createAdminClient()
  // 뷰는 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  let q = sb
    .from('jimscanner_ggsan_restock_cadence' as never)
    .select('*')
    .gte('restock_count_30d', opts.minRestock)
  if (opts.cate) q = q.eq('cate_cd', opts.cate)
  const { data, error } = await q
  if (error) return { rows: [] as CadenceRow[], error: error.message }
  return { rows: ((data ?? []) as unknown) as CadenceRow[], error: null as string | null }
}

async function fetchTimelines(goodsNos: string[]): Promise<Record<string, TimelineEvent[]>> {
  if (goodsNos.length === 0) return {}
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_ggsan_status_timeline' as never,
    { goods_nos: goodsNos } as never,
  )
  if (error) return {}
  const map: Record<string, TimelineEvent[]> = {}
  for (const r of (data ?? []) as unknown as TimelineRow[]) {
    map[r.goods_no] = r.events ?? []
  }
  return map
}

function sortRows(rows: CadenceRow[], sort: SortKey): CadenceRow[] {
  const copy = [...rows]
  switch (sort) {
    case 'velocity':
      copy.sort((a, b) => b.restock_velocity - a.restock_velocity)
      break
    case 'count':
      copy.sort((a, b) => b.restock_count_30d - a.restock_count_30d)
      break
    case 'oos':
      copy.sort((a, b) => {
        const av = a.mean_oos_days ?? Number.POSITIVE_INFINITY
        const bv = b.mean_oos_days ?? Number.POSITIVE_INFINITY
        return av - bv
      })
      break
    case 'cv':
      // 낮은 CV = 규칙적인 사이클. CV null 은 뒤로.
      copy.sort((a, b) => {
        const av = a.restock_cv ?? Number.POSITIVE_INFINITY
        const bv = b.restock_cv ?? Number.POSITIVE_INFINITY
        return av - bv
      })
      break
    case 'recent':
      copy.sort((a, b) => {
        const at = a.last_restock_at ? new Date(a.last_restock_at).getTime() : 0
        const bt = b.last_restock_at ? new Date(b.last_restock_at).getTime() : 0
        return bt - at
      })
      break
  }
  return copy
}

function StatusSparkline({ events, width = 160, height = 20 }: { events: TimelineEvent[]; width?: number; height?: number }) {
  if (!events || events.length === 0) {
    return <div className="text-[10px] text-gray-300">no events</div>
  }
  const now = Date.now()
  const start = now - 30 * 86400000
  // 시계열을 30일 윈도우에 정규화
  const segs: { x0: number; x1: number; s: string }[] = []
  for (let i = 0; i < events.length; i++) {
    const t = new Date(events[i].at).getTime()
    const nextT = i + 1 < events.length ? new Date(events[i + 1].at).getTime() : now
    const x0 = Math.max(0, ((t - start) / (now - start)) * width)
    const x1 = Math.max(0, ((nextT - start) / (now - start)) * width)
    segs.push({ x0, x1, s: events[i].s })
  }
  function color(s: string) {
    if (s === 'active') return '#10b981'
    if (s === 'imminent') return '#f59e0b'
    if (s === 'sold_out') return '#ef4444'
    if (s === 'removed') return '#6b7280'
    return '#d1d5db'
  }
  return (
    <svg width={width} height={height} className="block">
      <rect x={0} y={0} width={width} height={height} fill="#f3f4f6" />
      {segs.map((sg, i) => (
        <rect
          key={i}
          x={sg.x0}
          y={0}
          width={Math.max(0.5, sg.x1 - sg.x0)}
          height={height}
          fill={color(sg.s)}
        />
      ))}
    </svg>
  )
}

function fmtDate(s: string | null): string {
  if (!s) return '-'
  const d = new Date(s)
  const now = Date.now()
  const diffH = (now - d.getTime()) / 3600000
  if (diffH < 24) return `${Math.round(diffH)}시간 전`
  return `${Math.round(diffH / 24)}일 전`
}

export default async function RestockPage({
  searchParams,
}: {
  searchParams: Promise<{ min?: string; cate?: string; sort?: string }>
}) {
  const sp = await searchParams
  const minRestock = parseInt(sp.min ?? '2', 10)
  const validMin = MIN_RESTOCK_OPTIONS.some((m) => m.v === minRestock) ? minRestock : 2
  const cate = sp.cate ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'velocity') as SortKey

  const current: Record<string, string> = {
    min: String(validMin),
    cate,
    sort,
  }

  const { rows, error } = await fetchCadence({ minRestock: validMin, cate })
  const sorted = sortRows(rows, sort)
  const top = sorted.slice(0, 150)
  const timelines = await fetchTimelines(top.map((r) => r.goods_no))

  // KPI
  const total = rows.length
  const avgVel = rows.length > 0 ? rows.reduce((s, r) => s + r.restock_velocity, 0) / rows.length : 0
  const avgOos = (() => {
    const vs = rows.map((r) => r.mean_oos_days).filter((v): v is number => v != null)
    return vs.length > 0 ? vs.reduce((a, b) => a + b, 0) / vs.length : 0
  })()
  const currentSoldOut = rows.filter((r) => r.current_status === 'sold_out' || r.current_status === 'removed').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔁 재입고 사이클 핫템</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매 status 시계열에서 <code>sold_out/removed → active</code> 전이 빈도 ≥ N회.
            잦은 재입고 + 짧은 OOS = 진성 회전 핫템 (검색 스파이크보다 신뢰도 높은 leak signal).
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/admin/trend-radar/recommend" className="text-gray-700 hover:text-black underline">
            ⭐ 추천 보드
          </Link>
          <Link href="/admin/trend-radar/ggsan" className="text-gray-700 hover:text-black underline">
            신규입고 first-mover →
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">30일 재입고 횟수</span>
            {MIN_RESTOCK_OPTIONS.map((m) => (
              <Link
                key={m.v}
                href={buildHref(current, { min: String(m.v) })}
                className={`px-2 py-1 text-xs rounded ${validMin === m.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {m.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">정렬</span>
            {SORT_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sort: s.v })}
                className={`px-2 py-1 text-xs rounded ${sort === s.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <Link
            href={buildHref(current, { cate: null })}
            className={`px-2 py-1 text-xs rounded ${cate === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            전체
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c.code}
              href={buildHref(current, { cate: c.code })}
              className={`px-2 py-1 text-xs rounded ${cate === c.code ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 SKU" value={total} />
        <Kpi label="평균 재입고 속도" value={avgVel.toFixed(2)} />
        <Kpi label="평균 품절기간(일)" value={avgOos.toFixed(1)} />
        <Kpi label="현재 품절/삭제" value={currentSoldOut} highlight={currentSoldOut > 0} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          뷰 조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>supabase/ggsan_restock_cadence.sql</code> 적용 필요. 또는 price_history 누적 부족.
          </p>
        </div>
      )}

      {!error && top.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 SKU 없음</div>
          <div className="text-xs text-gray-400">
            <code>jimscanner_ggsan_price_history</code> 가 충분히 누적되지 않았거나, status 전이가 적음. 최소 재입고 횟수를 1회로 낮춰보거나 카테고리 필터 해제.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {top.map((r, i) => {
            const events = timelines[r.goods_no] ?? []
            const priceRange =
              r.min_price_30d != null && r.max_price_30d != null
                ? r.max_price_30d - r.min_price_30d
                : null
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                  r.current_status === 'sold_out' || r.current_status === 'removed'
                    ? 'border-red-200 bg-red-50/30 hover:bg-red-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">
                    {i + 1}
                  </div>

                  <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {r.is_imminent && (
                      <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                        임박
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.cate_label ?? r.cate_cd} · {r.goods_no} ·
                      <span className={
                        r.current_status === 'active' ? 'text-emerald-600 ml-1' :
                        r.current_status === 'sold_out' ? 'text-red-600 ml-1' :
                        r.current_status === 'removed' ? 'text-gray-500 ml-1' :
                        'text-amber-600 ml-1'
                      }>
                        {r.current_status ?? '?'}
                      </span>
                    </div>
                    {/* sparkline */}
                    <div className="pt-1">
                      <StatusSparkline events={events} />
                      <div className="flex justify-between text-[9px] text-gray-400 mt-0.5" style={{ width: 160 }}>
                        <span>30일 전</span>
                        <span>지금</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">
                        🔁 {r.restock_count_30d}회 재입고
                      </span>
                      {r.mean_oos_days != null && (
                        <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                          평균 품절 {r.mean_oos_days.toFixed(1)}일
                        </span>
                      )}
                      {r.mean_interval_days != null && (
                        <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                          간격 ~{r.mean_interval_days.toFixed(1)}일
                          {r.restock_cv != null && ` (CV ${r.restock_cv.toFixed(2)})`}
                        </span>
                      )}
                      {priceRange != null && priceRange > 0 && (
                        <span className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded">
                          가격 {r.min_price_30d?.toLocaleString()}~{r.max_price_30d?.toLocaleString()}원
                        </span>
                      )}
                      <span className="text-gray-500">
                        최근 재입고 {fmtDate(r.last_restock_at)}
                      </span>
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0 space-y-1">
                    <div className="text-base font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                    </div>
                    <div className="text-2xl font-bold font-mono text-emerald-700">
                      {r.restock_velocity.toFixed(2)}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono">
                      velocity
                    </div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Restock Cadence 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          restock_count_30d = COUNT(status: sold_out/removed → active) over last 30d
          <br />
          mean_oos_days = AVG(restock_at - prior_oos_start_at) in days
          <br />
          restock_cv = STDDEV(intervals) / AVG(intervals) — 낮을수록 규칙적
          <br />
          restock_velocity = restock_count_30d / (1 + mean_oos_days)
        </code>
        <div className="pt-2">
          <strong>왜 이 신호?</strong> is_imminent(임박특가)는 공급사 마케팅 라벨이라 노이즈가 크다. 도매몰에서 실제로 사라졌다 → 재입고가 반복되는 SKU 는 위·아래 거래량이 진성으로 도는 핫템의 가장 강한 leak signal. 검색 스파이크에 치우치는 트렌드 점수를 도매 회전 실측치로 보정한다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
