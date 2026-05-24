import { NextResponse, type NextRequest } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const WINDOW_DAYS = 90
const MAX_LAG = 21
const MIN_SAMPLE_N = 30
const CORR_THRESHOLD = 0.55
// keyword × series cap (메모리/시간 보호). 너무 많은 키워드는 상위 N개만.
const MAX_KEYWORDS = 200

interface KwRow {
  keyword: string
  category_top: string | null
  volume_relative: number | null
  collected_at: string
}

interface Series {
  keyword: string
  category_top: string | null
  // index: day offset from window_start (0..WINDOW_DAYS-1), value: mean volume_relative for that day (NaN if missing)
  values: number[]
  lastAt: string | null
  nonNullCount: number
}

function dayIndex(iso: string, start: Date): number {
  const d = new Date(iso)
  const ms = d.getTime() - start.getTime()
  return Math.floor(ms / 86_400_000)
}

// Pearson correlation on overlapping non-NaN positions, given series x and series y already shifted.
// Returns { r, n, p } where p is approximated using a t-test (two-sided).
function pearson(x: number[], y: number[]): { r: number; n: number; p: number } | null {
  let n = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < x.length; i++) {
    const a = x[i]
    const b = y[i]
    if (!isFinite(a) || !isFinite(b)) continue
    n++
    sx += a
    sy += b
  }
  if (n < MIN_SAMPLE_N) return null
  const mx = sx / n
  const my = sy / n
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < x.length; i++) {
    const a = x[i]
    const b = y[i]
    if (!isFinite(a) || !isFinite(b)) continue
    const da = a - mx
    const db = b - my
    cov += da * db
    vx += da * da
    vy += db * db
  }
  if (vx === 0 || vy === 0) return null
  const r = cov / Math.sqrt(vx * vy)
  // two-sided t-test approximation: t = r * sqrt((n-2)/(1-r^2)), p ~ 2*(1 - tcdf)
  // We approximate p using a simple bound: high |r| with high n → very small p.
  // For UI/admin filtering, a coarse bound suffices.
  const t = Math.abs(r) * Math.sqrt(Math.max(1, n - 2) / Math.max(1e-9, 1 - r * r))
  // Normal approximation for large n.
  const p = 2 * (1 - normCdf(t))
  return { r, n, p }
}

function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

async function loadSeries(admin: SupabaseClient, windowStart: Date): Promise<Series[]> {
  // 페이지네이션해서 collected_at >= windowStart 인 row 전부 받기.
  const rows: KwRow[] = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await admin
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top, volume_relative, collected_at')
      .gte('collected_at', windowStart.toISOString())
      .order('collected_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const chunk = (data ?? []) as KwRow[]
    rows.push(...chunk)
    if (chunk.length < PAGE) break
    from += PAGE
    if (from > 200_000) break // hard safety
  }

  // group by keyword
  const grouped = new Map<string, { rows: KwRow[]; category_top: string | null }>()
  for (const r of rows) {
    if (!r.keyword) continue
    const g = grouped.get(r.keyword)
    if (g) {
      g.rows.push(r)
      if (!g.category_top && r.category_top) g.category_top = r.category_top
    } else {
      grouped.set(r.keyword, { rows: [r], category_top: r.category_top })
    }
  }

  // daily mean per keyword
  const series: Series[] = []
  for (const [keyword, g] of grouped) {
    const daySum = new Array<number>(WINDOW_DAYS).fill(0)
    const dayCnt = new Array<number>(WINDOW_DAYS).fill(0)
    let lastAt: string | null = null
    for (const r of g.rows) {
      const idx = dayIndex(r.collected_at, windowStart)
      if (idx < 0 || idx >= WINDOW_DAYS) continue
      if (r.volume_relative == null) continue
      const v = Number(r.volume_relative)
      if (!isFinite(v)) continue
      daySum[idx] += v
      dayCnt[idx] += 1
      if (!lastAt || r.collected_at > lastAt) lastAt = r.collected_at
    }
    const values = new Array<number>(WINDOW_DAYS)
    let nonNull = 0
    for (let i = 0; i < WINDOW_DAYS; i++) {
      if (dayCnt[i] === 0) {
        values[i] = NaN
      } else {
        values[i] = daySum[i] / dayCnt[i]
        nonNull++
      }
    }
    if (nonNull < MIN_SAMPLE_N + MAX_LAG) continue
    series.push({ keyword, category_top: g.category_top, values, lastAt, nonNullCount: nonNull })
  }

  // 활성도(nonNullCount) 상위 N 개만
  series.sort((a, b) => b.nonNullCount - a.nonNullCount)
  return series.slice(0, MAX_KEYWORDS)
}

function computeEdges(series: Series[]): {
  src: string
  dst: string
  src_category: string | null
  dst_category: string | null
  lag_days: number
  corr: number
  p_value: number
  sample_n: number
  src_last_at: string | null
  dst_last_at: string | null
}[] {
  const edges: ReturnType<typeof computeEdges> = []
  // 각 pair (i, j), i != j, lag = 1..MAX_LAG.
  // src=i (선행) → dst=j (후행, lag 일 뒤). lag=0 은 동시점이라 인과 정보 없음 → 1부터.
  for (let i = 0; i < series.length; i++) {
    const a = series[i]
    for (let j = 0; j < series.length; j++) {
      if (i === j) continue
      const b = series[j]
      let best: { lag: number; r: number; n: number; p: number } | null = null
      for (let lag = 1; lag <= MAX_LAG; lag++) {
        // x = a[t], y = b[t+lag] → b 를 lag 만큼 앞으로 당김
        const len = WINDOW_DAYS - lag
        if (len < MIN_SAMPLE_N) continue
        const x = new Array<number>(len)
        const y = new Array<number>(len)
        for (let t = 0; t < len; t++) {
          x[t] = a.values[t]
          y[t] = b.values[t + lag]
        }
        const p = pearson(x, y)
        if (!p) continue
        if (Math.abs(p.r) < CORR_THRESHOLD) continue
        if (!best || Math.abs(p.r) > Math.abs(best.r)) {
          best = { lag, r: p.r, n: p.n, p: p.p }
        }
      }
      if (!best) continue
      edges.push({
        src: a.keyword,
        dst: b.keyword,
        src_category: a.category_top,
        dst_category: b.category_top,
        lag_days: best.lag,
        corr: Number(best.r.toFixed(4)),
        p_value: Number(best.p.toFixed(6)),
        sample_n: best.n,
        src_last_at: a.lastAt,
        dst_last_at: b.lastAt,
      })
    }
  }
  return edges
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = Date.now()
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 86_400_000)
  const windowStartDate = windowStart.toISOString().slice(0, 10)
  const windowEndDate = windowEnd.toISOString().slice(0, 10)

  let status: 'ok' | 'partial' | 'error' = 'ok'
  let errorMessage: string | null = null
  let fetched = 0
  let inserted = 0

  try {
    const series = await loadSeries(admin, windowStart)
    fetched = series.length

    const edges = computeEdges(series).map((e) => ({
      ...e,
      window_start: windowStartDate,
      window_end: windowEndDate,
    }))

    // 같은 윈도(이번 run) 의 이전 row 가 있어도, 보통은 이번 run 이 첫 row 이므로
    // 단순 INSERT 만으로 충분. 단, 동일 윈도 재실행 시 중복 방지하려고
    // 같은 (window_start, window_end) 행을 먼저 삭제.
    if (edges.length > 0) {
      // delete existing for this window
      const sb = admin as unknown as {
        from: (t: string) => {
          delete: () => {
            eq: (c: string, v: string) => {
              eq: (c: string, v: string) => Promise<{ error: unknown }>
            }
          }
          insert: (rows: unknown[]) => Promise<{ error: unknown }>
        }
      }
      await sb
        .from('jimscanner_trends_xcorr_edges')
        .delete()
        .eq('window_start', windowStartDate)
        .eq('window_end', windowEndDate)

      // chunked insert
      const CHUNK = 500
      for (let off = 0; off < edges.length; off += CHUNK) {
        const slice = edges.slice(off, off + CHUNK)
        const ins = await sb.from('jimscanner_trends_xcorr_edges').insert(slice)
        if (ins.error) {
          status = 'partial'
          errorMessage = String(ins.error)
          break
        }
        inserted += slice.length
      }
    }
  } catch (err) {
    status = 'error'
    errorMessage = err instanceof Error ? err.message : String(err)
  }

  const finishedAt = new Date()
  // run log
  await admin.from('jimscanner_trends_runs').insert({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source: 'compute_keyword_xcorr',
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    duration_ms: Date.now() - startedAt,
    error_message: errorMessage,
    triggered_by: 'cron',
    finished_at: finishedAt.toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return NextResponse.json(
    {
      status,
      fetched,
      inserted,
      window_start: windowStartDate,
      window_end: windowEndDate,
      error_message: errorMessage,
    },
    { status: status === 'error' ? 500 : 200 },
  )
}
