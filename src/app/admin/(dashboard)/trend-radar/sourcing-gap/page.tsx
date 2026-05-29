import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface GgsanCandidate {
  goods_no: string
  title: string
  price_krw: number | null
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  sim: number
}

interface WhitespaceRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  trend_score: number
  commerce_score: number
  supplier_score: number
  final_score: number
  computed_at: string
  demand_score: number
  supplier_count: number
  viable_supplier_count: number
  best_ggsan_sim: number
  ggsan_candidates: GgsanCandidate[]
  is_whitespace: boolean
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일' },
] as const

const THRESHOLD_OPTIONS = [
  { v: 40, label: '40 (느슨)' },
  { v: 50, label: '50 (기본)' },
  { v: 60, label: '60' },
  { v: 70, label: '70 (엄격)' },
] as const

async function fetchWhitespace(opts: { days: number; minDemand: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/trends_v4_sourcing_whitespace_rpc.sql)에 존재하나 generated 타입 미반영
  // — `npm run gen:types` 후 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_sourcing_whitespace' as never, {
    days_window: opts.days,
    min_trend: opts.minDemand,
    min_commerce: opts.minDemand,
    connect_sim: 0.35,
    cand_sim: 0.15,
    max_moq: 1,
    max_lead_days: 10,
    result_limit: 200,
  } as never)
  if (error) {
    return { rows: [] as WhitespaceRow[], error: error.message }
  }
  return { rows: (data ?? []) as WhitespaceRow[], error: null as string | null }
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강',
  living: '리빙',
  digital: '디지털',
  food: '식품',
}

interface CategoryCoverage {
  category: string
  validated: number // 수요검증 N건
  connected: number // 도매연결 M건
  whitespace: number // 공백 (= validated - connected)
  coverageRate: number // M / N
}

function buildCoverage(rows: WhitespaceRow[]): CategoryCoverage[] {
  const map = new Map<string, CategoryCoverage>()
  for (const r of rows) {
    const key = r.category_top || '(미분류)'
    let c = map.get(key)
    if (!c) {
      c = { category: key, validated: 0, connected: 0, whitespace: 0, coverageRate: 0 }
      map.set(key, c)
    }
    c.validated += 1
    if (r.is_whitespace) c.whitespace += 1
    else c.connected += 1
  }
  for (const c of map.values()) {
    c.coverageRate = c.validated > 0 ? c.connected / c.validated : 0
  }
  return [...map.values()].sort((a, b) => {
    // 공백 많은 카테고리 우선
    if (a.whitespace !== b.whitespace) return b.whitespace - a.whitespace
    return b.validated - a.validated
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
  return '/admin/trend-radar/sourcing-gap' + (qs ? `?${qs}` : '')
}

function coverageColor(rate: number): string {
  if (rate >= 0.7) return 'bg-emerald-100 text-emerald-800 border-emerald-300'
  if (rate >= 0.4) return 'bg-amber-100 text-amber-800 border-amber-300'
  if (rate >= 0.15) return 'bg-orange-100 text-orange-800 border-orange-300'
  return 'bg-red-100 text-red-800 border-red-300'
}

export default async function SourcingGapPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; demand?: string; cate?: string; all?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const demand = parseInt(sp.demand ?? '50', 10)
  const validDemand = THRESHOLD_OPTIONS.some((t) => t.v === demand) ? demand : 50
  const cate = sp.cate ?? ''
  const showAll = sp.all === '1' // 공백만(기본) vs 검증 후보 전체

  const current: Record<string, string> = {
    days: String(validDays),
    demand: String(validDemand),
    cate,
    all: showAll ? '1' : '',
  }

  const { rows, error } = await fetchWhitespace({ days: validDays, minDemand: validDemand })

  const coverage = buildCoverage(rows)

  // 리스트 필터: 카테고리 + 공백/전체
  let listRows = rows
  if (cate) listRows = listRows.filter((r) => r.category_top === cate)
  if (!showAll) listRows = listRows.filter((r) => r.is_whitespace)

  // KPI
  const validatedTotal = rows.length
  const whitespaceTotal = rows.filter((r) => r.is_whitespace).length
  const connectedTotal = validatedTotal - whitespaceTotal
  const overallCoverage = validatedTotal > 0 ? connectedTotal / validatedTotal : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🕳 소싱 공백 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            <strong>입증 수요 × 공급 부재</strong>의 교집합 — 검증된 수요인데 도매 소싱 경로가 없는 상품.
            1인 위탁셀러의 가장 레버리지 높은 데일리 헌팅 리스트.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 개념 설명 */}
      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>역(逆)조인 지도</strong> · 점수 임계가 아니라 <strong>공급 커버리지 부재</strong>를 조직축으로 본다.
        수요 검증(trend·commerce ≥ {validDemand}) 통과 후보 중,{' '}
        <code>jimscanner_trends_supplier</code>에 마진을 안 깨는 supplier(MOQ≤1·리드≤10일)가 없고
        ggsan 카탈로그에도 강매칭(sim ≥ 0.35)이 없는 상품을 <strong>공백</strong>으로 분류.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">점수 윈도우</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">수요 임계 ≥</span>
            {THRESHOLD_OPTIONS.map((t) => (
              <Link
                key={t.v}
                href={buildHref(current, { demand: String(t.v) })}
                className={`px-2 py-1 text-xs rounded ${validDemand === t.v ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {t.label}
              </Link>
            ))}
          </div>
          <Link
            href={buildHref(current, { all: showAll ? null : '1' })}
            className={`px-3 py-1 text-xs rounded ${showAll ? 'bg-gray-700 text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {showAll ? '검증 후보 전체' : '공백만 (기본)'}
          </Link>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="수요 검증 후보" value={validatedTotal} />
        <Kpi label="🕳 소싱 공백" value={whitespaceTotal} highlight={whitespaceTotal > 0} />
        <Kpi label="도매 연결됨" value={connectedTotal} />
        <Kpi label="커버리지율" value={`${(overallCoverage * 100).toFixed(0)}%`} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_sourcing_whitespace</code> 가 DB에 적용 안 됐을 가능성.
            supabase/trends_v4_sourcing_whitespace_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* ① 카테고리 공백 히트맵 */}
      {!error && coverage.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700">① 카테고리 공백 히트맵 (커버리지율 = 연결 M / 검증 N)</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {coverage.map((c) => (
              <Link
                key={c.category}
                href={buildHref(current, { cate: cate === c.category ? null : c.category })}
                className={`rounded border px-3 py-3 transition-all hover:shadow-sm ${coverageColor(c.coverageRate)} ${cate === c.category ? 'ring-2 ring-black' : ''}`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold">
                    {CATEGORY_LABEL[c.category] ?? c.category}
                  </span>
                  <span className="text-lg font-bold font-mono">
                    {(c.coverageRate * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="text-[11px] mt-1 opacity-80">
                  검증 {c.validated} · 연결 {c.connected} · <strong>공백 {c.whitespace}</strong>
                </div>
              </Link>
            ))}
          </div>
          {cate && (
            <div className="text-xs text-gray-500">
              <Link href={buildHref(current, { cate: null })} className="underline hover:text-black">
                ✕ 카테고리 필터 해제
              </Link>
            </div>
          )}
        </section>
      )}

      {/* ② 미연결 위너 리스트 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">
          ② {showAll ? '검증 후보' : '미연결 위너'} 리스트 (수요점수 순)
          {cate && <span className="text-gray-400"> · {CATEGORY_LABEL[cate] ?? cate}</span>}
        </h2>

        {!error && listRows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
            <div className="text-base font-medium">
              {showAll ? '조건에 맞는 검증 후보 없음' : '소싱 공백 없음 🎉'}
            </div>
            <div className="text-xs text-gray-400">
              {showAll
                ? 'jimscanner_trends_scores 누적이 적거나 임계가 높을 수 있음. 수요 임계를 40으로 낮추거나 윈도우를 90일로.'
                : '검증된 수요가 모두 소싱 경로에 연결돼 있거나, 아직 점수 데이터가 누적되지 않았습니다. 「검증 후보 전체」로 토글해 확인.'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {listRows.map((r, i) => (
              <div
                key={r.product_id}
                className={`rounded border overflow-hidden ${
                  r.is_whitespace ? 'border-red-200 bg-red-50/30' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  {/* 순위 */}
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                  {/* 본문 */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium leading-snug" title={r.canonical_name}>
                        {r.canonical_name}
                      </span>
                      {r.is_whitespace && (
                        <span className="text-[10px] bg-red-600 text-white px-1.5 py-0.5 rounded">
                          🕳 공백
                        </span>
                      )}
                      {r.brand && <span className="text-xs text-gray-400">{r.brand}</span>}
                    </div>
                    <div className="text-xs text-gray-500">
                      {CATEGORY_LABEL[r.category_top] ?? r.category_top}
                      {r.category_mid ? ` · ${r.category_mid}` : ''}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        수요 {Number(r.demand_score).toFixed(0)} (T{Number(r.trend_score).toFixed(0)}·C{Number(r.commerce_score).toFixed(0)})
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded ${
                          r.viable_supplier_count > 0
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        공급사 {r.viable_supplier_count}/{r.supplier_count} viable
                      </span>
                      <span className="text-gray-500">
                        ggsan 최근접 sim {Number(r.best_ggsan_sim).toFixed(3)}
                      </span>
                    </div>

                    {/* 가장 근접한 ggsan 후보 3개 */}
                    {r.ggsan_candidates.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {r.ggsan_candidates.map((g) => (
                          <a
                            key={g.goods_no}
                            href={g.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener"
                            className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1 hover:border-amber-300 hover:bg-amber-50 transition-colors max-w-[260px]"
                            title={g.title}
                          >
                            <div className="w-8 h-8 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                              {g.image_url && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={g.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="text-[11px] font-medium leading-tight truncate">{g.title}</div>
                              <div className="text-[10px] text-gray-400 font-mono">
                                {g.price_krw ? `${g.price_krw.toLocaleString()}원 · ` : ''}sim {Number(g.sim).toFixed(2)}
                              </div>
                            </div>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-[11px] text-red-500">
                        ⚠ ggsan 카탈로그에 근접 후보 없음 — 신규 도매처 발굴 필요
                      </div>
                    )}
                  </div>

                  {/* 점수 */}
                  <div className="text-right flex-shrink-0 space-y-0.5">
                    <div className="text-2xl font-bold font-mono text-indigo-700">
                      {Number(r.demand_score).toFixed(0)}
                    </div>
                    <div className="text-[10px] text-gray-400">수요점수</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 공백 분류 로직</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          validated = (trend_score ≥ {validDemand}) AND (commerce_score ≥ {validDemand})  ·  최신 score row 기준
          <br />
          viable_supplier = supplier 中 (MOQ ≤ 1) AND (lead_time ≤ 10일)
          <br />
          ggsan_connected = max similarity(canonical_name, ggsan_title) ≥ 0.35
          <br />
          <strong>is_whitespace = validated AND (viable_supplier = 0) AND NOT ggsan_connected</strong>
        </code>
        <div className="pt-2">
          ggsan 매칭은 <code>tv-ggsan-match</code>와 동일한 pg_trgm <code>similarity()</code> 재활용.
          빈 supplier 테이블의 공백 자체를 신호로 전환한다. 13번(임계직하 액션큐)이 &quot;점수가 살짝 모자란&quot; 상품을 본다면,
          이 보드는 &quot;수요는 입증됐는데 살 곳이 없는&quot; 상품을 본다.
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
