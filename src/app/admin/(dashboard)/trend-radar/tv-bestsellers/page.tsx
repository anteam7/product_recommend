import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// supabase/tv_bestsellers_rpc.sql 의 RETURNS TABLE 미러
interface BestsellerRow {
  keyword: string
  runs_7d: number
  runs_14d: number
  runs_30d: number
  prev_week_runs: number
  acceleration: number
  slot_diversity: number
  slot_bands: string[]
  total_pushes_30d: number
  first_seen: string
  last_seen: string
  spark: number[] | null
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  ggsan_cate_label: string | null
  ggsan_is_imminent: boolean | null
  ggsan_detail_url: string | null
  ggsan_sim: number | null
  bestseller_score: number
}

const MIN_RUNS_OPTIONS = [
  { v: 2, label: '2회+ (기본)' },
  { v: 3, label: '3회+' },
  { v: 5, label: '5회+ (강한 위너)' },
] as const

async function fetchBestsellers(opts: { minRuns: number; sourcedOnly: boolean }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/tv_bestsellers_rpc.sql)에 존재하나 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_tv_bestsellers' as never, {
    min_runs: opts.minRuns,
    min_sim: 0.2,
    result_limit: 200,
  } as never)
  if (error) return { rows: [] as BestsellerRow[], error: error.message }
  let rows = (data ?? []) as BestsellerRow[]
  if (opts.sourcedOnly) rows = rows.filter((r) => r.ggsan_goods_no != null)
  return { rows, error: null as string | null }
}

function Spark({ data }: { data: number[] | null }) {
  const arr = data ?? []
  const max = Math.max(1, ...arr)
  return (
    <div className="flex items-end gap-px h-7" title={`최근 14일 일별 방송회차: ${arr.join(',')}`}>
      {arr.map((c, i) => {
        // 최근 7일(오른쪽 절반) 강조
        const recent = i >= arr.length - 7
        return (
          <div
            key={i}
            className={`w-1 rounded-t ${c === 0 ? 'bg-gray-100' : recent ? 'bg-amber-500' : 'bg-amber-300'}`}
            style={{ height: `${Math.max(8, (c / max) * 100)}%` }}
          />
        )
      })}
    </div>
  )
}

function AccelBadge({ a }: { a: number }) {
  if (a >= 1.5)
    return <span className="text-green-700 font-semibold">▲ {a.toFixed(2)}×</span>
  if (a <= 0.67)
    return <span className="text-gray-400">▼ {a.toFixed(2)}×</span>
  return <span className="text-gray-500">→ {a.toFixed(2)}×</span>
}

export default async function TvBestsellersPage({
  searchParams,
}: {
  searchParams: Promise<{ minRuns?: string; sourced?: string }>
}) {
  const sp = await searchParams
  const minRuns = parseInt(sp.minRuns ?? '2', 10)
  const validMinRuns = MIN_RUNS_OPTIONS.some((o) => o.v === minRuns) ? minRuns : 2
  const sourcedOnly = sp.sourced === '1'

  const { rows, error } = await fetchBestsellers({ minRuns: validMinRuns, sourcedOnly })

  const total = rows.length
  const sourcedCount = rows.filter((r) => r.ggsan_goods_no != null).length
  const acceleratingCount = rows.filter((r) => r.acceleration >= 1.5).length
  const multiSlotCount = rows.filter((r) => r.slot_diversity >= 3).length

  function href(override: Record<string, string | null>): string {
    const params = new URLSearchParams()
    if (validMinRuns !== 2) params.set('minRuns', String(validMinRuns))
    if (sourcedOnly) params.set('sourced', '1')
    for (const [k, v] of Object.entries(override)) {
      if (v == null) params.delete(k)
      else params.set(k, v)
    }
    const qs = params.toString()
    return '/admin/trend-radar/tv-bestsellers' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📺 TV 검증 베스트셀러</h1>
          <p className="text-sm text-gray-500 mt-1">
            홈쇼핑 <strong>재편성 빈도 = 검증된 실판매</strong> 프록시. MD는 매출목표를 친 상품만 재편성한다.
            반복 편성 × 도매 소싱 가능 상품을 surface.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>왜 빈도인가</strong> · 홈쇼핑 1슬롯 수천만원 → 직전 방송에서 매출목표 미달이면 즉시 빼버린다.
        그래서 <strong>반복 재편성</strong>은 검색량(구경꾼 포함)·리뷰(후행)보다 누수가 적은 신호다.
        방송회차 = DISTINCT(날짜, 시간슬롯) — 하루 2회 스냅샷 중복 제거 후 집계.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">30일 방송회차</span>
          {MIN_RUNS_OPTIONS.map((o) => (
            <Link
              key={o.v}
              href={href({ minRuns: o.v === 2 ? null : String(o.v) })}
              className={`px-2 py-1 text-xs rounded ${validMinRuns === o.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {o.label}
            </Link>
          ))}
        </div>
        <Link
          href={href({ sourced: sourcedOnly ? null : '1' })}
          className={`px-3 py-1 text-xs rounded ${sourcedOnly ? 'bg-green-100 text-green-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {sourcedOnly ? '✓ ' : ''}도매 소싱 가능만
        </Link>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="베스트셀러 후보" value={total} />
        <Kpi label="🛒 도매 소싱 가능" value={sourcedCount} highlight={sourcedCount > 0} />
        <Kpi label="▲ 가속중 (≥1.5×)" value={acceleratingCount} />
        <Kpi label="멀티슬롯 (≥3밴드)" value={multiSlotCount} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_tv_bestsellers</code> 가 DB에 적용 안 됐을 가능성. supabase/tv_bestsellers_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 후보 없음</div>
          <div className="text-xs text-gray-400">
            naver_tvtime 누적이 부족하거나(최소 7일 권장) min_runs 가 너무 높음. 2회+ 로 낮춰보기.
          </div>
        </div>
      ) : (
        <section>
          <div className="rounded border border-gray-200 divide-y divide-gray-100 overflow-hidden">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 bg-gray-50">
              <div className="col-span-1">#</div>
              <div className="col-span-3">상품명 (TV 편성)</div>
              <div className="col-span-2">주간 편성회차</div>
              <div className="col-span-1 text-right">7d</div>
              <div className="col-span-1 text-right">가속</div>
              <div className="col-span-1 text-center">슬롯</div>
              <div className="col-span-2">도매 소싱(ggsan)</div>
              <div className="col-span-1 text-right">점수</div>
            </div>
            {rows.slice(0, 150).map((r, i) => (
              <div key={r.keyword} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-3 min-w-0">
                  <div className="truncate font-medium" title={r.keyword}>{r.keyword}</div>
                  <div className="text-[10px] text-gray-400">
                    {r.slot_bands.filter((b) => b !== '미상').join('·') || '—'} · 30d {r.runs_30d}회
                  </div>
                </div>
                <div className="col-span-2">
                  <Spark data={r.spark} />
                </div>
                <div className="col-span-1 text-right font-mono font-bold">{r.runs_7d}</div>
                <div className="col-span-1 text-right text-xs">
                  <AccelBadge a={r.acceleration} />
                </div>
                <div className="col-span-1 text-center">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-xs ${r.slot_diversity >= 3 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-400'}`}
                    title={r.slot_bands.join(', ')}
                  >
                    {r.slot_diversity}
                  </span>
                </div>
                <div className="col-span-2 min-w-0 text-xs">
                  {r.ggsan_goods_no ? (
                    <a
                      href={r.ggsan_detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="block hover:underline text-green-700"
                      title={r.ggsan_title ?? ''}
                    >
                      <span className="truncate block">
                        🛒 {r.ggsan_price_krw ? `${r.ggsan_price_krw.toLocaleString()}원` : '가격X'}
                        {r.ggsan_is_imminent && <span className="ml-1 text-red-600">임박</span>}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {r.ggsan_cate_label ?? ''} · sim {r.ggsan_sim?.toFixed(2)}
                      </span>
                    </a>
                  ) : (
                    <span className="text-gray-300">소싱 미발견</span>
                  )}
                </div>
                <div className="col-span-1 text-right font-mono font-bold text-amber-700">
                  {r.bestseller_score.toFixed(1)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 BestsellerScore 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          방송회차 = DISTINCT(keyword, 날짜, 시간슬롯)  — 스냅샷 중복 제거
          <br />
          가속도 = (runs_7d + 1) / (prev_week_runs + 1)  — 이번주 vs 지난주
          <br />
          score = (runs_7d × 1.0 + runs_14d × 0.3) × min(가속도, 3) × (1 + 0.15 × 슬롯다양성)
        </code>
        <div className="pt-2">
          <strong>V1 보강 예정:</strong> 쿠팡 등록상품수 saturation_penalty(저포화 위너 우선) ·
          collect-naver-tvtime 채널명 파싱 시 멀티채널 재편성 합의 컬럼
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-green-300 bg-green-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-green-700' : ''}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
