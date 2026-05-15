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
  final_score: number

  tv_match_count: number
  tv_top_keyword: string
  tv_total_pushes: number
  search_match_count: number
  search_top_keyword: string
  search_sources: string[]
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

interface CompetitionRow {
  goods_no: string
  listing_count: number
  price_p25: number | null
  price_p50: number | null
  price_p75: number | null
  top_mall_name: string | null
  top_mall_share: number | null
  oversea_share: number | null
  saturation: number | null
  captured_at: string
}

type EnrichedRow = RecommendRow & {
  competition: CompetitionRow | null
  blue_ocean: number
}

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
    return { rows: [] as EnrichedRow[], error: error.message }
  }
  let rows = (data ?? []) as RecommendRow[]
  if (opts.imminentOnly) rows = rows.filter((r) => r.is_imminent)
  if (opts.cate) rows = rows.filter((r) => r.cate_cd === opts.cate)

  // 경쟁밀도 latest view 매칭 (없으면 null)
  const goodsNos = rows.map((r) => r.goods_no)
  const compMap = new Map<string, CompetitionRow>()
  if (goodsNos.length > 0) {
    const { data: comp } = await sb
      .from('jimscanner_competition_latest' as never)
      .select(
        'goods_no, listing_count, price_p25, price_p50, price_p75, top_mall_name, top_mall_share, oversea_share, saturation, captured_at',
      )
      .in('goods_no', goodsNos)
    for (const c of ((comp ?? []) as unknown as CompetitionRow[])) {
      compMap.set(c.goods_no, c)
    }
  }

  const enriched: EnrichedRow[] = rows.map((r) => {
    const c = compMap.get(r.goods_no) ?? null
    const sat = c?.saturation ?? 0
    const blueOcean = Number(r.final_score) / (sat + 1)
    return { ...r, competition: c, blue_ocean: blueOcean }
  })
  return { rows: enriched, error: null as string | null }
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

type SortKey = 'final' | 'blue_ocean'

export default async function RecommendPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; imminent?: string; cate?: string; sort?: string; blueOnly?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const imminentOnly = sp.imminent === '1'
  const cate = sp.cate ?? ''
  const sort: SortKey = sp.sort === 'blue_ocean' ? 'blue_ocean' : 'final'
  const blueOnly = sp.blueOnly === '1'

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    imminent: imminentOnly ? '1' : '',
    cate,
    sort,
    blueOnly: blueOnly ? '1' : '',
  }

  const result = await fetchRecommend({ days: validDays, minSim: validSim, imminentOnly, cate })
  const error = result.error
  let rows = result.rows
  // '경쟁 낮음' 필터 (saturation < 1.0 또는 데이터 없음)
  if (blueOnly) rows = rows.filter((r) => (r.competition?.saturation ?? 0) < 1.0)
  if (sort === 'blue_ocean') {
    rows = [...rows].sort((a, b) => b.blue_ocean - a.blue_ocean)
  }

  // KPI
  const total = rows.length
  const imminentCount = rows.filter((r) => r.is_imminent).length
  const tvHitCount = rows.filter((r) => r.tv_score > 0).length
  const searchHitCount = rows.filter((r) => r.search_score > 0).length
  const avgFinal = rows.length > 0 ? rows.reduce((s, r) => s + Number(r.final_score), 0) / rows.length : 0
  const compCovered = rows.filter((r) => r.competition).length
  const blueOceanCount = rows.filter((r) => r.competition && (r.competition.saturation ?? 0) < 1.0).length

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

      {/* 알림: V0 한계 + V1 경쟁밀도 */}
      <div className="rounded border border-cyan-200 bg-cyan-50 px-4 py-3 text-xs text-cyan-900">
        <strong>V1 신규</strong> · Naver Shopping 경쟁밀도 스냅샷 추가. saturation = log(listing+1) × top_mall_share,
        blue_ocean = final_score / (saturation + 1). 매일 19:30 cron 으로 ggsan_recent 200건 수집.
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
          <div className="flex items-center gap-2 border-l border-gray-200 pl-3">
            <span className="text-xs text-gray-500">정렬</span>
            <Link
              href={buildHref(current, { sort: 'final' })}
              className={`px-2 py-1 text-xs rounded ${sort === 'final' ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              final_score
            </Link>
            <Link
              href={buildHref(current, { sort: 'blue_ocean' })}
              className={`px-2 py-1 text-xs rounded ${sort === 'blue_ocean' ? 'bg-cyan-100 text-cyan-800 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              🌊 blue_ocean
            </Link>
          </div>
          <Link
            href={buildHref(current, { blueOnly: blueOnly ? null : '1' })}
            className={`px-3 py-1 text-xs rounded ${blueOnly ? 'bg-cyan-100 text-cyan-800 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {blueOnly ? '✓ ' : ''}경쟁 낮음만
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
      <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Kpi label="후보 상품" value={total} />
        <Kpi label="🔥 임박특가" value={imminentCount} highlight={imminentCount > 0} />
        <Kpi label="TV 매칭" value={tvHitCount} />
        <Kpi label="검색 매칭" value={searchHitCount} />
        <Kpi label="평균 final_score" value={avgFinal.toFixed(2)} />
        <Kpi
          label={`🌊 blue ocean (${compCovered}/${total})`}
          value={blueOceanCount}
          highlight={blueOceanCount > 0}
        />
      </section>

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
          {rows.map((r, i) => (
            <a
              key={r.goods_no}
              href={r.detail_url ?? '#'}
              target="_blank"
              rel="noopener"
              className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                r.is_imminent
                  ? 'border-red-200 bg-red-50/40 hover:bg-red-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                {/* 순위 */}
                <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">
                  {i + 1}
                </div>

                {/* 이미지 */}
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

                {/* 본문 */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="text-sm font-medium leading-snug" title={r.title}>
                    {r.title}
                  </div>
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
                    {r.competition ? (
                      (() => {
                        const c = r.competition!
                        const sat = c.saturation ?? 0
                        const lowComp = sat < 1.0
                        return (
                          <span
                            className={`px-2 py-0.5 rounded ${
                              lowComp ? 'bg-cyan-100 text-cyan-800' : 'bg-gray-200 text-gray-700'
                            }`}
                            title={`top mall: ${c.top_mall_name ?? '—'} · 해외직구 ${(((c.oversea_share ?? 0) * 100)).toFixed(0)}%`}
                          >
                            🛒 {c.listing_count.toLocaleString()}건
                            {c.top_mall_share != null && (
                              <> · top {(c.top_mall_share * 100).toFixed(0)}%</>
                            )}
                            {' · sat '}
                            {sat.toFixed(2)}
                          </span>
                        )
                      })()
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-400">
                        🛒 경쟁 N/A
                      </span>
                    )}
                  </div>
                  {r.competition?.price_p50 != null && (
                    <div className="text-[11px] text-gray-500 font-mono pt-0.5">
                      네이버 가격 P25/P50/P75:{' '}
                      {(r.competition.price_p25 ?? 0).toLocaleString()} /{' '}
                      <span className="text-gray-700 font-semibold">
                        {(r.competition.price_p50 ?? 0).toLocaleString()}
                      </span>{' '}
                      / {(r.competition.price_p75 ?? 0).toLocaleString()}
                      {r.price_krw != null && r.competition.price_p50 != null && (
                        <>
                          {' '}
                          · 도매 vs P50 마진{' '}
                          <span
                            className={
                              r.competition.price_p50 - r.price_krw > 0
                                ? 'text-emerald-700 font-semibold'
                                : 'text-red-700 font-semibold'
                            }
                          >
                            {(r.competition.price_p50 - r.price_krw).toLocaleString()}원
                          </span>
                        </>
                      )}
                    </div>
                  )}
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
                  </div>
                  <div className="border-t border-gray-100 pt-1">
                    <div className="text-[10px] text-cyan-700 uppercase">blue ocean</div>
                    <div className="text-base font-bold font-mono text-cyan-800">
                      {r.blue_ocean.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            </a>
          ))}
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
          <strong>V1 신규 (경쟁밀도):</strong> blue_ocean = final_score ÷ (saturation + 1) · saturation = ln(listing_count + 1) × top_mall_share ·
          데이터 출처 jimscanner_competition_latest view (Naver /v1/search/shop daily snapshot).
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
