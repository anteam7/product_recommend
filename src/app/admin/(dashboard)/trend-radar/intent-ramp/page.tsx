import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import IntentRampBoard, { type RampRow } from './IntentRampBoard'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '진입 타이밍 — Intent Ramp',
}

// jimscanner_trends_intent_weekly 뷰 (supabase/trends_intent_ramp.sql).
// types 에 없으므로 `as any` 캐스팅.
interface WeeklyRow {
  category_top: string
  week: string
  classified_count: number
  avg_volume: number | null
  informational_share: number | null
  commercial_share: number | null
  transactional_share: number | null
  navigational_share: number | null
}

const WEEKS = 8

function slope(series: number[]): number {
  // 단순 최소제곱 기울기 (주당 Δ). 포인트 < 2 면 0.
  const n = series.length
  if (n < 2) return 0
  const xs = series.map((_, i) => i)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = series.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (series[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

async function fetchData(): Promise<{ rows: RampRow[]; weeks: string[] }> {
  const sb = createAdminClient()

  const { data } = await (sb as any)
    .from('jimscanner_trends_intent_weekly')
    .select(
      'category_top, week, classified_count, avg_volume, informational_share, commercial_share, transactional_share, navigational_share',
    )
    .order('week', { ascending: true })

  const all = (data ?? []) as WeeklyRow[]
  if (all.length === 0) return { rows: [], weeks: [] }

  // 최근 WEEKS 주만.
  const weekSet = Array.from(new Set(all.map((r) => r.week))).sort()
  const keepWeeks = weekSet.slice(-WEEKS)
  const keepSet = new Set(keepWeeks)

  const byCat = new Map<string, WeeklyRow[]>()
  for (const r of all) {
    if (!keepSet.has(r.week)) continue
    const list = byCat.get(r.category_top) ?? []
    list.push(r)
    byCat.set(r.category_top, list)
  }

  const rows: RampRow[] = []
  for (const [cat, list] of byCat) {
    list.sort((a, b) => a.week.localeCompare(b.week))
    // 주별 시리즈 (없는 주는 건너뜀 — 스파크라인은 존재 포인트만)
    const trans = list.map((r) => Number(r.transactional_share ?? 0) * 100)
    const info = list.map((r) => Number(r.informational_share ?? 0) * 100)
    const transSlope = slope(trans)
    const latestTrans = trans.length ? trans[trans.length - 1] : 0
    const latestInfo = info.length ? info[info.length - 1] : 0
    const vol = list.reduce((a, r) => a + Number(r.avg_volume ?? 0), 0) / (list.length || 1)
    rows.push({
      category: cat,
      weeks: list.map((r) => r.week),
      transSeries: trans,
      infoSeries: info,
      transSlope: Math.round(transSlope * 100) / 100,
      latestTrans: Math.round(latestTrans),
      latestInfo: Math.round(latestInfo),
      avgVolume: Math.round(vol),
      sampleCount: list.reduce((a, r) => a + (r.classified_count ?? 0), 0),
    })
  }

  rows.sort((a, b) => b.transSlope - a.transSlope)
  return { rows, weeks: keepWeeks }
}

export default async function IntentRampPage() {
  const { rows, weeks } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">구매의도 성숙도 램프</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 인텐트 믹스가 <b>정보탐색→구매전환</b>으로 이동하는 기울기(transactional Δ/주).
            최근 {WEEKS}주 · 우상단 = 전환 가속 중 = 지금 진입 후보.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 인텐트 데이터 없음. classify cron 이 키워드 <code>classified_intent</code> 를 채운 뒤 주 단위로 누적되면 표시됩니다.
          <div className="mt-2 text-xs">
            (마이그레이션: <code>supabase/trends_intent_ramp.sql</code> 적용 + classify-trends-llm 실행)
          </div>
        </div>
      ) : (
        <IntentRampBoard rows={rows} weeks={weeks} />
      )}
    </div>
  )
}
