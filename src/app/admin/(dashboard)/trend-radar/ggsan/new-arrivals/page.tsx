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
  last_seen_at: string
  age_days: number
  top_keyword: string
  best_sim: number
  source_count: number
  sources: string[]
  match_count: number
  total_volume_relative: number
  competitor_sku_count: number
  golden_score: number
}

const DAYS_OPTIONS = [
  { v: 7,  label: '7일' },
  { v: 14, label: '14일 (기본)' },
  { v: 30, label: '30일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15' },
  { v: 0.2,  label: '0.20 (기본)' },
  { v: 0.3,  label: '0.30' },
] as const

const SOURCES_OPTIONS = [
  { v: 1, label: '1+' },
  { v: 2, label: '2+ (기본)' },
  { v: 3, label: '3+' },
] as const

const COMP_OPTIONS = [
  { v: 0, label: '0 (블루오션)' },
  { v: 1, label: '≤1' },
  { v: 3, label: '≤3 (기본)' },
  { v: 10, label: '≤10' },
] as const

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  trends_products:         { label: 'TP',  color: 'bg-purple-100 text-purple-700' },
  naver_search_trend:      { label: 'NSV', color: 'bg-blue-100 text-blue-700' },
  naver_shopping_insight:  { label: 'NSI', color: 'bg-cyan-100 text-cyan-700' },
  naver_shopping_hot:      { label: 'NSH', color: 'bg-teal-100 text-teal-700' },
  google_suggest:          { label: 'GS',  color: 'bg-yellow-100 text-yellow-700' },
  google_trends_kr:        { label: 'GT',  color: 'bg-orange-100 text-orange-700' },
  naver_news:              { label: 'NW',  color: 'bg-pink-100 text-pink-700' },
  naver_tvtime:            { label: 'TV',  color: 'bg-red-100 text-red-700' },
}

async function fetchNewArrivals(opts: {
  days: number
  minSim: number
  minSources: number
  maxCompetitors: number
}) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_ggsan_newarrival_match' as never, {
    days_back: opts.days,
    match_window_days: opts.days,
    min_sim: opts.minSim,
    min_sources: opts.minSources,
    max_competitors: opts.maxCompetitors,
    result_limit: 300,
  } as never)
  if (error) {
    return { rows: [] as NewArrivalRow[], error: error.message }
  }
  return { rows: (data ?? []) as NewArrivalRow[], error: null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ggsan/new-arrivals' + (qs ? `?${qs}` : '')
}

// 간단 sparkline — golden_score 0~max 비례 막대
function Sparkline({ value, max }: { value: number; max: number }) {
  const segments = 10
  const filled = Math.max(0, Math.min(segments, Math.round((value / Math.max(max, 0.0001)) * segments)))
  return (
    <div className="flex items-end gap-[2px] h-4">
      {Array.from({ length: segments }).map((_, i) => {
        const on = i < filled
        const h = 4 + i * 1.2
        return (
          <span
            key={i}
            className={on ? 'bg-amber-500' : 'bg-gray-200'}
            style={{ width: 3, height: `${h}px`, display: 'inline-block' }}
          />
        )
      })}
    </div>
  )
}

function SourceBadge({ source }: { source: string }) {
  const b = SOURCE_BADGE[source] ?? { label: source.slice(0, 3).toUpperCase(), color: 'bg-gray-100 text-gray-700' }
  return (
    <span
      className={`inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded ${b.color}`}
      title={source}
    >
      {b.label}
    </span>
  )
}

export default async function GgsanNewArrivalsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; sources?: string; comp?: string }>
}) {
  const sp = await searchParams
  const daysRaw = parseInt(sp.days ?? '14', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === daysRaw) ? daysRaw : 14
  const simRaw = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - simRaw) < 0.001) ? simRaw : 0.2
  const sourcesRaw = parseInt(sp.sources ?? '2', 10)
  const validSources = SOURCES_OPTIONS.some((s) => s.v === sourcesRaw) ? sourcesRaw : 2
  const compRaw = parseInt(sp.comp ?? '3', 10)
  const validComp = COMP_OPTIONS.some((c) => c.v === compRaw) ? compRaw : 3

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    sources: String(validSources),
    comp: String(validComp),
  }

  const { rows, error } = await fetchNewArrivals({
    days: validDays,
    minSim: validSim,
    minSources: validSources,
    maxCompetitors: validComp,
  })

  const maxScore = rows.reduce((m, r) => (r.golden_score > m ? r.golden_score : m), 0)
  const blueOcean = rows.filter((r) => r.competitor_sku_count === 0).length
  const avgSources = rows.length
    ? rows.reduce((s, r) => s + r.source_count, 0) / rows.length
    : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">신규입고 × 트렌드 시드 (First-Mover)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매 신규 SKU 중 <strong>{validDays}일 내 첫 등장</strong>이면서, 같은 윈도우에
            <strong> {validSources}개 이상 소스</strong>에서 가속 시그널이 잡힌 골든윈도우 후보 ·
            경쟁 SKU ≤ {validComp}
          </p>
        </div>
        <Link href="/admin/trend-radar/ggsan" className="text-sm text-gray-700 hover:text-black underline">
          ← ggsan 카탈로그
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <FilterGroup
          title="신규 윈도우"
          options={DAYS_OPTIONS.map((d) => ({ v: String(d.v), label: d.label }))}
          current={String(validDays)}
          buildHref={(v) => buildHref(current, { days: v })}
        />
        <FilterGroup
          title="유사도 ≥"
          options={SIM_OPTIONS.map((s) => ({ v: String(s.v), label: s.label }))}
          current={String(validSim)}
          buildHref={(v) => buildHref(current, { sim: v })}
        />
        <FilterGroup
          title="소스 수"
          options={SOURCES_OPTIONS.map((s) => ({ v: String(s.v), label: s.label }))}
          current={String(validSources)}
          buildHref={(v) => buildHref(current, { sources: v })}
        />
        <FilterGroup
          title="경쟁 SKU"
          options={COMP_OPTIONS.map((c) => ({ v: String(c.v), label: c.label }))}
          current={String(validComp)}
          buildHref={(v) => buildHref(current, { comp: v })}
        />
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="first-mover 후보" value={rows.length} />
        <Kpi label="🌊 블루오션 (경쟁=0)" value={blueOcean} highlight={blueOcean > 0} />
        <Kpi label="평균 소스 수" value={avgSources.toFixed(2)} />
        <Kpi label="최고 golden score" value={maxScore.toFixed(2)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          RPC 호출 실패: {error}
          <div className="text-xs mt-1 text-red-600">
            마이그레이션이 아직 적용되지 않았을 수 있음 — supabase/trends_v4_ggsan_newarrival_rpc.sql
          </div>
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>조건에 맞는 신규 first-mover 후보 없음</div>
          <div className="text-xs text-gray-400">
            윈도우를 30일로 늘리거나 유사도/소스 수 임계값을 낮춰보세요.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-right">도매가</th>
                <th className="px-3 py-2 text-left">신규</th>
                <th className="px-3 py-2 text-left">매칭 키워드</th>
                <th className="px-3 py-2 text-left">소스</th>
                <th className="px-3 py-2 text-right">유사도</th>
                <th className="px-3 py-2 text-right">경쟁 SKU</th>
                <th className="px-3 py-2 text-left">골든 점수</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const ageHot = r.age_days <= 7
                return (
                  <tr key={r.goods_no} className="hover:bg-amber-50 transition-colors">
                    <td className="px-3 py-2">
                      <a
                        href={r.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className="flex items-start gap-2"
                      >
                        <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                          {r.image_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                          )}
                          {r.is_imminent && (
                            <span className="absolute top-0 left-0 bg-red-600 text-white text-[8px] px-1 leading-tight rounded-br">
                              임박
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium line-clamp-2 leading-snug max-w-xs" title={r.title}>
                            {r.title}
                          </div>
                          <div className="text-[10px] font-mono text-gray-400 mt-0.5">{r.goods_no}</div>
                        </div>
                      </a>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {r.cate_label ?? r.cate_cd ?? '-'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">X</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${ageHot ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {r.age_days}d
                      </span>
                      <div className="text-[10px] text-gray-400 mt-0.5 font-mono">
                        {r.first_seen_at.slice(0, 10)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs max-w-[180px]">
                      <div className="font-medium truncate" title={r.top_keyword}>{r.top_keyword}</div>
                      <div className="text-[10px] text-gray-400">매칭 {r.match_count}건</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.sources.map((s) => (
                          <SourceBadge key={s} source={s} />
                        ))}
                      </div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        {r.source_count} sources
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {Number(r.best_sim).toFixed(3)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                          r.competitor_sku_count === 0
                            ? 'bg-emerald-100 text-emerald-700 font-bold'
                            : r.competitor_sku_count <= 3
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {r.competitor_sku_count}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Sparkline value={r.golden_score} max={maxScore} />
                        <span className="text-xs font-mono text-gray-600">
                          {Number(r.golden_score).toFixed(2)}
                        </span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>판정 기준:</strong>{' '}
          (1) <code>first_seen_at</code> 가 신규 윈도우 안 — 도매몰이 처음 푼 SKU ·
          (2) 같은 시점 ±윈도우 안에 <code>{validSources}개 이상</code> 소스에서 trigram similarity ≥ {validSim} 매칭 ·
          (3) 같은 매칭 키워드를 공유하는 기존 ggsan SKU 수가 <code>{validComp}</code> 이하면 카탈로그가 비어있는 골든윈도우.
        </div>
        <div>
          <strong>골든 점수</strong> = source_count × best_sim × ln(match_count + 1) — 다소스·강매칭·다빈도일수록 상승.
        </div>
      </section>
    </div>
  )
}

function FilterGroup({
  title,
  options,
  current,
  buildHref,
}: {
  title: string
  options: { v: string; label: string }[]
  current: string
  buildHref: (v: string) => string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500">{title}</span>
      {options.map((o) => (
        <Link
          key={o.v}
          href={buildHref(o.v)}
          className={`px-2 py-1 text-xs rounded ${current === o.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
        >
          {o.label}
        </Link>
      ))}
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
