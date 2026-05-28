import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type AnomalyFilter = 'all' | 'out_of_season' | 'in_season'
type SourceFilter = 'all' | 'naver_search_trend' | 'naver_shopping_insight' | 'naver_tvtime'

interface StlRow {
  keyword: string
  source: string
  period: number
  window_days: number
  observed: number | null
  trend: number | null
  seasonal: number | null
  residual: number | null
  trend_z: number | null
  seasonal_phase: number | null
  residual_z: number | null
  in_season: boolean | null
  anomaly_label: string | null
  n_samples: number
  computed_at: string
}

const SOURCE_LABELS: Record<string, string> = {
  naver_search_trend: '검색트렌드',
  naver_shopping_insight: '쇼핑인사이트',
  naver_tvtime: 'TV편성',
}

const ANOMALY_LABELS: Record<string, { label: string; color: string }> = {
  out_of_season_anomaly: { label: '🚨 시즌 외 이상상승', color: 'bg-red-50 text-red-700 border-red-200' },
  in_season_anomaly: { label: '📈 시즌 내 폭발', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  in_season_normal: { label: '시즌 통상', color: 'bg-gray-50 text-gray-500 border-gray-200' },
  out_of_season_normal: { label: '평이', color: 'bg-gray-50 text-gray-400 border-gray-200' },
}

async function fetchData(anomaly: AnomalyFilter, source: SourceFilter) {
  const sb = createAdminClient()

  // 가장 최근 computed_at 묶음만 — recent 24h
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()

  let q = sb
    .from('jimscanner_trends_stl' as never)
    .select(
      'keyword, source, period, window_days, observed, trend, seasonal, residual, trend_z, seasonal_phase, residual_z, in_season, anomaly_label, n_samples, computed_at',
    )
    .gte('computed_at', since)
    .order('residual_z', { ascending: false })
    .limit(500)

  if (source !== 'all') q = q.eq('source', source)
  if (anomaly === 'out_of_season') q = q.eq('anomaly_label', 'out_of_season_anomaly')
  else if (anomaly === 'in_season') q = q.eq('anomaly_label', 'in_season_anomaly')

  const { data } = (await q) as { data: StlRow[] | null }

  // (keyword, source) 별 가장 최근 row 만 유지
  const seen = new Set<string>()
  const latest: StlRow[] = []
  for (const r of ((data ?? []) as StlRow[])) {
    const k = `${r.keyword}::${r.source}`
    if (seen.has(k)) continue
    seen.add(k)
    latest.push(r)
  }

  // KPI
  const allRecent = (data ?? []) as StlRow[]
  const uniqKey = new Set(allRecent.map((r) => `${r.keyword}::${r.source}`))
  const kpis = {
    keywords: uniqKey.size,
    outOfSeason: allRecent.filter((r) => r.anomaly_label === 'out_of_season_anomaly').length,
    inSeason: allRecent.filter((r) => r.anomaly_label === 'in_season_anomaly').length,
    lastRun: allRecent[0]?.computed_at ?? null,
  }

  return { rows: latest, kpis }
}

function fmt(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function ggsanSearchHref(keyword: string): string {
  // ggsan 카탈로그 검색으로 보내 매칭 핀 만들기 (기존 페이지 search 파라미터 사용).
  return `/admin/trend-radar/ggsan?q=${encodeURIComponent(keyword)}`
}

export default async function DeseasonalizedPage({
  searchParams,
}: {
  searchParams: Promise<{ anomaly?: string; source?: string }>
}) {
  const sp = await searchParams
  const anomaly: AnomalyFilter =
    sp.anomaly === 'out_of_season' || sp.anomaly === 'in_season' ? sp.anomaly : 'all'
  const source: SourceFilter =
    sp.source === 'naver_search_trend' ||
    sp.source === 'naver_shopping_insight' ||
    sp.source === 'naver_tvtime'
      ? sp.source
      : 'all'

  const { rows, kpis } = await fetchData(anomaly, source)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">탈시즌 (Deseasonalized) 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            STL 분해 — trend·seasonal·residual 분리 후 '같은 달 평년 시즌 효과 대비 +Nσ' 키워드만.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="키워드 (24h 분해)" value={kpis.keywords} hint="최근 STL run" />
        <KpiCard
          label="🚨 시즌 외 이상상승"
          value={kpis.outOfSeason}
          hint="residual_z ≥ 2 · 시즌 효과 제거 후 상승"
        />
        <KpiCard
          label="📈 시즌 내 폭발"
          value={kpis.inSeason}
          hint="시즌인데도 평년 시즌 효과 초과"
        />
        <KpiCard
          label="마지막 run"
          value={0}
          hint={kpis.lastRun ? kpis.lastRun.slice(5, 16) : '아직 없음'}
          asString
        />
      </section>

      {/* 필터 */}
      <nav className="flex flex-wrap gap-2 border-b border-gray-200 pb-3">
        <FilterPill href={hrefFor({ anomaly: 'all', source })} active={anomaly === 'all'}>
          전체
        </FilterPill>
        <FilterPill href={hrefFor({ anomaly: 'out_of_season', source })} active={anomaly === 'out_of_season'}>
          🚨 시즌 외만
        </FilterPill>
        <FilterPill href={hrefFor({ anomaly: 'in_season', source })} active={anomaly === 'in_season'}>
          📈 시즌 내 폭발만
        </FilterPill>
        <span className="text-gray-300 px-2">·</span>
        <FilterPill href={hrefFor({ anomaly, source: 'all' })} active={source === 'all'}>
          모든 소스
        </FilterPill>
        <FilterPill href={hrefFor({ anomaly, source: 'naver_search_trend' })} active={source === 'naver_search_trend'}>
          검색트렌드
        </FilterPill>
        <FilterPill href={hrefFor({ anomaly, source: 'naver_shopping_insight' })} active={source === 'naver_shopping_insight'}>
          쇼핑인사이트
        </FilterPill>
        <FilterPill href={hrefFor({ anomaly, source: 'naver_tvtime' })} active={source === 'naver_tvtime'}>
          TV편성
        </FilterPill>
      </nav>

      <section className="rounded border border-dashed border-amber-200 bg-amber-50/40 p-4 text-xs text-gray-600">
        <strong className="text-gray-800">읽는 법:</strong>{' '}
        STL 은 시계열을 <code className="px-1 bg-white rounded">observed = trend + seasonal + residual</code> 로 쪼갠다.
        시즌 효과(여름가전·환절기 등)는 매년 반복돼 score 가속도/burst 보드에서 가짜 신호로 잡히지만,
        <strong> residual_z ≥ 2 </strong>는 시즌 효과를 빼고도 평년 분산 대비 비정상적으로 큰 상승이다.
        '시즌 외 이상상승' 라벨이 위탁 진입 타이밍의 진짜 신호.
      </section>

      {/* 보드 */}
      <section>
        {rows.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-3">키워드</div>
              <div className="col-span-1 text-right">resid_z</div>
              <div className="col-span-1 text-right">trend_z</div>
              <div className="col-span-1 text-right">seasonal</div>
              <div className="col-span-1 text-right">obs</div>
              <div className="col-span-2">라벨</div>
              <div className="col-span-1 text-right">샘플</div>
              <div className="col-span-1 text-right">매칭</div>
            </div>
            {rows.map((r, i) => {
              const al = r.anomaly_label ?? 'out_of_season_normal'
              const info = ANOMALY_LABELS[al] ?? ANOMALY_LABELS.out_of_season_normal
              return (
                <div
                  key={`${r.keyword}::${r.source}`}
                  className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 items-center hover:bg-gray-50 transition-colors text-sm"
                >
                  <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                  <div className="col-span-3">
                    <div className="font-medium truncate">{r.keyword}</div>
                    <div className="text-xs text-gray-500">
                      {SOURCE_LABELS[r.source] ?? r.source} · {r.window_days}d/{r.period}d
                    </div>
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold">
                    {fmt(r.residual_z, 2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {fmt(r.trend_z, 2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {fmt(r.seasonal, 1)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {fmt(r.observed, 1)}
                  </div>
                  <div className="col-span-2">
                    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${info.color}`}>
                      {info.label}
                    </span>
                  </div>
                  <div className="col-span-1 text-right text-xs text-gray-500">{r.n_samples}</div>
                  <div className="col-span-1 text-right">
                    <Link
                      href={ggsanSearchHref(r.keyword)}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      ggsan →
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">스케줄:</strong>{' '}
        nightly · <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/stl-decompose.mjs</code>
        {' '}— 90일 윈도우 / 7일 주기 기본. 옵션:
        <code className="ml-1 px-1 bg-gray-100 rounded">--window=180 --period=7 --source=naver_search_trend</code>.
      </section>
    </div>
  )
}

function hrefFor({ anomaly, source }: { anomaly: AnomalyFilter; source: SourceFilter }) {
  const qs = new URLSearchParams()
  if (anomaly !== 'all') qs.set('anomaly', anomaly)
  if (source !== 'all') qs.set('source', source)
  const q = qs.toString()
  return '/admin/trend-radar/deseasonalized' + (q ? `?${q}` : '')
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 text-xs rounded-full border transition-colors ${
        active
          ? 'border-black bg-black text-white'
          : 'border-gray-200 text-gray-600 hover:border-gray-400'
      }`}
    >
      {children}
    </Link>
  )
}

function KpiCard({
  label,
  value,
  hint,
  asString,
}: {
  label: string
  value: number
  hint: string | number
  asString?: boolean
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">
        {asString ? (typeof hint === 'string' ? hint : String(hint)) : value.toLocaleString()}
      </div>
      {!asString && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 STL 결과가 없습니다</p>
      <p className="text-sm mt-2">
        nightly STL cron 을 한 번 돌리세요:
        <br />
        <code className="px-1 bg-gray-100 rounded mt-2 inline-block">
          node --env-file=.env.local scripts/stl-decompose.mjs
        </code>
      </p>
      <p className="text-xs mt-4 text-gray-400">
        최소 21일치 일별 관측이 있는 키워드만 분해됨. 새로 들어온 시드는 누적될 때까지 대기.
      </p>
    </div>
  )
}
