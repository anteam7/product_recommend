import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import DecisionButtons, { reasonLabel, type CurrentDecision } from './DecisionButtons'

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
  decision_penalty?: number
  final_score: number

  tv_match_count: number
  tv_top_keyword: string
  tv_total_pushes: number
  search_match_count: number
  search_top_keyword: string
  search_sources: string[]

  // 기각사유 학습 신호 (RPC 마이그레이션 후 채워짐)
  rejected_siblings?: number
  top_reject_reason?: string
}

interface DecisionRow {
  goods_no: string
  cate_cd: string | null
  decision: string
  reason_code: string | null
  expires_at: string | null
  decided_at: string
}

async function fetchDecisions(): Promise<DecisionRow[]> {
  const sb = createAdminClient()
  // 테이블은 supabase/trends_decisions.sql 에 정의 — generated 타입 미반영이라 캐스팅.
  const { data } = await sb
    .from('jimscanner_trends_decisions' as never)
    .select('goods_no, cate_cd, decision, reason_code, expires_at, decided_at')
    .order('decided_at', { ascending: false })
  return (data ?? []) as unknown as DecisionRow[]
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

async function fetchRecommend(opts: {
  days: number
  minSim: number
  imminentOnly: boolean
  cate: string
}) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_recommend_rpc.sql)에 존재하나 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: opts.days,
    min_sim: opts.minSim,
    min_score: 0.5,
    result_limit: 200,
  } as never)
  if (error) {
    return { rows: [] as RecommendRow[], error: error.message }
  }
  let rows = (data ?? []) as RecommendRow[]
  if (opts.imminentOnly) rows = rows.filter((r) => r.is_imminent)
  if (opts.cate) rows = rows.filter((r) => r.cate_cd === opts.cate)
  return { rows, error: null as string | null }
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

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/recommend' + (qs ? `?${qs}` : '')
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

export default async function RecommendPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; imminent?: string; cate?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const imminentOnly = sp.imminent === '1'
  const cate = sp.cate ?? ''

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    imminent: imminentOnly ? '1' : '',
    cate,
  }

  const [{ rows, error }, decisions] = await Promise.all([
    fetchRecommend({ days: validDays, minSim: validSim, imminentOnly, cate }),
    fetchDecisions(),
  ])

  // goods_no → 현재 결정 (버튼 상태)
  const decisionByGoods = new Map<string, CurrentDecision>()
  for (const d of decisions) {
    if (!decisionByGoods.has(d.goods_no)) {
      decisionByGoods.set(d.goods_no, {
        decision: d.decision,
        reason_code: d.reason_code,
        expires_at: d.expires_at,
      })
    }
  }

  // 기각 사유 분포 (영구 rejected 기준)
  const nowMs = Date.now()
  const rejectedDecisions = decisions.filter((d) => d.decision === 'rejected')
  const snoozedActive = decisions.filter(
    (d) => d.decision === 'snoozed' && (!d.expires_at || new Date(d.expires_at).getTime() > nowMs),
  )
  const reasonDist = new Map<string, number>()
  for (const d of rejectedDecisions) {
    const code = d.reason_code ?? 'other'
    reasonDist.set(code, (reasonDist.get(code) ?? 0) + 1)
  }
  const reasonDistSorted = [...reasonDist.entries()].sort((a, b) => b[1] - a[1])

  // KPI
  const total = rows.length
  const imminentCount = rows.filter((r) => r.is_imminent).length
  const tvHitCount = rows.filter((r) => r.tv_score > 0).length
  const searchHitCount = rows.filter((r) => r.search_score > 0).length
  const avgFinal = rows.length > 0 ? rows.reduce((s, r) => s + Number(r.final_score), 0) / rows.length : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⭐ 위탁 후보 추천 (V0)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매 카탈로그 × TV 편성 시그널 × 검색·쇼핑 시그널 — 임박특가 보너스 적용
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 알림: V0 한계 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 한계</strong> · 스마트스토어·쿠팡 경쟁 데이터 부재로 saturation_penalty 미적용.
        커뮤니티 시그널은 LLM 정규화 후 V1에 포함 예정. 현재 점수는 <strong>수요 강도만</strong> 반영.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간</span>
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
            <span className="text-xs text-gray-500">유사도 ≥</span>
            {SIM_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sim: String(s.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
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
        <Kpi label="후보 상품" value={total} />
        <Kpi label="🔥 임박특가" value={imminentCount} highlight={imminentCount > 0} />
        <Kpi label="TV 매칭" value={tvHitCount} />
        <Kpi label="검색 매칭" value={searchHitCount} />
        <Kpi label="평균 final_score" value={avgFinal.toFixed(2)} />
      </section>

      {/* 기각 사유 분포·재출현 분석 */}
      {(rejectedDecisions.length > 0 || snoozedActive.length > 0) && (
        <section className="rounded border border-rose-200 bg-rose-50/40 px-4 py-3 space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-rose-900">🚫 기각 사유 분포 · 재출현 차단</h2>
            <span className="text-xs text-rose-700">
              영구 기각 {rejectedDecisions.length}건 · 활성 스누즈 {snoozedActive.length}건
            </span>
          </div>
          {reasonDistSorted.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {reasonDistSorted.map(([code, count]) => (
                <span key={code} className="text-xs rounded bg-white border border-rose-200 px-2 py-1 text-rose-800">
                  {reasonLabel(code)} <strong className="font-mono">{count}</strong>
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-rose-700/80">
            같은 카테고리에서 반복 기각된 사유는 신규 후보 점수에 패널티(×0.55~1.0)로 자동 반영됩니다.
          </p>
        </section>
      )}

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_ggsan_recommend</code> 가 DB에 적용 안 됐을 가능성. supabase/ggsan_recommend_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 결과 카드 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 후보 없음</div>
          <div className="text-xs text-gray-400">
            데이터 부족 가능성: 1) WSL cron 죽음 (sources 페이지 확인) · 2) trends_keywords 가 1일치 미만 누적
            <br />
            min_sim 을 0.15 로 낮추거나 days 60 으로 늘려보기. 누적 후엔 자동 풍부해짐.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const penalty = r.decision_penalty == null ? 1 : Number(r.decision_penalty)
            const penalized = penalty < 0.999
            return (
            <div
              key={r.goods_no}
              className={`block rounded border overflow-hidden transition-all ${
                r.is_imminent
                  ? 'border-red-200 bg-red-50/40'
                  : 'border-gray-200'
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                {/* 순위 */}
                <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">
                  {i + 1}
                </div>

                {/* 이미지 */}
                <a
                  href={r.detail_url ?? '#'}
                  target="_blank"
                  rel="noopener"
                  className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative block"
                >
                  {r.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  )}
                  {r.is_imminent && (
                    <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                      임박
                    </span>
                  )}
                </a>

                {/* 본문 */}
                <div className="flex-1 min-w-0 space-y-1">
                  <a
                    href={r.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className="text-sm font-medium leading-snug hover:underline block"
                    title={r.title}
                  >
                    {r.title}
                  </a>
                  <div className="text-xs text-gray-500">
                    {r.cate_label ?? r.cate_cd} · {r.goods_no}
                  </div>
                  {/* 매칭 근거 */}
                  <div className="flex flex-wrap gap-2 text-xs pt-1">
                    {r.tv_match_count > 0 && (
                      <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                        📺 TV {r.tv_match_count}건 · &quot;{r.tv_top_keyword}&quot; ({r.tv_total_pushes}회 편성)
                      </span>
                    )}
                    {r.search_match_count > 0 && (
                      <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        🔍 검색 {r.search_match_count}건 · &quot;{r.search_top_keyword}&quot;
                      </span>
                    )}
                    {r.search_sources.length > 0 && (
                      <span className="text-gray-500">
                        from {r.search_sources.map(sourceLabel).join(', ')}
                      </span>
                    )}
                    {penalized && (
                      <span className="bg-rose-100 text-rose-700 px-2 py-0.5 rounded" title="같은 카테고리에서 운영자가 반복 기각한 후보">
                        ⚠ 기각학습 패널티 ×{penalty.toFixed(2)}
                        {r.rejected_siblings ? ` (동일군 ${r.rejected_siblings}건` : ''}
                        {r.top_reject_reason ? ` · ${reasonLabel(r.top_reject_reason)})` : r.rejected_siblings ? ')' : ''}
                      </span>
                    )}
                  </div>
                  {/* 운영자 판단 버튼 */}
                  <div className="pt-1.5">
                    <DecisionButtons
                      goodsNo={r.goods_no}
                      cateCd={r.cate_cd}
                      title={r.title}
                      current={decisionByGoods.get(r.goods_no) ?? null}
                    />
                  </div>
                </div>

                {/* 점수 + 가격 */}
                <div className="text-right flex-shrink-0 space-y-1">
                  <div className="text-base font-bold">
                    {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                  </div>
                  <div className="text-2xl font-bold font-mono text-amber-700">
                    {Number(r.final_score).toFixed(1)}
                  </div>
                  <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                    <div>TV {Number(r.tv_score).toFixed(2)} × 1.5</div>
                    <div>검색 {Number(r.search_score).toFixed(2)} × 1.0</div>
                    {r.is_imminent && <div className="text-red-600">× 1.3 (임박)</div>}
                    {penalized && <div className="text-rose-600">× {penalty.toFixed(2)} (기각학습)</div>}
                  </div>
                </div>
              </div>
            </div>
            )
          })}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 ProductScore V0 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          final_score = (tv_score × 1.5 + search_score × 1.0) × imminent_bonus
          <br />
          tv_score = Σ (tv_count × similarity(tv_keyword, ggsan_title))
          <br />
          search_score = Σ (occurrences × similarity(search_keyword, ggsan_title))
          <br />
          imminent_bonus = is_imminent ? 1.3 : 1.0
        </code>
        <div className="pt-2">
          <strong>V1 보강 예정:</strong> ÷ (1 + log(스마트스토어 등록상품수)) saturation_penalty · 커뮤니티 시그널 LLM 정규화 후 추가 · ggsan_price_history 가격 인하 추세 보너스
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
