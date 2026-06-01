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

// jimscanner_trends_source_health VIEW (supabase/trends_source_health.sql)
// generated types 에 없으므로 `as any` 로 조회한다.
interface HealthRow {
  source: string
  runs_30d: number
  median_inserted: number | null
  mad_inserted: number | null
  median_fetched: number | null
  median_interval_min: number | null
  last_started_at: string | null
  last_status: string | null
  last_inserted: number | null
  last_fetched: number | null
  last_duration_ms: number | null
  last_error: string | null
  today_runs: number
  today_inserted: number
  today_fetched: number
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

// source 별 다운스트림 영향도 — 이 수집원이 굶으면 무엇이 굶는가
const DOWNSTREAM: Record<string, string> = {
  naver_search_trend: '검색 트렌드 스코어(핵심)',
  naver_shopping_insight: '쇼핑 카테고리 수요',
  naver_tvtime: 'TV·홈쇼핑 발굴',
  classify_trends_llm: '전체 분류 깔때기',
  google_suggest: '연관검색 수요',
  naver_news: '뉴스 시그널',
  naver_blog: '블로그 수요',
  clien_park: '커뮤니티 시그널',
  quasarzone_sale: '핫딜 시그널',
  kca_press: '리콜·안전 시그널',
}

type Grade = 'normal' | 'low' | 'silent' | 'delayed' | 'unknown'

const GRADE_META: Record<Grade, { label: string; badge: string; flag: string; flagColor: string }> = {
  normal: { label: '정상', badge: 'bg-green-100 text-green-700', flag: '✓', flagColor: 'text-green-600' },
  low: { label: '저조', badge: 'bg-yellow-100 text-yellow-700', flag: '◐', flagColor: 'text-yellow-600' },
  silent: { label: '무음고장', badge: 'bg-red-100 text-red-700', flag: '✗', flagColor: 'text-red-600' },
  delayed: { label: '지연', badge: 'bg-orange-100 text-orange-700', flag: '⏱', flagColor: 'text-orange-600' },
  unknown: { label: '데이터없음', badge: 'bg-gray-100 text-gray-500', flag: '○', flagColor: 'text-gray-300' },
}

async function fetchData() {
  const sb = createAdminClient()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [runs, raw24, raw7, health] = await Promise.all([
    sb
      .from('jimscanner_trends_runs')
      .select('source, status, fetched_count, inserted_count, duration_ms, error_message, started_at, triggered_by')
      .order('started_at', { ascending: false })
      .limit(400),
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
    // View — generated types 에 없으므로 캐스팅
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sb as any).from('jimscanner_trends_source_health').select('*'),
  ])

  // source 별 health 밴드
  const healthBySource = new Map<string, HealthRow>()
  for (const h of ((health?.data ?? []) as HealthRow[])) {
    healthBySource.set(h.source, h)
  }

  // source × 최근 7일 일별 inserted 합 (스파크라인용)
  const allRuns = (runs.data ?? []) as RunRow[]
  const sparkBySource = new Map<string, number[]>()
  const dayKey = (iso: string) => iso.slice(0, 10)
  const today = new Date()
  const dayKeys: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
    dayKeys.push(d.toISOString().slice(0, 10))
  }
  const dayIndex = new Map(dayKeys.map((k, i) => [k, i]))
  for (const r of allRuns) {
    const idx = dayIndex.get(dayKey(r.started_at))
    if (idx == null) continue
    if (!sparkBySource.has(r.source)) sparkBySource.set(r.source, new Array(7).fill(0))
    sparkBySource.get(r.source)![idx] += r.inserted_count
  }

  // source 별 가장 최근 run (fallback)
  const latestBySource = new Map<string, RunRow>()
  for (const r of allRuns) {
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

  return {
    latestBySource,
    healthBySource,
    sparkBySource,
    marketAgg,
    recentRuns: allRuns.slice(0, 50),
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

// 정상 수확량 밴드(중앙값 ± MAD) 기준으로 등급 분류
function classify(h: HealthRow | undefined): { grade: Grade; reason: string } {
  if (!h || !h.runs_30d || !h.last_started_at) return { grade: 'unknown', reason: '베이스라인 부족' }

  const fetched = h.last_fetched ?? 0
  const inserted = h.last_inserted ?? 0
  const age = ageMinutes(h.last_started_at)

  // ① 무음 고장: 가져오긴 했는데(fetched>0) 한 건도 안 들어감(inserted=0)
  //    → dedup 충돌이 아니라 셀렉터/파서 깨짐 신호
  if (fetched > 0 && inserted === 0) {
    return { grade: 'silent', reason: `fetched ${fetched} → inserted 0 (파서 침묵)` }
  }

  // ② 지연: 정상 실행 간격의 2.5배를 넘김
  if (h.median_interval_min && h.median_interval_min > 0 && age > h.median_interval_min * 2.5) {
    return { grade: 'delayed', reason: `${formatAge(age)} (정상 간격 ${Math.round(h.median_interval_min)}m)` }
  }

  // ③ 저조: 오늘 수확이 정상 밴드(중앙값 - 2·MAD) 아래
  const median = h.median_inserted ?? 0
  const mad = Math.max(h.mad_inserted ?? 0, 1)
  const lowerBand = median - 2 * mad
  if (median > 0 && h.today_inserted < lowerBand) {
    return { grade: 'low', reason: `오늘 ${h.today_inserted} < 밴드하한 ${Math.round(lowerBand)} (중앙 ${Math.round(median)})` }
  }

  return { grade: 'normal', reason: `오늘 ${h.today_inserted} (중앙 ${Math.round(median)}±${Math.round(mad)})` }
}

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data)
  return (
    <div className="flex items-end gap-px h-6" title={data.join(' · ')}>
      {data.map((v, i) => {
        const h = Math.max(1, Math.round((v / max) * 22))
        const empty = v === 0
        return (
          <div
            key={i}
            className={`w-1.5 rounded-sm ${empty ? 'bg-gray-200' : 'bg-sky-400'}`}
            style={{ height: `${h}px` }}
          />
        )
      })}
    </div>
  )
}

export default async function SourcesPage() {
  const { healthBySource, sparkBySource, marketAgg, recentRuns } = await fetchData()

  // 이상 배지 요약
  const allTrendsSources = TRENDS_RUNS_GROUPS.flatMap((g) => g.sources)
  const anomalies = allTrendsSources
    .map((src) => ({ src, ...classify(healthBySource.get(src)) }))
    .filter((a) => a.grade === 'silent' || a.grade === 'low' || a.grade === 'delayed')

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">소스 헬스 · 수율 이상탐지</h1>
          <p className="text-sm text-gray-500 mt-1">
            정상 수확량 밴드(최근 30일 중앙값±MAD) 학습 → 오늘 수확을 정상/저조/무음고장/지연으로 분류
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 이상 요약 배너 */}
      {anomalies.length > 0 ? (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm">
          <strong className="text-red-700">⚠ {anomalies.length}개 수집원 이상</strong>
          <ul className="mt-1 space-y-0.5 text-red-800">
            {anomalies.map((a) => (
              <li key={a.src}>
                <span className="font-mono">{a.src}</span> — {GRADE_META[a.grade].label}: {a.reason}
                {DOWNSTREAM[a.src] ? <span className="text-red-500"> → {DOWNSTREAM[a.src]} 영향</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          ✓ 모든 trends_runs 수집원이 정상 밴드 안에 있습니다.
        </div>
      )}

      {/* trends_runs 기반 collector 그룹 — 수율 밴드 + 스파크라인 */}
      {TRENDS_RUNS_GROUPS.map((group) => (
        <section key={group.label}>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{group.label}</h2>
          <div className="rounded border border-gray-200 divide-y divide-gray-200">
            <div className="grid grid-cols-12 px-3 py-1.5 text-[11px] font-medium text-gray-400 bg-gray-50">
              <div className="col-span-2">등급</div>
              <div className="col-span-3">source</div>
              <div className="col-span-2 text-center">최근 7일 수확</div>
              <div className="col-span-3">판정 근거</div>
              <div className="col-span-2 text-right">다운스트림</div>
            </div>
            {group.sources.map((src) => {
              const h = healthBySource.get(src)
              const { grade, reason } = classify(h)
              const meta = GRADE_META[grade]
              const spark = sparkBySource.get(src) ?? new Array(7).fill(0)
              return (
                <div key={src} className="grid grid-cols-12 px-3 py-2 items-center text-sm">
                  <div className="col-span-2 flex items-center gap-1.5">
                    <span className={`text-lg ${meta.flagColor}`}>{meta.flag}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${meta.badge}`}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="col-span-3 font-mono text-xs">
                    {src}
                    {h?.last_started_at ? (
                      <span className="block text-[10px] text-gray-400">
                        {formatAge(ageMinutes(h.last_started_at))} · {h.last_fetched ?? 0}→{h.last_inserted ?? 0}
                      </span>
                    ) : null}
                  </div>
                  <div className="col-span-2 flex justify-center">
                    <Sparkline data={spark} />
                  </div>
                  <div
                    className={`col-span-3 text-xs ${
                      grade === 'silent' ? 'text-red-600' : grade === 'normal' ? 'text-gray-500' : 'text-gray-700'
                    }`}
                  >
                    {reason}
                  </div>
                  <div className="col-span-2 text-right text-[11px] text-gray-500">
                    {DOWNSTREAM[src] ?? '—'}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {/* market_raw 기반 수요 시그널 수집기 — 7일 평균 대비 고갈 탐지 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          수요 시그널 (market_raw 직접 적재)
        </h2>
        <p className="text-xs text-gray-500 mb-2">
          trends_runs 로깅이 없어 market_raw 카운트로 헬스 확인. 24h 적재량이 7일 일평균의 40% 미만이면 고갈 의심.
        </p>
        <div className="rounded border border-gray-200 divide-y divide-gray-200">
          {MARKET_RAW_SOURCES.map((src) => {
            const agg = marketAgg.get(src)!
            const age = agg.last_at ? ageMinutes(agg.last_at) : null
            const expectedDaily = agg.rows_7d / 7
            let grade: Grade = 'normal'
            let reason = `24h ${agg.rows_24h} (일평균 ${expectedDaily.toFixed(1)})`
            if (!agg.last_at) {
              grade = 'unknown'
              reason = '데이터 없음'
            } else if (agg.rows_7d > 0 && agg.rows_24h === 0) {
              grade = 'silent'
              reason = `24h 0건 (7일엔 ${agg.rows_7d}건) — 고갈`
            } else if (expectedDaily > 0 && agg.rows_24h < expectedDaily * 0.4) {
              grade = 'low'
              reason = `24h ${agg.rows_24h} < 일평균 ${expectedDaily.toFixed(1)}의 40%`
            } else if (age != null && age >= 48 * 60) {
              grade = 'delayed'
              reason = `최근 적재 ${formatAge(age)}`
            }
            const meta = GRADE_META[grade]
            return (
              <div key={src} className="grid grid-cols-12 px-3 py-2 items-center text-sm">
                <div className="col-span-2 flex items-center gap-1.5">
                  <span className={`text-lg ${meta.flagColor}`}>{meta.flag}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${meta.badge}`}>
                    {meta.label}
                  </span>
                </div>
                <div className="col-span-3 font-mono text-xs">
                  {src}
                  <span className="block text-[10px] text-gray-400">
                    {age != null ? formatAge(age) : '—'} · 7d {agg.rows_7d}
                  </span>
                </div>
                <div className="col-span-2 text-center text-gray-600">24h: {agg.rows_24h}</div>
                <div
                  className={`col-span-3 text-xs ${
                    grade === 'silent' ? 'text-red-600' : grade === 'normal' ? 'text-gray-500' : 'text-gray-700'
                  }`}
                >
                  {reason}
                </div>
                <div className="col-span-2 text-right text-[11px] text-gray-500">
                  {DOWNSTREAM[src] ?? '—'}
                </div>
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
              {recentRuns.map((r, i) => {
                // 무음 고장 패턴 행 강조: status=ok 인데 fetched>0·inserted=0
                const silent = r.status === 'ok' && r.fetched_count > 0 && r.inserted_count === 0
                return (
                  <tr key={i} className={silent ? 'bg-red-50' : ''}>
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
                      {silent ? <span className="ml-1 text-red-600">⚠무음</span> : null}
                    </td>
                    <td className="px-3 py-1 text-right">{r.fetched_count}</td>
                    <td className="px-3 py-1 text-right">{r.inserted_count}</td>
                    <td className="px-3 py-1 text-right text-gray-500">{r.duration_ms}ms</td>
                    <td className="px-3 py-1 text-gray-500">{r.triggered_by ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">등급 정의:</strong>{' '}
        <span className="text-red-600">무음고장</span> = fetched&gt;0·inserted=0 (셀렉터/파서 깨짐) ·{' '}
        <span className="text-yellow-600">저조</span> = 오늘 수확 &lt; 중앙값−2·MAD ·{' '}
        <span className="text-orange-600">지연</span> = 정상 실행간격의 2.5배 초과 ·{' '}
        <span className="text-green-600">정상</span> = 밴드 내. 베이스라인 VIEW:{' '}
        <code>jimscanner_trends_source_health</code> (supabase/trends_source_health.sql).
      </section>
    </div>
  )
}
