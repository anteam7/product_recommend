import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { FUNNEL_BUCKETS, bucketLabel, normalizeFunnelBucket } from '@/lib/trends/funnel-categories'
import FunnelQuadrant, { type FunnelRow } from './FunnelQuadrant'

export const dynamic = 'force-dynamic'

type KeywordRow = {
  keyword: string
  source: string
  category_top: string | null
  volume_relative: number | null
  collected_at: string
}

const SEARCH = 'naver_search_trend'
const SHOPPING = 'naver_shopping_insight'

/** 시계열(시간순 정렬)에서 전반부 평균 대비 후반부 평균의 % 변화 = 모멘텀 */
function momentumPct(series: Array<{ at: string; v: number }>): number | null {
  if (series.length < 2) return null
  const sorted = series.slice().sort((a, b) => a.at.localeCompare(b.at))
  const mid = Math.floor(sorted.length / 2)
  const early = sorted.slice(0, mid)
  const late = sorted.slice(mid)
  const avg = (arr: typeof sorted) => (arr.length ? arr.reduce((s, r) => s + r.v, 0) / arr.length : 0)
  const e = avg(early)
  const l = avg(late)
  if (e <= 0) return l > 0 ? 100 : 0
  return ((l - e) / e) * 100
}

/** 모멘텀 % → 0~100 플롯 좌표 (50 = flat). ±100% 가 양 끝에 닿도록 scale=0.5 */
function toAxis(pct: number): number {
  return Math.max(0, Math.min(100, 50 + pct * 0.5))
}

async function fetchData(): Promise<FunnelRow[]> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 14 * 86400_000).toISOString()

  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, category_top, volume_relative, collected_at')
    .in('source', [SEARCH, SHOPPING])
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(5000)

  const rows = (data ?? []) as KeywordRow[]

  // bucket → source → 일자별 시계열 (같은 버킷에 여러 키워드가 매핑되면 같은 날짜 값은 평균)
  type DayAgg = Map<string, { sum: number; n: number }>
  const acc = new Map<string, { search: DayAgg; shopping: DayAgg }>()

  for (const r of rows) {
    if (r.volume_relative == null) continue
    const bucket = normalizeFunnelBucket(r.keyword, r.category_top)
    if (!bucket) continue
    if (!acc.has(bucket)) acc.set(bucket, { search: new Map(), shopping: new Map() })
    const target = r.source === SEARCH ? acc.get(bucket)!.search : r.source === SHOPPING ? acc.get(bucket)!.shopping : null
    if (!target) continue
    const day = r.collected_at.slice(0, 10)
    const cur = target.get(day) ?? { sum: 0, n: 0 }
    cur.sum += r.volume_relative
    cur.n += 1
    target.set(day, cur)
  }

  const toSeries = (m: DayAgg) =>
    [...m.entries()].map(([at, { sum, n }]) => ({ at, v: sum / n }))

  const result: FunnelRow[] = []
  for (const b of FUNNEL_BUCKETS) {
    const entry = acc.get(b.key)
    if (!entry) continue
    const searchSeries = toSeries(entry.search)
    const shoppingSeries = toSeries(entry.shopping)
    const searchPct = momentumPct(searchSeries)
    const shoppingPct = momentumPct(shoppingSeries)
    // 퍼널갭은 두 소스 모두 신호가 있어야 의미가 있다
    if (searchPct == null || shoppingPct == null) continue
    result.push({
      key: b.key,
      label: bucketLabel(b.key),
      x: toAxis(searchPct),
      y: toAxis(shoppingPct),
      searchPct,
      shoppingPct,
      searchSamples: searchSeries.length,
      shoppingSamples: shoppingSeries.length,
    })
  }
  return result
}

export default async function DemandFunnelPage() {
  const rows = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Demand-Funnel Divergence</h1>
          <p className="text-sm text-gray-500 mt-1">
            검색수요(DataLab) vs 쇼핑클릭(쇼핑인사이트)의 14일 모멘텀 갭. X=검색 · Y=쇼핑클릭 · 우하단 = 미전환 연구수요(선점창).
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          두 소스 모두 신호가 잡힌 카테고리가 아직 없음. 검색·쇼핑 cron 14일 누적 후 다시 방문.
        </div>
      ) : (
        <FunnelQuadrant rows={rows} />
      )}

      <div className="rounded border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600 leading-relaxed">
        <p className="font-semibold text-gray-700 mb-1">사분면 해석</p>
        <p>① 검색↑·쇼핑↓ = <b>미전환 연구수요</b> — 연구는 활발하나 구매행동 미발생. 선점 카탈로그가 비어 있을 가능성 = 가장 이른 위탁 진입창.</p>
        <p>② 검색↓·쇼핑↑ = <b>포화/하락 경고</b> — 클릭은 아직 높지만 검색 관심이 식고 있음.</p>
        <p>③ 양 상승 = <b>검증된 성장</b> — 검색·쇼핑 동반 상승.</p>
        <p>④ 양 하락 = <b>회피</b>.</p>
        <p className="mt-2 text-gray-400">
          모멘텀 = 14일 윈도우 전반부 평균 대비 후반부 평균의 % 변화. 50 = flat. 신규 수집원 없이 기존 두 소스만 교차.
        </p>
      </div>
    </div>
  )
}
