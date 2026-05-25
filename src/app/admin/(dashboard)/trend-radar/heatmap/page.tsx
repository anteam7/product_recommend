import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const SOURCES = ['all', 'naver_tvtime', 'naver_search_trend', 'naver_shopping_insight'] as const
type SourceFilter = (typeof SOURCES)[number]

const SOURCE_LABEL: Record<SourceFilter, string> = {
  all: '전체 소스',
  naver_tvtime: 'TV 편성표',
  naver_search_trend: '검색 트렌드',
  naver_shopping_insight: '쇼핑 인사이트',
}

const DOW_LABEL = ['일', '월', '화', '수', '목', '금', '토']

interface HourlyRow {
  keyword: string
  source: string
  category_top: string | null
  hour: number
  dow: number
  cnt: number
  sum_volume: number
}

async function fetchHourly(source: SourceFilter) {
  const sb = createAdminClient() as any
  let q = sb
    .from('jimscanner_trends_hourly')
    .select('keyword, source, category_top, hour, dow, cnt, sum_volume')
    .limit(20000)
  if (source !== 'all') q = q.eq('source', source)
  const { data, error } = await q
  if (error) return { rows: [] as HourlyRow[], error: error.message }
  return { rows: (data ?? []) as HourlyRow[], error: null }
}

interface PinnedKw {
  keyword: string
  category: string | null
  category_top: string | null
}

async function fetchPinned() {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category, category_top')
    .eq('pinned', true)
    .limit(200)
  // dedupe by keyword
  const seen = new Set<string>()
  const out: PinnedKw[] = []
  for (const r of (data ?? []) as PinnedKw[]) {
    if (seen.has(r.keyword)) continue
    seen.add(r.keyword)
    out.push(r)
  }
  return out
}

function buildGrid(rows: HourlyRow[]) {
  // 7 dow × 24 hour grid
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
  let total = 0
  for (const r of rows) {
    if (r.dow < 0 || r.dow > 6 || r.hour < 0 || r.hour > 23) continue
    grid[r.dow][r.hour] += r.cnt
    total += r.cnt
  }
  return { grid, total }
}

interface PeakStat {
  keyword: string
  peakHour: number
  peakDow: number
  peakCnt: number
  total: number
  top3Concentration: number
  pattern: 'burst' | 'routine' | 'other'
}

function classifyPattern(top3: number, total: number): PeakStat['pattern'] {
  if (total < 3) return 'other'
  if (top3 >= 60) return 'burst'
  if (top3 <= 30) return 'routine'
  return 'other'
}

function aggregatePerKeyword(rows: HourlyRow[]): PeakStat[] {
  const map = new Map<string, HourlyRow[]>()
  for (const r of rows) {
    const arr = map.get(r.keyword) ?? []
    arr.push(r)
    map.set(r.keyword, arr)
  }
  const out: PeakStat[] = []
  for (const [keyword, list] of map) {
    let total = 0
    list.forEach((r) => (total += r.cnt))
    if (total === 0) continue
    const sorted = [...list].sort((a, b) => b.cnt - a.cnt)
    const top = sorted[0]
    const top3Sum = sorted.slice(0, 3).reduce((s, r) => s + r.cnt, 0)
    const top3Concentration = total > 0 ? (top3Sum / total) * 100 : 0
    out.push({
      keyword,
      peakHour: top.hour,
      peakDow: top.dow,
      peakCnt: top.cnt,
      total,
      top3Concentration: Math.round(top3Concentration * 10) / 10,
      pattern: classifyPattern(top3Concentration, total),
    })
  }
  return out.sort((a, b) => b.total - a.total)
}

function fmtSlot(dow: number, hour: number) {
  return `${DOW_LABEL[dow] ?? '?'} ${String(hour).padStart(2, '0')}시`
}

function cellColor(value: number, max: number): string {
  if (value === 0) return 'bg-gray-50'
  const ratio = max > 0 ? value / max : 0
  if (ratio < 0.1) return 'bg-amber-100'
  if (ratio < 0.25) return 'bg-amber-200'
  if (ratio < 0.5) return 'bg-amber-300'
  if (ratio < 0.75) return 'bg-amber-400'
  return 'bg-amber-500'
}

export default async function HeatmapPage({
  searchParams,
}: {
  searchParams: Promise<{ src?: string; kw?: string }>
}) {
  const sp = await searchParams
  const source = (SOURCES.includes(sp.src as SourceFilter) ? sp.src : 'all') as SourceFilter
  const focusKw = sp.kw?.trim() || null

  const [{ rows, error }, pinned] = await Promise.all([fetchHourly(source), fetchPinned()])

  const filteredRows = focusKw ? rows.filter((r) => r.keyword === focusKw) : rows
  const { grid, total } = buildGrid(filteredRows)
  const maxCell = Math.max(0, ...grid.flat())

  const perKw = aggregatePerKeyword(rows)
  const burstCount = perKw.filter((p) => p.pattern === 'burst').length
  const routineCount = perKw.filter((p) => p.pattern === 'routine').length

  // peak hour 분포 (히트맵 전역)
  const hourTotals = Array.from({ length: 24 }, (_, h) =>
    grid.reduce((s, row) => s + row[h], 0),
  )
  const peakHourGlobal = hourTotals.indexOf(Math.max(...hourTotals))
  const dowTotals = Array.from({ length: 7 }, (_, d) =>
    grid[d].reduce((s, v) => s + v, 0),
  )
  const peakDowGlobal = dowTotals.indexOf(Math.max(...dowTotals))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">168시간 수요 히트맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            시 × 요일 데이파트 — 검색광고 CPC 헤드룸 30~50% ↓ 핵심 lever.
            burst (1~2시간 폭증) vs routine (균등) 자동 분류.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>jimscanner_trends_hourly</strong> materialized view 가 아직 없습니다.
          <code className="ml-2 px-1 bg-white rounded text-xs">supabase/trends_v5_hourly_heatmap.sql</code>
          을 적용하고{' '}
          <code className="ml-1 px-1 bg-white rounded text-xs">refresh-trends-hourly</code>
          cron 을 1회 실행하세요. ({error})
        </div>
      )}

      {/* 소스 필터 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {SOURCES.map((s) => {
          const active = s === source && !focusKw
          const href =
            s === 'all'
              ? '/admin/trend-radar/heatmap'
              : `/admin/trend-radar/heatmap?src=${encodeURIComponent(s)}`
          return (
            <Link
              key={s}
              href={href}
              className={`px-3 py-2 text-sm border-b-2 ${
                active
                  ? 'border-amber-500 font-semibold text-black'
                  : 'border-transparent text-gray-500 hover:text-black'
              }`}
            >
              {SOURCE_LABEL[s]}
            </Link>
          )
        })}
      </nav>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="총 시그널" value={total.toLocaleString()} hint={focusKw ? `kw=${focusKw}` : '60일 누적'} />
        <Kpi label="unique kw" value={perKw.length.toLocaleString()} hint="히트맵 대상" />
        <Kpi
          label="burst 형"
          value={burstCount.toLocaleString()}
          hint="top3 ≥ 60% 집중"
        />
        <Kpi
          label="routine 형"
          value={routineCount.toLocaleString()}
          hint="top3 ≤ 30% 균등"
        />
        <Kpi
          label="peak slot"
          value={total > 0 ? fmtSlot(peakDowGlobal, peakHourGlobal) : '—'}
          hint="전역 hot cell"
        />
      </section>

      {/* 7 × 24 히트맵 그리드 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          7 × 24 히트맵{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">
            {focusKw ? `· kw=${focusKw}` : `· source=${SOURCE_LABEL[source]}`}
          </span>
          {focusKw && (
            <Link
              href={`/admin/trend-radar/heatmap?src=${source}`}
              className="ml-2 text-xs text-amber-700 hover:underline"
            >
              ← 전체 보기
            </Link>
          )}
        </h2>
        <div className="rounded border border-gray-200 p-4 overflow-x-auto">
          {total === 0 ? (
            <div className="text-sm text-gray-500 text-center py-8">
              데이터 없음. MV refresh 이후 다시 확인하세요.
            </div>
          ) : (
            <div className="inline-block">
              <div className="grid" style={{ gridTemplateColumns: '32px repeat(24, 28px)' }}>
                <div />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="text-[10px] text-gray-400 text-center">
                    {h}
                  </div>
                ))}
                {grid.map((row, d) => (
                  <>
                    <div key={`l-${d}`} className="text-xs text-gray-500 pr-2 flex items-center">
                      {DOW_LABEL[d]}
                    </div>
                    {row.map((v, h) => (
                      <div
                        key={`c-${d}-${h}`}
                        className={`h-7 ${cellColor(v, maxCell)} border border-white`}
                        title={`${fmtSlot(d, h)} · ${v}`}
                      >
                        {v > 0 && maxCell > 0 && v / maxCell > 0.5 ? (
                          <div className="text-[9px] text-white text-center leading-7 font-mono">
                            {v}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </>
                ))}
              </div>
              <div className="text-[11px] text-gray-500 mt-3">
                row=요일 (일~토) · col=hour 0~23 (KST) · 색농도 ∝ cnt / max({maxCell})
              </div>
            </div>
          )}
        </div>
      </section>

      {/* burst 핀 후보 — top3 집중도 높은 키워드 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          🔥 burst 핀 후보{' '}
          <span className="text-xs font-normal text-gray-500">
            (top3 시간대에 ≥ 60% 집중 — 그 시간대에만 입찰 강화하면 ROI ↑)
          </span>
        </h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 bg-gray-50">
            <div className="col-span-1">#</div>
            <div className="col-span-5">키워드</div>
            <div className="col-span-2 text-right">peak slot</div>
            <div className="col-span-1 text-right">peak cnt</div>
            <div className="col-span-1 text-right">total</div>
            <div className="col-span-1 text-right">top3 %</div>
            <div className="col-span-1 text-right">패턴</div>
          </div>
          {perKw.filter((p) => p.pattern !== 'other').slice(0, 50).map((p, i) => (
            <Link
              key={p.keyword}
              href={`/admin/trend-radar/heatmap?src=${source}&kw=${encodeURIComponent(p.keyword)}`}
              className="grid grid-cols-12 px-3 py-2 text-sm hover:bg-amber-50"
            >
              <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
              <div className="col-span-5 truncate">{p.keyword}</div>
              <div className="col-span-2 text-right text-xs text-gray-600">
                {fmtSlot(p.peakDow, p.peakHour)}
              </div>
              <div className="col-span-1 text-right font-mono">{p.peakCnt}</div>
              <div className="col-span-1 text-right font-mono">{p.total}</div>
              <div className="col-span-1 text-right font-mono">{p.top3Concentration}%</div>
              <div className="col-span-1 text-right text-xs">
                {p.pattern === 'burst' ? (
                  <span className="px-2 py-0.5 rounded bg-red-100 text-red-700">burst</span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">routine</span>
                )}
              </div>
            </Link>
          ))}
          {perKw.filter((p) => p.pattern !== 'other').length === 0 && (
            <div className="px-3 py-6 text-sm text-gray-500 text-center">
              아직 패턴 분류 가능한 키워드가 없습니다 (MV 누적 부족).
            </div>
          )}
        </div>
      </section>

      {/* 핀된 키워드 별 mini heatmap drill */}
      {pinned.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            📌 핀 후보 ({pinned.length}) — 클릭하면 키워드별 히트맵
          </h2>
          <div className="flex flex-wrap gap-2">
            {pinned.slice(0, 60).map((p) => (
              <Link
                key={p.keyword}
                href={`/admin/trend-radar/heatmap?src=${source}&kw=${encodeURIComponent(p.keyword)}`}
                className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-amber-50"
              >
                {p.keyword}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4">
        시간축은 KST. TV 편성표 소스는 슬롯의 실제 방송 시각(HH:MM) 을 hour 로 사용 ·
        그 외 소스는 collected_at 의 KST 시각. dow 는 collected_at 의 KST 요일.
        MV refresh 는 매일 KST 05:30 (
        <code className="bg-gray-100 px-1 rounded">/api/cron/refresh-trends-hourly</code>) 시점에 갱신.
      </section>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold mt-1">{value}</div>
      <div className="text-[11px] text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
