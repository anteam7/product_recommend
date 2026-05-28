import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// TV 편성 포화도 역게이트 — '수요 높음 × TV편성 낮음' 조용한 틈새 발굴 보드
interface GateRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  ggsan_last_seen: string

  search_demand: number
  tv_push: number
  search_pctile: number
  tv_pctile: number
  tv_quiet_score: number
  quadrant: 'quiet_niche' | 'hot_redocean' | 'low_demand' | 'contested'

  search_match_count: number
  search_top_keyword: string
  search_sources: string[]
  tv_match_count: number
  tv_top_keyword: string
  tv_total_pushes: number
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

const QUADRANT_META: Record<
  GateRow['quadrant'],
  { label: string; desc: string; dot: string; badge: string }
> = {
  quiet_niche: {
    label: '🟢 조용한 틈새',
    desc: '수요↑ · TV편성↓ — 대형사 무관심, 소형 셀러가 이길 수 있는 황금 사분면',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-800',
  },
  hot_redocean: {
    label: '🔴 TV 레드오션',
    desc: '수요↑ · TV편성↑ — 대형사·브랜드가 광고비로 장악한 진입 함정',
    dot: 'bg-red-500',
    badge: 'bg-red-100 text-red-700',
  },
  contested: {
    label: '🟠 경쟁 과열',
    desc: '수요↓ · TV편성↑ — 수요 대비 TV 노출 과다, 비추천',
    dot: 'bg-orange-400',
    badge: 'bg-orange-100 text-orange-700',
  },
  low_demand: {
    label: '⚪ 저수요',
    desc: '수요↓ · TV편성↓ — 양쪽 모두 한산, 보류',
    dot: 'bg-gray-400',
    badge: 'bg-gray-100 text-gray-600',
  },
}

async function fetchGate(opts: { days: number; minSim: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/tv_saturation_gate_rpc.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_tv_saturation_gate' as never, {
    days_window: opts.days,
    min_sim: opts.minSim,
    result_limit: 300,
  } as never)
  if (error) return { rows: [] as GateRow[], error: error.message }
  return { rows: (data ?? []) as GateRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/tv-quiet' + (qs ? `?${qs}` : '')
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

export default async function TvQuietPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; q?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const quadFilter = (sp.q ?? '') as '' | GateRow['quadrant']

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    q: quadFilter,
  }

  const { rows, error } = await fetchGate({ days: validDays, minSim: validSim })

  // 사분면 카운트
  const quadCount: Record<GateRow['quadrant'], number> = {
    quiet_niche: 0,
    hot_redocean: 0,
    contested: 0,
    low_demand: 0,
  }
  for (const r of rows) quadCount[r.quadrant]++

  const filtered = quadFilter ? rows.filter((r) => r.quadrant === quadFilter) : rows

  // 산점도용 — 모든 점 (필터와 무관하게 분포 보여줌)
  const PLOT = 320 // px
  const points = rows.map((r) => ({
    goods_no: r.goods_no,
    title: r.title,
    quadrant: r.quadrant,
    // x = TV편성 백분위 (경쟁압), y = 검색수요 백분위
    x: r.tv_pctile * PLOT,
    y: PLOT - r.search_pctile * PLOT, // SVG y축 반전
  }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📉 TV-Quiet 틈새 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            TV홈쇼핑 편성을 <strong>경쟁압 프록시</strong>로 역해석 — &lsquo;수요 높음 × TV편성 낮음&rsquo; 조용한 틈새 발굴
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
        <strong>역게이트 발상</strong> · recommend 보드는 TV편성을 <em>가점</em>으로 더해 대형사 포화
        카테고리로 발굴이 쏠린다. 여기선 정반대로 — TV편성이 <strong>낮을수록</strong> 소형 위탁 셀러에게
        조용한 기회다. <code className="font-mono">tv_quiet_score = 검색수요 백분위 − TV편성 백분위</code>
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
        </div>
      </div>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_tv_saturation_gate</code> 가 DB에 적용 안 됐을 가능성. supabase/tv_saturation_gate_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 사분면 KPI (= 필터 토글) */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(Object.keys(QUADRANT_META) as GateRow['quadrant'][]).map((q) => {
          const meta = QUADRANT_META[q]
          const active = quadFilter === q
          return (
            <Link
              key={q}
              href={buildHref(current, { q: active ? null : q })}
              className={`rounded border p-3 transition-colors ${
                active ? 'border-black ring-1 ring-black' : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className={`inline-block w-2 h-2 rounded-full ${meta.dot}`} />
                {meta.label}
              </div>
              <div className="text-2xl font-bold mt-1">{quadCount[q]}</div>
            </Link>
          )
        })}
      </section>

      {/* 2축 산점도 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-3">
          2축 산점도{' '}
          <span className="text-xs font-normal text-gray-500">
            (x = TV편성 백분위 · y = 검색수요 백분위 · 좌상단 = 조용한 틈새)
          </span>
        </h2>
        <div className="flex justify-center">
          <div className="relative" style={{ width: PLOT, height: PLOT }}>
            {/* 사분면 배경 */}
            <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
              <div className="bg-emerald-50/60 border-r border-b border-gray-200" title="조용한 틈새" />
              <div className="bg-red-50/50 border-b border-gray-200" title="TV 레드오션" />
              <div className="bg-gray-50 border-r border-gray-200" title="저수요" />
              <div className="bg-orange-50/50" title="경쟁 과열" />
            </div>
            {/* 점 */}
            <svg width={PLOT} height={PLOT} className="absolute inset-0">
              {points.map((p) => (
                <circle
                  key={p.goods_no}
                  cx={p.x}
                  cy={p.y}
                  r={3}
                  className={
                    p.quadrant === 'quiet_niche' ? 'fill-emerald-500'
                    : p.quadrant === 'hot_redocean' ? 'fill-red-500'
                    : p.quadrant === 'contested' ? 'fill-orange-400'
                    : 'fill-gray-400'
                  }
                  opacity={0.7}
                >
                  <title>{`${p.title}`}</title>
                </circle>
              ))}
            </svg>
            {/* 축 라벨 */}
            <span className="absolute top-1 left-1 text-[10px] font-semibold text-emerald-700">🟢 조용한 틈새</span>
            <span className="absolute top-1 right-1 text-[10px] font-semibold text-red-700">🔴 레드오션</span>
            <span className="absolute bottom-1 left-1 text-[10px] text-gray-400">⚪ 저수요</span>
            <span className="absolute bottom-1 right-1 text-[10px] text-orange-600">🟠 과열</span>
          </div>
        </div>
        <div className="flex justify-between text-[10px] text-gray-400 mt-1" style={{ maxWidth: PLOT, margin: '4px auto 0' }}>
          <span>← TV편성 낮음</span>
          <span>TV편성 높음 →</span>
        </div>
      </section>

      {/* 결과 목록 */}
      {!error && filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 후보 없음</div>
          <div className="text-xs text-gray-400">
            검색·쇼핑 시그널과 매칭되는 ggsan 상품이 아직 부족합니다. min_sim 을 0.15 로 낮추거나
            기간을 60일로 늘려보세요. 누적되면 자동 풍부해집니다.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">
            후보 목록{' '}
            <span className="text-xs font-normal text-gray-500">
              ({quadFilter ? QUADRANT_META[quadFilter].label : '전체'} · {filtered.length}개 · tv_quiet_score 순)
            </span>
          </h2>
          {filtered.map((r, i) => {
            const meta = QUADRANT_META[r.quadrant]
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                  r.quadrant === 'quiet_niche'
                    ? 'border-emerald-200 bg-emerald-50/30 hover:bg-emerald-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                  <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
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
                      <span className={`px-2 py-0.5 rounded ${meta.badge}`}>{meta.label}</span>
                      {r.search_match_count > 0 && (
                        <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                          🔍 검색 {r.search_match_count}건 · &quot;{r.search_top_keyword}&quot;
                        </span>
                      )}
                      {/* TV 가점 → 경쟁압 경고 배지로 재해석 */}
                      {r.tv_match_count > 0 ? (
                        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded" title="TV홈쇼핑 편성 = 대형사 경쟁압">
                          ⚠️ TV 경쟁압 · &quot;{r.tv_top_keyword}&quot; ({r.tv_total_pushes}회 편성)
                        </span>
                      ) : (
                        <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">
                          ✓ TV 무편성 (조용)
                        </span>
                      )}
                      {r.search_sources.length > 0 && (
                        <span className="text-gray-500">
                          from {r.search_sources.map(sourceLabel).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0 space-y-1">
                    <div className="text-base font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                    </div>
                    <div className={`text-2xl font-bold font-mono ${r.tv_quiet_score >= 0 ? 'text-emerald-700' : 'text-gray-400'}`}>
                      {r.tv_quiet_score >= 0 ? '+' : ''}{Number(r.tv_quiet_score).toFixed(2)}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                      <div>수요 {(Number(r.search_pctile) * 100).toFixed(0)}%ile</div>
                      <div className={r.tv_pctile > 0.5 ? 'text-red-600' : ''}>
                        TV {(Number(r.tv_pctile) * 100).toFixed(0)}%ile
                      </div>
                    </div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 TV-Quiet 역게이트 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          tv_quiet_score = search_pctile − tv_pctile  (범위 −1 ~ +1)
          <br />
          search_pctile = percent_rank(검색·쇼핑 수요 강도)  &nbsp;// 결과 집합 내 백분위
          <br />
          tv_pctile = percent_rank(naver_tvtime 편성 강도)  &nbsp;// 경쟁압 프록시
          <br />
          quadrant = 검색 백분위 / TV 백분위 ≥ 0.5 기준 4분면
        </code>
        <div className="pt-2">
          <strong>해석:</strong> 🟢 조용한 틈새(score 큰 +) = 수요는 검증됐는데 대형사 TV 광고가 없는 구간 →
          소형 위탁 셀러 진입 적격. 🔴 레드오션(score 큰 −) = TV 광고비 전쟁터, 진입 함정.
        </div>
      </section>
    </div>
  )
}
