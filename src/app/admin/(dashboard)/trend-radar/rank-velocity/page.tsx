import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RankBumpChart, { type BumpSeries } from './RankBumpChart'

export const dynamic = 'force-dynamic'

// 랭킹형 소스 라벨 (rank 스냅샷이 쌓이는 소스만 의미 있음)
const SOURCE_LABEL: Record<string, string> = {
  musinsa_best: '무신사 베스트',
  naver_shopping_hot: '네이버쇼핑 HOT',
  naver_shopping_insight: '네이버쇼핑 인사이트',
  ppomppu_main: '뽐뿌 메인',
  natepan_ranking: '네이트판 랭킹',
  dcinside_realtime: 'DC 실시간',
  zum_realtime: '줌 실시간',
  naver_tvtime: 'TV편성(naver)',
}
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s

interface VelocityRow {
  keyword: string
  source: string
  days_present: number
  first_day: string
  last_day: string
  first_rank: number
  current_rank: number
  peak_rank: number
  jump: number
  slope_per_day: number
  velocity: number
  is_new_entry: boolean
}

interface RawRankRow {
  keyword: string
  source: string
  rank: number
  collected_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 1) 순위 속도 뷰 — 마이그레이션 후 상태 가정 (타입 미정 → as any)
  const { data: vData } = await (sb as any)
    .from('jimscanner_trends_rank_velocity')
    .select('*')
    .gte('days_present', 2) // 최소 2일 이상 관측돼야 기울기 의미 있음
    .order('velocity', { ascending: false })
    .limit(500)

  const rows = ((vData ?? []) as VelocityRow[]).filter(
    (r) => r.first_rank != null && r.current_rank != null,
  )

  // 급상승 = 진입 후 순위가 실제로 오른 것 (jump>0) 중 velocity 순
  const risers = rows
    .filter((r) => r.jump > 0)
    .sort((a, b) => b.velocity - a.velocity || b.jump - a.jump)

  // 신규 진입 급등 vs 상위 정체 분리
  const newSurge = risers.filter((r) => r.is_new_entry).slice(0, 20)
  const stagnantTop = rows
    .filter((r) => !r.is_new_entry && r.current_rank <= 10 && Math.abs(r.slope_per_day) < 0.5)
    .sort((a, b) => a.current_rank - b.current_rank)
    .slice(0, 20)

  // 소스별 급상승 랭킹 (상위만)
  const bySource = new Map<string, VelocityRow[]>()
  for (const r of risers) {
    const arr = bySource.get(r.source) ?? []
    if (arr.length < 8) arr.push(r)
    bySource.set(r.source, arr)
  }

  // 2) 범프차트용 일자 순위 시계열 — 상위 급상승 키워드 raw 조회
  const topForChart = risers.slice(0, 10)
  let bump: BumpSeries[] = []
  let chartDays: string[] = []
  if (topForChart.length > 0) {
    const since = new Date(Date.now() - 21 * 86400_000).toISOString()
    const keys = [...new Set(topForChart.map((r) => r.keyword))]
    const { data: raw } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, source, rank, collected_at')
      .in('keyword', keys)
      .not('rank', 'is', null)
      .gte('collected_at', since)
      .limit(5000)

    // (keyword|source, day) → 베스트 순위
    const daySet = new Set<string>()
    const seriesMap = new Map<string, Map<string, number>>()
    for (const rr of (raw ?? []) as RawRankRow[]) {
      const day = rr.collected_at.slice(0, 10)
      daySet.add(day)
      const key = `${rr.keyword}__${rr.source}`
      let m = seriesMap.get(key)
      if (!m) { m = new Map(); seriesMap.set(key, m) }
      const prev = m.get(day)
      if (prev == null || rr.rank < prev) m.set(day, rr.rank)
    }
    chartDays = [...daySet].sort()

    bump = topForChart
      .map((r) => {
        const m = seriesMap.get(`${r.keyword}__${r.source}`)
        if (!m) return null
        return {
          keyword: r.keyword,
          source: r.source,
          points: chartDays.map((d) => ({ day: d, rank: m.get(d) ?? null })),
        } as BumpSeries
      })
      .filter((x): x is BumpSeries => x !== null)
  }

  return { risers, newSurge, stagnantTop, bySource, bump, chartDays, total: rows.length }
}

export default async function RankVelocityPage() {
  const { risers, newSurge, stagnantTop, bySource, bump, chartDays, total } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">순위 상승 속도 (Rank Velocity)</h1>
          <p className="text-sm text-gray-500 mt-1">
            랭킹형 소스의 일자별 순위 스냅샷으로 &lsquo;위치 가속&rsquo;을 추적 ·
            절대 점수가 평평해도 rank 40→5 가속은 브레이크아웃 선행신호
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {total === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 순위 시계열이 없습니다</p>
          <p className="text-sm mt-2">
            rank 컬럼이 적재되는 랭킹형 소스가 최소 2일 누적돼야 기울기를 계산합니다.
            <br />
            (musinsa_best / naver_shopping_hot / ppomppu_main / natepan_ranking 등)
          </p>
        </div>
      ) : (
        <>
          {/* 범프차트 */}
          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">
              범프차트 — 상위 급상승 키워드의 순위 흐름
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              위로 갈수록 1위 · 선이 가파르게 위로 꺾이면 빠르게 상승 중 (최근 21일)
            </p>
            {bump.length === 0 ? (
              <div className="text-sm text-gray-400 py-6 text-center">차트용 시계열 부족</div>
            ) : (
              <RankBumpChart series={bump} days={chartDays} />
            )}
          </section>

          {/* 신규 진입 급등 vs 상위 정체 */}
          <section className="grid gap-4 md:grid-cols-2">
            <TagBoard
              title="🚀 신규 진입 급등"
              hint="최근 7일 내 첫 등장 + 빠른 상승"
              rows={newSurge}
              accent="text-emerald-700"
              emptyText="아직 신규 진입 급등 없음"
            />
            <TagBoard
              title="🏔️ 상위 정체"
              hint="Top10 고정 · 기울기 평탄 (이미 자리 잡음)"
              rows={stagnantTop}
              accent="text-gray-700"
              emptyText="아직 상위 정체 키워드 없음"
            />
          </section>

          {/* 소스별 급상승 랭킹 */}
          <section className="space-y-4">
            <h2 className="text-sm font-semibold text-gray-700">소스별 급상승 Top</h2>
            {[...bySource.entries()].map(([source, list]) => (
              <div key={source} className="rounded border border-gray-200 p-4">
                <div className="text-sm font-semibold mb-2">{sourceLabel(source)}</div>
                <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
                  <div className="col-span-6">키워드</div>
                  <div className="col-span-2 text-right">진입→현재</div>
                  <div className="col-span-1 text-right">점프</div>
                  <div className="col-span-2 text-right">속도/일</div>
                  <div className="col-span-1 text-right">관측</div>
                </div>
                {list.map((r) => (
                  <div key={r.keyword + r.source} className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-gray-50">
                    <div className="col-span-6 truncate flex items-center gap-1">
                      {r.is_new_entry && <span className="text-[10px] px-1 rounded bg-emerald-100 text-emerald-700">NEW</span>}
                      {r.keyword}
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-600">
                      {r.first_rank}→{r.current_rank}
                    </div>
                    <div className="col-span-1 text-right font-mono font-bold text-emerald-600">▲{r.jump}</div>
                    <div className="col-span-2 text-right font-mono text-gray-600">{r.velocity}</div>
                    <div className="col-span-1 text-right text-xs text-gray-400">{r.days_present}d</div>
                  </div>
                ))}
              </div>
            ))}
            {bySource.size === 0 && (
              <div className="text-sm text-gray-400">급상승(jump&gt;0) 키워드가 아직 없음.</div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function TagBoard({
  title,
  hint,
  rows,
  accent,
  emptyText,
}: {
  title: string
  hint: string
  rows: VelocityRow[]
  accent: string
  emptyText: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
      </div>
      <p className="text-xs text-gray-500 mb-2">{hint}</p>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-400 py-4">{emptyText}</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.keyword + r.source} className="flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-gray-50">
              <span className="truncate mr-2">{r.keyword}</span>
              <span className="font-mono text-xs text-gray-500 whitespace-nowrap">
                {r.first_rank}→{r.current_rank} · {r.velocity}/d
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
