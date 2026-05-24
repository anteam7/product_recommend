import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import LeadLagBoard, { type EdgeRow, type DailyPoint } from './LeadLagBoard'

export const dynamic = 'force-dynamic'

interface RawEdge {
  src: string
  dst: string
  src_category: string | null
  dst_category: string | null
  lag_days: number
  corr: number
  p_value: number | null
  sample_n: number
  src_last_at: string | null
  dst_last_at: string | null
  window_start: string
  window_end: string
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 가장 최근 윈도의 edge 만
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: edgesRaw } = await (sb as any)
    .from('jimscanner_trends_xcorr_edges')
    .select(
      'src, dst, src_category, dst_category, lag_days, corr, p_value, sample_n, src_last_at, dst_last_at, window_start, window_end, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(5000)

  const edges = (edgesRaw ?? []) as RawEdge[]
  // 가장 최근 윈도만
  let latestWindow: string | null = null
  for (const e of edges) {
    if (!latestWindow || e.window_end > latestWindow) latestWindow = e.window_end
  }
  const filtered = latestWindow ? edges.filter((e) => e.window_end === latestWindow) : edges

  // 어떤 키워드의 시계열이 필요한지 모르므로 - 일단 edge 에 등장하는 키워드 전체에 대해 90일치 시계열을 로드.
  const keywords = new Set<string>()
  for (const e of filtered) {
    keywords.add(e.src)
    keywords.add(e.dst)
  }
  const kwList = Array.from(keywords)
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()

  const series: Record<string, DailyPoint[]> = {}
  // chunked IN query
  const CHUNK = 50
  for (let i = 0; i < kwList.length; i += CHUNK) {
    const slice = kwList.slice(i, i + CHUNK)
    const { data } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, volume_relative, collected_at')
      .in('keyword', slice)
      .gte('collected_at', since)
      .order('collected_at', { ascending: true })
      .limit(50_000)
    for (const r of (data ?? []) as {
      keyword: string
      volume_relative: number | null
      collected_at: string
    }[]) {
      if (r.volume_relative == null) continue
      const day = r.collected_at.slice(0, 10)
      const arr = (series[r.keyword] ??= [])
      const last = arr[arr.length - 1]
      const v = Number(r.volume_relative)
      if (last && last.day === day) {
        last.value = (last.value + v) / 2 // simple running mean
      } else {
        arr.push({ day, value: v })
      }
    }
  }

  return { edges: filtered, series, latestWindow }
}

export default async function LeadLagPage() {
  const { edges, series, latestWindow } = await fetchData()

  const rows: EdgeRow[] = edges.map((e) => ({
    src: e.src,
    dst: e.dst,
    srcCategory: e.src_category,
    dstCategory: e.dst_category,
    lagDays: e.lag_days,
    corr: e.corr,
    pValue: e.p_value,
    sampleN: e.sample_n,
    srcLastAt: e.src_last_at,
    dstLastAt: e.dst_last_at,
  }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">리드-래그 인과 그래프</h1>
          <p className="text-sm text-gray-500 mt-1">
            키워드 × 키워드 교차상관 (lag 1~21일, |corr| ≥ 0.55, n ≥ 30).{' '}
            {latestWindow ? `윈도 종료: ${latestWindow}` : '아직 데이터 없음 — cron 미실행'}
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-500">
          아직 edge 가 없다. <code className="font-mono">/api/cron/compute-keyword-xcorr</code> 를 한 번 실행해야 한다.
        </div>
      ) : (
        <LeadLagBoard rows={rows} series={series} />
      )}
    </div>
  )
}
