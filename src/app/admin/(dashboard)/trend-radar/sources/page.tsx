import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RunRow {
  source: string
  status: string
  fetched_count: number
  inserted_count: number
  duration_ms: number | null
  error_message: string | null
  started_at: string
  triggered_by: string | null
}

interface MarketRawAggRow {
  source: string
  last_at: string
  rows_24h: number
  rows_7d: number
}

interface SourceAttributionRow {
  source: string
  alias_count: number
  linked_product_count: number
  scored_product_count: number
  avg_final_score: number | null
  high_score_count: number
  high_score_pct: number | null
  first_discovery_count: number
  latest_alias_at: string | null
}

// trends_runs 에 기록되는 source — Naver DataLab + tvtime + 분류기
const TRENDS_RUNS_GROUPS: { label: string; sources: string[] }[] = [
  {
    label: 'Naver DataLab 시그널',
    sources: ['naver_search_trend', 'naver_shopping_insight'],
  },
  {
    label: 'TV·홈쇼핑 시그널',
    sources: ['naver_tvtime'],
  },
  {
    label: 'LLM 분류',
    sources: ['classify_trends_llm'],
  },
]

// market_raw 에 직접 적재되는 수집기 (별도 logging 없음)
const MARKET_RAW_SOURCES = [
  'google_suggest',
  'naver_news',
  'naver_blog',
  'clien_park',
  'quasarzone_sale',
  'kca_press',
]

async function fetchData() {
  const sb = createAdminClient()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [runs, raw24, raw7, attribution] = await Promise.all([
    sb
      .from('jimscanner_trends_runs')
      .select('source, status, fetched_count, inserted_count, duration_ms, error_message, started_at, triggered_by')
      .order('started_at', { ascending: false })
      .limit(200),
    sb
      .from('jimscanner_market_raw')
      .select('source, captured_at')
      .in('source', MARKET_RAW_SOURCES)
      .gte('captured_at', since24h),
    sb
      .from('jimscanner_market_raw')
      .select('source, captured_at')
      .in('source', MARKET_RAW_SOURCES)
      .gte('captured_at', since7d),
    // RPC: supabase/source_attribution_rpc.sql — generated 타입 미반영이라 `as never` 캐스팅
    sb.rpc('get_source_attribution' as never, { days_window: 7 } as never),
  ])

  // source 별 가장 최근 run
  const latestBySource = new Map<string, RunRow>()
  for (const r of (runs.data ?? []) as RunRow[]) {
    if (!latestBySource.has(r.source)) latestBySource.set(r.source, r)
  }

  // market_raw 집계 (수집기별 24h / 7d 카운트 + 가장 최근 시각)
  const marketAgg = new Map<string, MarketRawAggRow>()
  for (const s of MARKET_RAW_SOURCES) {
    marketAgg.set(s, { source: s, last_at: '', rows_24h: 0, rows_7d: 0 })
  }
  for (const r of (raw7.data ?? []) as { source: string; captured_at: string }[]) {
    const agg = marketAgg.get(r.source)
    if (!agg) continue
    agg.rows_7d++
    if (!agg.last_at || r.captured_at > agg.last_at) agg.last_at = r.captured_at
  }
  for (const r of (raw24.data ?? []) as { source: string; captured_at: string }[]) {
    const agg = marketAgg.get(r.source)
    if (!agg) continue
    agg.rows_24h++
  }

  const attributionRows = ((attribution?.data as SourceAttributionRow[] | null) ?? []).map((r) => ({
    ...r,
    alias_count: Number(r.alias_count ?? 0),
    linked_product_count: Number(r.linked_product_count ?? 0),
    scored_product_count: Number(r.scored_product_count ?? 0),
    avg_final_score: r.avg_final_score != null ? Number(r.avg_final_score) : null,
    high_score_count: Number(r.high_score_count ?? 0),
    high_score_pct: r.high_score_pct != null ? Number(r.high_score_pct) : null,
    first_discovery_count: Number(r.first_discovery_count ?? 0),
  }))

  return {
    latestBySource,
    marketAgg,
    recentRuns: ((runs.data ?? []) as RunRow[]).slice(0, 50),
    attributionRows,
    attributionError: (attribution as { error?: { message?: string } } | null)?.error?.message ?? null,
  }
}

function ageMinutes(iso: string): number {
  if (!iso) return Infinity
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000)
}

function formatAge(min: number): string {
  if (!isFinite(min)) return '—'
  if (min < 60) return `${min}m 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h 전`
  return `${Math.floor(h / 24)}d 전`
}

export default async function SourcesPage() {
  const { latestBySource, marketAgg, recentRuns, attributionRows, attributionError } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">소스 헬스</h1>
          <p className="text-sm text-gray-500 mt-1">
            v4 cron — Naver DataLab + tvtime + market_raw 시그널 + LLM 분류
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* trends_runs 기반 collector 그룹 */}
      {TRENDS_RUNS_GROUPS.map((group) => (
        <section key={group.label}>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{group.label}</h2>
          <div className="rounded border border-gray-200 divide-y divide-gray-200">
            {group.sources.map((src) => {
              const r = latestBySource.get(src)
              const age = r ? ageMinutes(r.started_at) : null
              const flag = !r
                ? '○'
                : r.status === 'ok'
                  ? '✓'
                  : r.status === 'partial'
                    ? '◐'
                    : '✗'
              const flagColor = !r
                ? 'text-gray-300'
                : r.status === 'ok'
                  ? 'text-green-600'
                  : r.status === 'partial'
                    ? 'text-yellow-600'
                    : 'text-red-600'
              return (
                <div key={src} className="grid grid-cols-12 px-3 py-2 items-center text-sm">
                  <div className={`col-span-1 text-lg ${flagColor}`}>{flag}</div>
                  <div className="col-span-3 font-mono">{src}</div>
                  <div className="col-span-2 text-right text-gray-600">
                    {r ? `${r.fetched_count} → ${r.inserted_count}` : '—'}
                  </div>
                  <div className="col-span-2 text-right text-gray-500">
                    {r?.duration_ms ? `${r.duration_ms}ms` : '—'}
                  </div>
                  <div className="col-span-2 text-right text-gray-500">
                    {age != null ? formatAge(age) : '—'}
                  </div>
                  <div className="col-span-2 text-right text-xs text-gray-400 truncate">
                    {r?.error_message ?? r?.triggered_by ?? '—'}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {/* market_raw 기반 수요 시그널 수집기 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          수요 시그널 (market_raw 직접 적재)
        </h2>
        <p className="text-xs text-gray-500 mb-2">
          이 수집기들은 trends_runs 에 별도 로깅 없이 market_raw 테이블 카운트로 헬스 확인.
        </p>
        <div className="rounded border border-gray-200 divide-y divide-gray-200">
          {MARKET_RAW_SOURCES.map((src) => {
            const agg = marketAgg.get(src)!
            const age = agg.last_at ? ageMinutes(agg.last_at) : null
            const hasRecent = age != null && age < 48 * 60
            const flag = !agg.last_at ? '○' : hasRecent ? '✓' : '⚠'
            const flagColor = !agg.last_at
              ? 'text-gray-300'
              : hasRecent
                ? 'text-green-600'
                : 'text-yellow-600'
            return (
              <div key={src} className="grid grid-cols-12 px-3 py-2 items-center text-sm">
                <div className={`col-span-1 text-lg ${flagColor}`}>{flag}</div>
                <div className="col-span-3 font-mono">{src}</div>
                <div className="col-span-2 text-right text-gray-600">
                  24h: {agg.rows_24h}
                </div>
                <div className="col-span-2 text-right text-gray-500">
                  7d: {agg.rows_7d}
                </div>
                <div className="col-span-2 text-right text-gray-500">
                  {age != null ? formatAge(age) : '—'}
                </div>
                <div className="col-span-2 text-right text-xs text-gray-400">market_raw</div>
              </div>
            )
          })}
        </div>
      </section>

      {/* 최근 50 run 로그 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">최근 50 run (trends_runs)</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">started_at</th>
                <th className="px-3 py-2 text-left">source</th>
                <th className="px-3 py-2 text-left">status</th>
                <th className="px-3 py-2 text-right">fetched</th>
                <th className="px-3 py-2 text-right">inserted</th>
                <th className="px-3 py-2 text-right">duration</th>
                <th className="px-3 py-2 text-left">trigger</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recentRuns.map((r, i) => (
                <tr key={i}>
                  <td className="px-3 py-1 font-mono text-gray-600">{r.started_at?.slice(5, 19)}</td>
                  <td className="px-3 py-1 font-mono">{r.source}</td>
                  <td
                    className={`px-3 py-1 ${
                      r.status === 'ok'
                        ? 'text-green-600'
                        : r.status === 'partial'
                          ? 'text-yellow-600'
                          : 'text-red-600'
                    }`}
                  >
                    {r.status}
                  </td>
                  <td className="px-3 py-1 text-right">{r.fetched_count}</td>
                  <td className="px-3 py-1 text-right">{r.inserted_count}</td>
                  <td className="px-3 py-1 text-right text-gray-500">{r.duration_ms}ms</td>
                  <td className="px-3 py-1 text-gray-500">{r.triggered_by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Source ROI — 소스별 발굴 성과 귀속 분석 (최근 7일) */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">
            Source ROI — 발굴 성과 귀속 (최근 7일)
          </h2>
          <span className="text-xs text-gray-500">
            jimscanner_trends_aliases × jimscanner_trends_scores
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-2">
          각 수집 소스가 실제로 가치 있는 상품을 얼마나 발굴하는지 정량화. 평균 final_score ·
          고점수(≥70) 비율 · 최초 발굴 기여 건수로 유지·폐기·강화 결정 근거.
        </p>
        {attributionError ? (
          <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800">
            RPC 호출 실패: <code className="font-mono">{attributionError}</code>
            {' — '}
            <code className="font-mono">supabase/source_attribution_rpc.sql</code> 적용 필요.
          </div>
        ) : attributionRows.length === 0 ? (
          <div className="rounded border border-gray-200 p-4 text-xs text-gray-500">
            최근 7일 내 생성된 alias 가 없습니다.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">source</th>
                  <th className="px-3 py-2 text-right">alias 수</th>
                  <th className="px-3 py-2 text-right">연결 product</th>
                  <th className="px-3 py-2 text-right">scored product</th>
                  <th className="px-3 py-2 text-right">평균 final_score</th>
                  <th className="px-3 py-2 text-right">고점수(≥70) 비율</th>
                  <th className="px-3 py-2 text-right">최초 발굴 기여</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {attributionRows.map((r) => {
                  const score = r.avg_final_score
                  const scoreColor =
                    score == null
                      ? 'text-gray-400'
                      : score >= 70
                        ? 'text-green-700 font-semibold'
                        : score >= 50
                          ? 'text-gray-800'
                          : 'text-orange-700'
                  const pctColor =
                    r.high_score_pct == null
                      ? 'text-gray-400'
                      : r.high_score_pct >= 30
                        ? 'text-green-700 font-semibold'
                        : r.high_score_pct >= 10
                          ? 'text-gray-800'
                          : 'text-orange-700'
                  return (
                    <tr key={r.source}>
                      <td className="px-3 py-1 font-mono">{r.source}</td>
                      <td className="px-3 py-1 text-right">{r.alias_count}</td>
                      <td className="px-3 py-1 text-right">{r.linked_product_count}</td>
                      <td className="px-3 py-1 text-right text-gray-500">
                        {r.scored_product_count}
                      </td>
                      <td className={`px-3 py-1 text-right ${scoreColor}`}>
                        {score == null ? '—' : score.toFixed(1)}
                      </td>
                      <td className={`px-3 py-1 text-right ${pctColor}`}>
                        {r.high_score_pct == null
                          ? '—'
                          : `${r.high_score_pct.toFixed(1)}% (${r.high_score_count})`}
                      </td>
                      <td className="px-3 py-1 text-right text-gray-700">
                        {r.first_discovery_count}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-2">
          * 최초 발굴 기여 = 해당 product 의 첫 alias 가 이 소스에서 들어온 건수.
          평균 final_score 는 product 별 최신 점수 기준.
        </p>
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">v4 cron 시간표 (UTC → KST):</strong> 18:00→03:00 google_suggest ·
        18:10→03:10 naver_news · 18:20→03:20 naver_blog · 18:30→03:30 clien_park · 18:40→03:40 quasarzone_sale ·
        18:50→03:50 kca_press · 19:00→04:00 gsc_daily · 19:10→04:10 naver_tvtime · 20:00→05:00 refresh_shipping_rates ·
        21:00→06:00 naver_search_trend · 21:10→06:10 naver_shopping_trend · 21:30→06:30 classify_trends_llm ·
        00:00→09:00 update_rates. Vercel Hobby 한도로 12개는 자동 발화 안 됨 — `node --env-file=.env.local scripts/run-crons.mjs` 로컬 우회.
      </section>
    </div>
  )
}
