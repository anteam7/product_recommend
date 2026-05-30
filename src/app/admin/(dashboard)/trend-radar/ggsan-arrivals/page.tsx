import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ArrivalRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  first_seen_at: string
  last_seen_at: string
  days_since_arrival: number

  demand_score: number
  tv_match_count: number
  tv_top_keyword: string
  search_match_count: number
  search_top_keyword: string
  search_sources: string[]

  price_first: number | null
  price_latest: number | null
  price_change_pct: number
  price_points: number[]
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일 (기본)' },
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

// 3분면 분류 — 가용 데이터(수요부착도 + 입고 후 가격추세)만으로 정직하게 분류
type Quadrant = 'green' | 'yellow' | 'white'

function classify(r: ArrivalRow): Quadrant {
  // ⚪ 도매처가 입고 후 5%+ 할인으로 밀어내는 중 = 안 팔림/포화 징후 (공급측 신호)
  if (r.price_change_pct <= -5) return 'white'
  // 🟢 신상 + 수요부상 = first-mover 최적
  if (r.demand_score > 0) return 'green'
  // 🟡 신상 + 수요無 = 도매처 단독 베팅(투기)
  return 'yellow'
}

const QUADRANT_META: Record<Quadrant, { emoji: string; label: string; desc: string; ring: string; chip: string }> = {
  green: {
    emoji: '🟢',
    label: '신상 + 수요부상',
    desc: 'first-mover 최적 — 경쟁 셀러보다 먼저 등록',
    ring: 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50',
    chip: 'bg-emerald-100 text-emerald-800',
  },
  yellow: {
    emoji: '🟡',
    label: '신상 + 수요無',
    desc: '도매처 단독 베팅 — 선제 투기(검증 필요)',
    ring: 'border-amber-300 bg-amber-50/40 hover:bg-amber-50',
    chip: 'bg-amber-100 text-amber-800',
  },
  white: {
    emoji: '⚪',
    label: '입고 후 할인 밀어내기',
    desc: '도매처가 가격 인하 중 — 회전 둔화/포화 징후',
    ring: 'border-gray-200 hover:bg-gray-50',
    chip: 'bg-gray-100 text-gray-600',
  },
}

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

async function fetchArrivals(opts: { days: number; minSim: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_new_arrivals_rpc.sql)에 존재하나 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_ggsan_new_arrivals' as never, {
    arrival_days: opts.days,
    min_sim: opts.minSim,
    demand_days: 30,
    result_limit: 300,
  } as never)
  if (error) {
    return { rows: [] as ArrivalRow[], error: error.message }
  }
  return { rows: (data ?? []) as ArrivalRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ggsan-arrivals' + (qs ? `?${qs}` : '')
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'naver_shopping_hot': return '🛍 쇼핑hot'
    case 'naver_search_trend': return '🔍 검색트렌드'
    case 'aliex_best': return '🅰 알리'
    case 'musinsa_best': return '🅼 무신사'
    default: return s
  }
}

// 가격 추세 스파크라인 (의존성 없이 인라인 SVG)
function Sparkline({ points }: { points: number[] }) {
  if (!points || points.length < 2) {
    return <span className="text-[10px] text-gray-300">추세 데이터 부족</span>
  }
  const w = 80
  const h = 24
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = w / (points.length - 1)
  const path = points
    .map((p, i) => {
      const x = i * step
      const y = h - ((p - min) / span) * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const down = points[points.length - 1] < points[0]
  const color = down ? '#dc2626' : '#059669'
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default async function GgsanArrivalsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; cate?: string; q?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '14', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 14
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const cate = sp.cate ?? ''
  const q = (sp.q ?? '').trim()

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    cate,
    q,
  }

  const { rows: allRows, error } = await fetchArrivals({ days: validDays, minSim: validSim })

  let rows = allRows
  if (cate) rows = rows.filter((r) => r.cate_cd === cate)
  if (q) rows = rows.filter((r) => r.title.toLowerCase().includes(q.toLowerCase()))

  // 분면 분류
  const withQ = rows.map((r) => ({ r, q: classify(r) }))
  const greenCount = withQ.filter((x) => x.q === 'green').length
  const yellowCount = withQ.filter((x) => x.q === 'yellow').length
  const whiteCount = withQ.filter((x) => x.q === 'white').length

  // KPI: 주간(7일) 신규 입고수 + 수요부착 비율
  const weekArrivals = allRows.filter((r) => r.days_since_arrival <= 7).length
  const demandAttachRatio =
    allRows.length > 0
      ? (allRows.filter((r) => r.demand_score > 0).length / allRows.length) * 100
      : 0

  // 카테고리별 입고 속도 (전체 윈도우 기준 상위)
  const cateSpeed = new Map<string, number>()
  for (const r of allRows) {
    const key = r.cate_label ?? r.cate_cd ?? '기타'
    cateSpeed.set(key, (cateSpeed.get(key) ?? 0) + 1)
  }
  const topCates = [...cateSpeed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)

  // first-mover 우선: 🟢 → 🟡 → ⚪, 같은 분면 안에서는 입고 최신순
  const order: Record<Quadrant, number> = { green: 0, yellow: 1, white: 2 }
  withQ.sort((a, b) => {
    if (order[a.q] !== order[b.q]) return order[a.q] - order[b.q]
    return new Date(b.r.first_seen_at).getTime() - new Date(a.r.first_seen_at).getTime()
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📦 신상 입고 레이더 (supply-first)</h1>
          <p className="text-sm text-gray-500 mt-1">
            도매처(ggsan) 신규 입고 = 공급측 선제 베팅 · 경쟁 셀러보다 먼저 발견하는 시간 우위 보드
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 컨셉 안내 */}
      <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
        <strong>supply-leads-demand</strong> · 기존 추천·카탈로그는 모두 수요→ggsan(demand-first)이라 신상이 갱신순에 묻힘.
        이 보드는 <strong>first_seen_at</strong> 을 1차 신호로 입고일순 노출하고, 각 신상의 수요부착도와 입고 후 가격추세를 교차.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">입고 윈도우</span>
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
            <span className="text-xs text-gray-500">수요 유사도 ≥</span>
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
          <form className="flex-1 min-w-[180px] max-w-xs" action="/admin/trend-radar/ggsan-arrivals">
            <input type="hidden" name="days" value={String(validDays)} />
            <input type="hidden" name="sim" value={String(validSim)} />
            <input type="hidden" name="cate" value={cate} />
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="상품명 검색"
              className="w-full px-3 py-1 text-sm border border-gray-300 rounded"
            />
          </form>
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
        <Kpi label="주간 신규 입고 (7일)" value={weekArrivals} highlight={weekArrivals > 0} />
        <Kpi label="수요부착 비율" value={`${demandAttachRatio.toFixed(0)}%`} />
        <Kpi label="🟢 first-mover" value={greenCount} highlight={greenCount > 0} />
        <Kpi
          label="입고속도 상위 카테고리"
          value={topCates.length > 0 ? topCates.map(([k, n]) => `${k} ${n}`).join(' · ') : '—'}
        />
      </section>

      {/* 분면 요약 */}
      <section className="grid grid-cols-3 gap-3 text-xs">
        {(['green', 'yellow', 'white'] as Quadrant[]).map((qd) => {
          const m = QUADRANT_META[qd]
          const n = qd === 'green' ? greenCount : qd === 'yellow' ? yellowCount : whiteCount
          return (
            <div key={qd} className={`rounded border p-3 ${m.ring}`}>
              <div className="font-semibold">{m.emoji} {m.label} · {n}건</div>
              <div className="text-gray-500 mt-1">{m.desc}</div>
            </div>
          )
        })}
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_ggsan_new_arrivals</code> 가 DB에 적용 안 됐을 가능성. supabase/ggsan_new_arrivals_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 결과 */}
      {!error && withQ.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">최근 입고된 신상 없음</div>
          <div className="text-xs text-gray-400">
            입고 윈도우를 30/60일로 늘려보기. ggsan 수집 크론이 도는 만큼 first_seen_at 이 갱신됨.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {withQ.map(({ r, q: qd }, i) => {
            const m = QUADRANT_META[qd]
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${m.ring}`}
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                  {/* 이미지 */}
                  <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    <span className="absolute top-0 left-0 bg-black/70 text-white text-[9px] px-1 leading-tight rounded-br">
                      D+{r.days_since_arrival}
                    </span>
                  </div>

                  {/* 본문 */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${m.chip}`}>
                        {m.emoji} {m.label}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        입고 {r.first_seen_at?.slice(0, 10)}
                      </span>
                    </div>
                    <div className="text-sm font-medium leading-snug" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.cate_label ?? r.cate_cd} · {r.goods_no}
                    </div>
                    {/* 수요부착 근거 */}
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      {r.tv_match_count > 0 && (
                        <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          📺 TV {r.tv_match_count}건 · &quot;{r.tv_top_keyword}&quot;
                        </span>
                      )}
                      {r.search_match_count > 0 && (
                        <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                          🔍 검색 {r.search_match_count}건 · &quot;{r.search_top_keyword}&quot;
                        </span>
                      )}
                      {r.search_sources.length > 0 && (
                        <span className="text-gray-500">from {r.search_sources.map(sourceLabel).join(', ')}</span>
                      )}
                      {r.demand_score === 0 && (
                        <span className="text-gray-400">수요 시그널 매칭 없음</span>
                      )}
                    </div>
                  </div>

                  {/* 가격 추세 + 점수 */}
                  <div className="text-right flex-shrink-0 space-y-1">
                    <div className="text-base font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                    </div>
                    <div className="flex justify-end">
                      <Sparkline points={r.price_points} />
                    </div>
                    {Math.abs(r.price_change_pct) >= 0.5 && (
                      <div className={`text-[11px] font-mono ${r.price_change_pct < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                        입고후 {r.price_change_pct > 0 ? '+' : ''}{r.price_change_pct.toFixed(1)}%
                      </div>
                    )}
                    <div className="text-[11px] text-emerald-700 font-mono">
                      수요 {Number(r.demand_score).toFixed(2)}
                    </div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 3분면 분류 기준 (가용 데이터 기반)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          ⚪ 입고후 가격 -5% 이하 → 도매처 할인 밀어내기(회전 둔화/포화 징후)
          <br />
          🟢 그 외 + demand_score &gt; 0 → 신상+수요부상 (first-mover 최적)
          <br />
          🟡 그 외 + demand_score = 0 → 신상+수요無 (도매처 단독 베팅·투기)
          <br />
          demand_score = Σ (occurrences × similarity(수요키워드, ggsan_title)) — recommend RPC 로직 재사용
        </code>
        <div className="pt-2">
          <strong>V1 보강:</strong> 쿠팡·스마트스토어 등록상품수로 ⚪포화 분면 정밀화 (현재는 가격 인하를 공급측 회전 프록시로 사용)
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
