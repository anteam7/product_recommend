// 수집 파이프라인 신뢰도 — jimscanner_trends_runs 시계열에서 소스별 건강도 계산.
// SQL view(jimscanner_trends_source_health)와 동일한 로직을 TS 로 들고 있어
// view 마이그레이션 적용 여부와 무관하게 동작한다. base table 만 읽는다.
import { createAdminClient } from '@/lib/auth/admin-supabase'

export interface RunSample {
  source: string
  status: string
  fetched_count: number
  inserted_count: number
  started_at: string
}

export interface SourceHealth {
  source: string
  nRuns: number
  meanInserted: number
  sdInserted: number
  lastInserted: number
  lastStatus: string
  lastStarted: string
  /** 자기-baseline 대비 z-score (음수 = 평소보다 폭락) */
  insertedZ: number
  okRate: number
  partialRate: number
  errorRate: number
  hoursSinceLast: number
  /** 무성 급락 / error / 30h+ stale → degraded */
  degraded: boolean
  /** z<=-1.5 무성 급락 플래그 */
  silentDrop: boolean
  /** freshness lag 경보 */
  stale: boolean
}

// degraded 판정 임계값 (SQL view 와 동기화 — 둘 다 바꿀 것)
export const DROP_Z = -1.5
export const STALE_HOURS = 30

export function computeSourceHealth(rows: RunSample[]): SourceHealth[] {
  const bySource = new Map<string, RunSample[]>()
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, [])
    bySource.get(r.source)!.push(r)
  }

  const now = Date.now()
  const out: SourceHealth[] = []
  for (const [source, runs] of bySource) {
    // started_at DESC 정렬 (입력이 이미 DESC 라도 방어적으로)
    runs.sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    const latest = runs[0]
    const n = runs.length
    const inserts = runs.map((r) => r.inserted_count)
    const mean = inserts.reduce((s, v) => s + v, 0) / n
    const variance = inserts.reduce((s, v) => s + (v - mean) ** 2, 0) / n
    const sd = Math.sqrt(variance)
    const insertedZ = sd === 0 ? 0 : (latest.inserted_count - mean) / sd

    const rate = (st: string) => runs.filter((r) => r.status === st).length / n
    const okRate = rate('ok')
    const partialRate = rate('partial')
    const errorRate = rate('error')

    const hoursSinceLast = (now - new Date(latest.started_at).getTime()) / 3600000

    const silentDrop = sd > 0 && insertedZ <= DROP_Z
    const stale = hoursSinceLast > STALE_HOURS
    const degraded = silentDrop || stale || latest.status === 'error'

    out.push({
      source,
      nRuns: n,
      meanInserted: round1(mean),
      sdInserted: round1(sd),
      lastInserted: latest.inserted_count,
      lastStatus: latest.status,
      lastStarted: latest.started_at,
      insertedZ: round2(insertedZ),
      okRate: round3(okRate),
      partialRate: round3(partialRate),
      errorRate: round3(errorRate),
      hoursSinceLast: round1(hoursSinceLast),
      degraded,
      silentDrop,
      stale,
    })
  }
  // degraded 먼저, 그다음 z 오름차순(가장 심한 급락 위로)
  out.sort((a, b) => {
    if (a.degraded !== b.degraded) return a.degraded ? -1 : 1
    return a.insertedZ - b.insertedZ
  })
  return out
}

/** 최근 30일 runs 를 읽어 소스 건강도 맵을 반환 */
export async function fetchSourceHealth(): Promise<{
  health: SourceHealth[]
  bySource: Map<string, SourceHealth>
  totalInserted24h: number
}> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_runs')
    .select('source, status, fetched_count, inserted_count, started_at')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(2000)

  const rows = (data ?? []) as RunSample[]
  const health = computeSourceHealth(rows)
  const bySource = new Map(health.map((h) => [h.source, h]))

  const since24h = Date.now() - 24 * 60 * 60 * 1000
  const totalInserted24h = rows
    .filter((r) => new Date(r.started_at).getTime() >= since24h)
    .reduce((s, r) => s + r.inserted_count, 0)

  return { health, bySource, totalInserted24h }
}

const round1 = (v: number) => Math.round(v * 10) / 10
const round2 = (v: number) => Math.round(v * 100) / 100
const round3 = (v: number) => Math.round(v * 1000) / 1000
