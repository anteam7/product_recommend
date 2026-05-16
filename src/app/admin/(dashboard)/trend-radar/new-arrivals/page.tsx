import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface NewArrivalRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  first_seen_at: string
  aging_days: number
  tv_signal_count: number
  tv_top_keyword: string
  search_signal_count: number
  search_top_keyword: string
  news_signal_count: number
  news_top_keyword: string
  total_signal_count: number
  base_score: number
  imminent_bonus: number
  first_mover_score: number
}

const DAYS_OPTIONS = [
  { v: 3, label: '3일 (Hot)' },
  { v: 7, label: '7일 (기본)' },
  { v: 14, label: '14일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

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

async function fetchNewArrivals(opts: {
  days: number
  minSim: number
  cate: string
  signalOnly: boolean
}) {
  const sb = createAdminClient()
  // RPC 는 supabase/trends_v4_ggsan_new_arrivals_rpc.sql 에 정의. generated 타입 미반영 → 캐스팅.
  const { data, error } = await sb.rpc('jimscanner_ggsan_new_arrivals' as never, {
    days_window: opts.days,
    signal_window: 14,
    min_sim: opts.minSim,
    result_limit: 300,
  } as never)
  if (error) {
    return { rows: [] as NewArrivalRow[], error: error.message }
  }
  let rows = (data ?? []) as NewArrivalRow[]
  if (opts.cate) rows = rows.filter((r) => r.cate_cd === opts.cate)
  if (opts.signalOnly) rows = rows.filter((r) => r.total_signal_count > 0)
  return { rows, error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/new-arrivals' + (qs ? `?${qs}` : '')
}

// aging_days 컬러 그라데이션: 0~3 빨강, 4~7 주황, 8~14 회색
function agingClasses(aging: number): { bar: string; text: string; label: string } {
  if (aging <= 3) return { bar: 'bg-red-500', text: 'text-red-700', label: 'HOT' }
  if (aging <= 7) return { bar: 'bg-orange-500', text: 'text-orange-700', label: 'FRESH' }
  return { bar: 'bg-gray-400', text: 'text-gray-600', label: 'AGED' }
}

export default async function NewArrivalsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; cate?: string; signal?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '7', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 7
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const cate = sp.cate ?? ''
  const signalOnly = sp.signal === '1'

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    cate,
    signal: signalOnly ? '1' : '',
  }

  const { rows, error } = await fetchNewArrivals({
    days: validDays,
    minSim: validSim,
    cate,
    signalOnly,
  })

  const total = rows.length
  const hotCount = rows.filter((r) => r.aging_days <= 3).length
  const withSignal = rows.filter((r) => r.total_signal_count > 0).length
  const imminent = rows.filter((r) => r.is_imminent).length
  const avgAging = rows.length > 0 ? rows.reduce((s, r) => s + r.aging_days, 0) / rows.length : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🆕 신상 First-Mover 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 입고 N일 내 SKU × 최근 트렌드 시그널 — 신선도 × 수요로 first-mover edge 정량화
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
        <strong>왜 first-mover 인가</strong> · 위탁판매의 마진·무광고 자연유입은 공급사가 신상을 풀고
        다른 셀러들이 등록하기 전 1~2주 윈도우에서 발생. 추천 페이지가 누적 점수라 포화 SKU 가
        섞이는 한계를 신선도(aging_days)로 분리.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">신상 윈도우</span>
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
            href={buildHref(current, { signal: signalOnly ? null : '1' })}
            className={`px-3 py-1 text-xs rounded ${signalOnly ? 'bg-blue-100 text-blue-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {signalOnly ? '✓ ' : ''}시그널 있는 것만
          </Link>
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
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="신상 SKU" value={total} />
        <Kpi label="🔥 3일 내 HOT" value={hotCount} highlight={hotCount > 0} />
        <Kpi label="시그널 매칭" value={withSignal} />
        <Kpi label="임박특가" value={imminent} />
        <Kpi label="평균 aging" value={`${avgAging.toFixed(1)}일`} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_ggsan_new_arrivals</code> 가 DB 에 적용 안 됐을 가능성.
            supabase/trends_v4_ggsan_new_arrivals_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 신상 SKU 없음</div>
          <div className="text-xs text-gray-400">
            윈도우를 14일까지 늘리거나, &apos;시그널 있는 것만&apos; 토글을 끄고 다시 시도.
            ggsan 카탈로그 cron 이 죽었을 가능성 — 소스 헬스 페이지 확인.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const aging = agingClasses(r.aging_days)
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                  r.aging_days <= 3
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
                    <span className={`absolute top-0 left-0 ${aging.bar} text-white text-[9px] px-1 leading-tight rounded-br font-semibold`}>
                      {aging.label}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.cate_label ?? r.cate_cd} · {r.goods_no} ·{' '}
                      <span className={`font-mono font-semibold ${aging.text}`}>
                        +{r.aging_days}일
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      {r.tv_signal_count > 0 && (
                        <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          📺 TV {r.tv_signal_count} · &quot;{r.tv_top_keyword}&quot;
                        </span>
                      )}
                      {r.search_signal_count > 0 && (
                        <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                          🔍 검색 {r.search_signal_count} · &quot;{r.search_top_keyword}&quot;
                        </span>
                      )}
                      {r.news_signal_count > 0 && (
                        <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded">
                          📰 뉴스 {r.news_signal_count} · &quot;{r.news_top_keyword}&quot;
                        </span>
                      )}
                      {r.is_imminent && (
                        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded">
                          🔥 임박특가
                        </span>
                      )}
                      {r.total_signal_count === 0 && (
                        <span className="text-gray-400">시그널 없음 · 순수 신선도</span>
                      )}
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0 space-y-1">
                    <div className="text-base font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                    </div>
                    <div className="text-2xl font-bold font-mono text-emerald-700">
                      {Number(r.first_mover_score).toFixed(2)}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                      <div>base {Number(r.base_score).toFixed(2)}</div>
                      <div>× (1+{r.total_signal_count})</div>
                      {r.is_imminent && <div className="text-red-600">× 1.3 (임박)</div>}
                    </div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 FirstMoverScore 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          first_mover_score = base_score × (1 + total_signal_count) × imminent_bonus
          <br />
          base_score = max(0, 1 − aging_days / 14)
          <br />
          total_signal_count = tv_signal + search_signal + news_signal (trgm sim ≥ min_sim)
          <br />
          imminent_bonus = is_imminent ? 1.3 : 1.0
        </code>
        <div className="pt-2">
          <strong>설계 메모:</strong> 추천(/recommend) 이 누적 수요 강도라면 이 보드는 &lsquo;발견 윈도우&rsquo;.
          aging_days 가 14 를 넘으면 base_score=0 이라 자동 제외. 시그널 0 이어도 신선도만으로 노출되므로
          포화 전 진입 후보를 빠르게 스캔 가능.
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
