import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  bestLeadLag,
  buildWatchlist,
  dayRange,
  toSeries,
  type DailyPoint,
  type Watch,
} from './leadLag'
import LeadLagView, { type MatrixRow } from './LeadLagView'

export const dynamic = 'force-dynamic'

const LOOKBACK = 60

// market_raw 소스 → 사람이 읽는 라벨
const SOURCE_LABEL: Record<string, string> = {
  dcinside: '디시인사이드',
  ppomppu: '뽐뿌',
  '82cook': '82cook',
  natepan: '네이트판',
  daum_news: '다음뉴스',
  clien_park: '클리앙',
  naver_news: '네이버뉴스',
  naver_blog: '네이버블로그',
  google_suggest: '구글자동완성',
  quasarzone_sale: '퀘이사존',
}

interface SourceDaily { grp: string; day: string; val: number }
interface SeriesRow { token: string; grp: string; day: string; val: number }

async function fetchData() {
  const sb = createAdminClient()

  // RPC (마이그레이션 후 가정 — 타입 미생성이므로 as any)
  const [{ data: srcRaw }, { data: serRaw }] = await Promise.all([
    (sb as any).rpc('jimscanner_lead_lag_source_daily', { p_days: LOOKBACK }),
    (sb as any).rpc('jimscanner_lead_lag_series', { p_days: LOOKBACK, p_limit: 150 }),
  ])

  const sourceDaily = (srcRaw ?? []) as SourceDaily[]
  const seriesRows = (serRaw ?? []) as SeriesRow[]

  if (sourceDaily.length === 0 && seriesRows.length === 0) {
    return { ready: false, matrix: [] as MatrixRow[], watch: [] as Watch[], days: [] as string[] }
  }

  // 공통 일자축
  const allDays = new Set<string>()
  for (const r of sourceDaily) allDays.add(r.day)
  for (const r of seriesRows) allDays.add(r.day)
  const sorted = [...allDays].sort()
  const days = sorted.length > 0 ? dayRange(sorted[0], sorted[sorted.length - 1]) : []

  // ① 리드-래그 매트릭스: 각 커뮤니티/뉴스 소스 → mainstream
  const bySource = new Map<string, DailyPoint[]>()
  for (const r of sourceDaily) {
    if (!bySource.has(r.grp)) bySource.set(r.grp, [])
    bySource.get(r.grp)!.push({ day: r.day, val: Number(r.val) })
  }
  const mainstreamSeries = toSeries(bySource.get('mainstream') ?? [], days)

  const matrix: MatrixRow[] = []
  for (const [grp, points] of bySource) {
    if (grp === 'mainstream') continue
    const leading = toSeries(points, days)
    const { lag, corr } = bestLeadLag(leading, mainstreamSeries)
    const total = leading.reduce((s, v) => s + v, 0)
    matrix.push({
      source: grp,
      label: SOURCE_LABEL[grp] ?? grp,
      lag,
      corr: Number(corr.toFixed(3)),
      total,
    })
  }
  matrix.sort((a, b) => b.corr - a.corr)

  // ② 선행 워치리스트: 토큰별 community vs mainstream
  const byToken = new Map<string, { lead: DailyPoint[]; main: DailyPoint[] }>()
  for (const r of seriesRows) {
    if (!byToken.has(r.token)) byToken.set(r.token, { lead: [], main: [] })
    const bucket = byToken.get(r.token)!
    const p = { day: r.day, val: Number(r.val) }
    if (r.grp === 'community') bucket.lead.push(p)
    else bucket.main.push(p)
  }
  const tokenSeries = new Map<string, { leading: number[]; mainstream: number[] }>()
  for (const [token, { lead, main }] of byToken) {
    tokenSeries.set(token, {
      leading: toSeries(lead, days),
      mainstream: toSeries(main, days),
    })
  }
  const watch = buildWatchlist(tokenSeries, days)

  return { ready: true, matrix, watch, days }
}

export default async function LeadLagPage() {
  const { ready, matrix, watch, days } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">교차소스 리드-래그</h1>
          <p className="text-sm text-gray-500 mt-1 max-w-3xl">
            커뮤니티·뉴스(선행 채팅)가 검색·쇼핑(메인스트림) 수요를 평균 며칠 앞서는지 {LOOKBACK}일 lag 교차상관으로 학습합니다.
            현재 선행소스에서만 급등 중이고 메인스트림은 아직 평탄한 후보가 <strong>선행 워치리스트</strong> — 학습된 lag 로 도달 D-day 를 예측합니다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {!ready ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          데이터 없음 — SQL 마이그레이션(<code className="font-mono">supabase/trend_lead_lag.sql</code>) 적용 후
          market_raw·trends 누적이 쌓이면 자동 등장합니다.
        </div>
      ) : (
        <LeadLagView matrix={matrix} watch={watch} days={days} />
      )}
    </div>
  )
}
