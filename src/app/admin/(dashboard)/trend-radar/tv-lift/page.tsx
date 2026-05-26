import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface LiftRow {
  tv_id: string | null
  keyword: string
  channel: string | null
  t0: string
  window_label: string
  baseline_avg: number
  post_value: number
  lift_abs: number
  lift_pct: number
  p_value: number
  ggsan_active: boolean
}

const WINDOW_OPTIONS = [
  { v: 15,   label: '0–15분' },
  { v: 60,   label: '1시간' },
  { v: 180,  label: '3시간' },
  { v: 1440, label: '24시간' },
  { v: 2880, label: '48시간' },
] as const

const LIFT_PCT_GATE = 150
const P_VALUE_GATE = 0.1

async function fetchLift(windowMinutes: number): Promise<LiftRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_tv_lift_rollup' as never, {
    window_minutes: windowMinutes,
    days_window: 30,
    baseline_days: 14,
    result_limit: 800,
  } as never)
  if (error) {
    console.error('jimscanner_tv_lift_rollup error', error)
    return []
  }
  return ((data as unknown) ?? []) as LiftRow[]
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/tv-lift' + (qs ? `?${qs}` : '')
}

// 채널×방송시각(요일×30분) 히트맵 — 평균 lift_pct 집계.
function buildHeatmap(rows: LiftRow[]) {
  // 요일(0=일~6=토) × 30분 슬롯(0..47)
  const sum = new Map<string, number>()
  const cnt = new Map<string, number>()
  for (const r of rows) {
    const d = new Date(r.t0)
    const dow = d.getDay()
    const slot = Math.floor((d.getHours() * 60 + d.getMinutes()) / 30)
    const key = `${dow}:${slot}`
    sum.set(key, (sum.get(key) ?? 0) + (Number.isFinite(r.lift_pct) ? Math.min(r.lift_pct, 999) : 0))
    cnt.set(key, (cnt.get(key) ?? 0) + 1)
  }
  const grid: { dow: number; slot: number; avg: number; n: number }[] = []
  for (let dow = 0; dow < 7; dow++) {
    for (let slot = 0; slot < 48; slot++) {
      const key = `${dow}:${slot}`
      const n = cnt.get(key) ?? 0
      const avg = n > 0 ? (sum.get(key) ?? 0) / n : 0
      grid.push({ dow, slot, avg, n })
    }
  }
  const maxAvg = Math.max(1, ...grid.map((g) => g.avg))
  return { grid, maxAvg }
}

const DOW_LABEL = ['일', '월', '화', '수', '목', '금', '토']

function slotLabel(slot: number): string {
  const h = Math.floor(slot / 2)
  const m = slot % 2 === 0 ? '00' : '30'
  return `${String(h).padStart(2, '0')}:${m}`
}

export default async function TvLiftPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>
}) {
  const sp = await searchParams
  const windowMinutes = parseInt(sp.window ?? '60', 10)
  const validWindow =
    WINDOW_OPTIONS.some((w) => w.v === windowMinutes) ? windowMinutes : 60

  const current: Record<string, string> = { window: String(validWindow) }

  const rows = await fetchLift(validWindow)

  // KPI
  const totalRows = rows.length
  const sigRows = rows.filter(
    (r) => r.lift_pct >= LIFT_PCT_GATE && r.p_value <= P_VALUE_GATE,
  )
  const queueRows = sigRows.filter((r) => r.ggsan_active)
  const avgLift =
    rows.length > 0
      ? rows.reduce((s, r) => s + (Number.isFinite(r.lift_pct) ? Math.min(r.lift_pct, 999) : 0), 0) /
        rows.length
      : 0

  const { grid, maxAvg } = buildHeatmap(rows)

  // 상위 lift 5건
  const top5 = [...rows]
    .filter((r) => Number.isFinite(r.lift_pct))
    .sort((a, b) => b.lift_pct - a.lift_pct)
    .slice(0, 5)

  // 핀 큐 후보 (gate 통과 + ggsan_active)
  const pinQueue = queueRows.slice(0, 30)
  // ggsan 미발행 (gate 통과 + ggsan_active=false) → 오늘 핀하기 CTA 대상
  const missingPin = sigRows.filter((r) => !r.ggsan_active).slice(0, 10)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">TV 푸시 → 검색 lift 인과 보드 (ITS)</h1>
          <p className="text-sm text-gray-500 mt-1">
            편성 시각 <code>t0</code> 직후 vs 사전 14일 baseline · 절대·% lift + 근사 p-value ·
            <span className="ml-1 font-semibold">gate: lift_pct ≥ {LIFT_PCT_GATE}% & p ≤ {P_VALUE_GATE}</span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 윈도우 필터 */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">post-window</span>
        {WINDOW_OPTIONS.map((w) => (
          <Link
            key={w.v}
            href={buildHref(current, { window: String(w.v) })}
            className={`px-2 py-1 text-xs rounded ${
              validWindow === w.v
                ? 'bg-amber-100 text-amber-700 font-semibold'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {w.label}
          </Link>
        ))}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="분석된 편성 row" value={totalRows} />
        <Kpi
          label={`gate 통과 (≥${LIFT_PCT_GATE}% · p≤${P_VALUE_GATE})`}
          value={sigRows.length}
          highlight={sigRows.length > 0}
        />
        <Kpi label="핀 큐 후보 (ggsan active)" value={queueRows.length} highlight={queueRows.length > 0} />
        <Kpi label="평균 lift %" value={`${avgLift.toFixed(1)}%`} />
      </section>

      {/* 히트맵: 요일 × 30분 슬롯 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          요일 × 방송시각 lift 히트맵{' '}
          <span className="text-xs font-normal text-gray-500">
            (셀=평균 lift_pct · 진할수록 큼 · 빈 셀=편성 없음)
          </span>
        </h2>
        <div className="rounded border border-gray-200 p-3 overflow-x-auto">
          <div className="inline-grid" style={{ gridTemplateColumns: `40px repeat(48, 12px)` }}>
            <div />
            {Array.from({ length: 48 }, (_, slot) => (
              <div key={slot} className="text-[8px] text-gray-400 text-center">
                {slot % 4 === 0 ? Math.floor(slot / 2) : ''}
              </div>
            ))}
            {Array.from({ length: 7 }, (_, dow) => (
              <FragmentRow key={dow} dow={dow} grid={grid} maxAvg={maxAvg} />
            ))}
          </div>
          <div className="text-xs text-gray-500 mt-2">
            세로: 요일 (일~토) · 가로: 30분 슬롯 (0~24시) · 색=평균 % lift
          </div>
        </div>
      </section>

      {/* 상위 lift 5건 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          상위 lift Top 5{' '}
          <span className="text-xs font-normal text-gray-500">
            (post-window {validWindow}분 기준)
          </span>
        </h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 bg-gray-50">
            <div className="col-span-4">키워드</div>
            <div className="col-span-2 text-right">baseline</div>
            <div className="col-span-2 text-right">post</div>
            <div className="col-span-1 text-right">lift %</div>
            <div className="col-span-1 text-right">p</div>
            <div className="col-span-2 text-right">t0</div>
          </div>
          {top5.length === 0 ? (
            <div className="px-3 py-6 text-sm text-gray-500 text-center">데이터 없음</div>
          ) : (
            top5.map((r, i) => (
              <div key={`${r.keyword}-${r.t0}-${i}`} className="grid grid-cols-12 px-3 py-2 text-sm">
                <div className="col-span-4 truncate flex items-center gap-2">
                  <span className="font-medium">{r.keyword}</span>
                  {r.ggsan_active && (
                    <span className="text-[9px] bg-green-100 text-green-700 px-1 rounded">ggsan</span>
                  )}
                </div>
                <div className="col-span-2 text-right font-mono text-xs">
                  {Number(r.baseline_avg).toFixed(2)}
                </div>
                <div className="col-span-2 text-right font-mono text-xs">
                  {Number(r.post_value).toFixed(0)}
                </div>
                <div
                  className={`col-span-1 text-right font-mono font-bold ${
                    r.lift_pct >= LIFT_PCT_GATE ? 'text-red-600' : 'text-gray-700'
                  }`}
                >
                  {r.lift_pct >= 999 ? '∞' : `${Number(r.lift_pct).toFixed(0)}%`}
                </div>
                <div className="col-span-1 text-right font-mono text-xs text-gray-500">
                  {Number(r.p_value).toFixed(2)}
                </div>
                <div className="col-span-2 text-right text-xs text-gray-400">
                  {r.t0.slice(5, 16).replace('T', ' ')}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* 핀 큐 후보 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          🔥 자동 핀 큐 후보{' '}
          <span className="text-xs font-normal text-gray-500">
            (lift_pct ≥ {LIFT_PCT_GATE}% · p ≤ {P_VALUE_GATE} · ggsan active)
          </span>
        </h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {pinQueue.length === 0 ? (
            <div className="px-3 py-6 text-sm text-gray-500 text-center">
              gate 통과 + ggsan 보유 항목 없음
            </div>
          ) : (
            pinQueue.map((r, i) => (
              <div
                key={`pinq-${r.keyword}-${r.t0}-${i}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm bg-red-50"
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-semibold truncate">{r.keyword}</span>
                  <span className="text-xs text-gray-500">
                    {r.t0.slice(5, 16).replace('T', ' ')}
                    {r.channel ? ` · ${r.channel}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono font-bold text-red-700">
                    +{r.lift_pct >= 999 ? '∞' : `${Number(r.lift_pct).toFixed(0)}%`}
                  </span>
                  <span className="font-mono text-gray-500">p={Number(r.p_value).toFixed(2)}</span>
                  <Link
                    href={`/admin/trend-radar/tv-ggsan-match?days=30&sim=0.2`}
                    className="px-2 py-0.5 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                  >
                    핀 큐로
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ggsan 미보유 — 오늘 핀하기 CTA */}
      {missingPin.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            🟡 ggsan 미발행 lift{' '}
            <span className="text-xs font-normal text-gray-500">
              (gate 통과했지만 ggsan 매칭 없음 — 검색 lift 만 있음)
            </span>
          </h2>
          <div className="rounded border border-amber-300 bg-amber-50 divide-y divide-amber-100">
            {missingPin.map((r, i) => (
              <div
                key={`mp-${r.keyword}-${r.t0}-${i}`}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-semibold truncate">{r.keyword}</span>
                  <span className="text-xs text-gray-500">
                    {r.t0.slice(5, 16).replace('T', ' ')}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono font-bold text-amber-700">
                    +{r.lift_pct >= 999 ? '∞' : `${Number(r.lift_pct).toFixed(0)}%`}
                  </span>
                  <Link
                    href={`/admin/trend-radar/ggsan?q=${encodeURIComponent(r.keyword)}`}
                    className="px-2 py-0.5 bg-amber-500 text-white rounded text-xs hover:bg-amber-600"
                  >
                    오늘 핀하기
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>ITS 정의:</strong> baseline = t0 직전 {14}일간 평균 발생량을 post-window 폭({validWindow}분)으로 환산.
          post = t0 ~ t0+{validWindow}분 발생량. lift = (post − baseline) / baseline.
        </div>
        <div>
          <strong>p-value:</strong> 단순 SQL 근사. 정확한 permutation 100 iter 는 별도 cron 으로 jimscanner_trends_tv_lift 테이블에 적재.
        </div>
        <div>
          <strong>핀 큐 게이트:</strong> lift_pct ≥ {LIFT_PCT_GATE}% AND p ≤ {P_VALUE_GATE} AND ggsan 활성 재고 매칭.
        </div>
      </section>
    </div>
  )
}

function FragmentRow({
  dow,
  grid,
  maxAvg,
}: {
  dow: number
  grid: { dow: number; slot: number; avg: number; n: number }[]
  maxAvg: number
}) {
  const cells = grid.filter((g) => g.dow === dow)
  return (
    <>
      <div className="text-[10px] text-gray-500 pr-1 text-right self-center">{DOW_LABEL[dow]}</div>
      {cells.map((c) => {
        const intensity = c.n > 0 ? Math.min(1, c.avg / maxAvg) : 0
        const bg =
          c.n === 0
            ? '#f5f5f5'
            : `rgba(220, 38, 38, ${0.15 + intensity * 0.7})` // red-600 base
        return (
          <div
            key={`${dow}-${c.slot}`}
            className="h-3"
            style={{ background: bg }}
            title={`${DOW_LABEL[dow]} ${slotLabel(c.slot)} · n=${c.n} · 평균 lift ${c.avg.toFixed(0)}%`}
          />
        )
      })}
    </>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
