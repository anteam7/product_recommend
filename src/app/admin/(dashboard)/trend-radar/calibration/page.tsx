import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const HORIZONS = [7, 14, 30] as const
type Horizon = (typeof HORIZONS)[number]

interface BacktestRow {
  product_id: string
  baseline_at: string
  baseline_final: number
  baseline_components: {
    trend?: number
    commerce?: number
    supplier?: number
    competition?: number
  }
  horizon_days: number
  outcome_metrics: {
    alias_delta?: number
    supplier_new?: number
    tv_push?: number
    volume_lift_pct?: number
  }
  hit: boolean
  evaluated_at: string
}

async function fetchBacktest(horizon: Horizon) {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 60 * 86400_000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_score_backtest' as any)
    .select(
      'product_id, baseline_at, baseline_final, baseline_components, horizon_days, outcome_metrics, hit, evaluated_at',
    )
    .eq('horizon_days', horizon)
    .gte('evaluated_at', since)
    .order('baseline_final', { ascending: false })
    .limit(2000)
  return ((data ?? []) as unknown as BacktestRow[])
}

/** precision@final≥50: baseline_final >= 50 인 row 중 hit 비율. */
function computePrecisionAtFinal(rows: BacktestRow[], threshold = 50) {
  const positives = rows.filter((r) => r.baseline_final >= threshold)
  const hits = positives.filter((r) => r.hit).length
  return {
    n: positives.length,
    hits,
    precision: positives.length === 0 ? 0 : hits / positives.length,
  }
}

/** 컴포넌트별 hit rate — 각 컴포넌트 점수가 임계치 이상일 때 hit 비율. */
function computeComponentHitRates(rows: BacktestRow[], threshold = 50) {
  const components = ['trend', 'commerce', 'supplier', 'competition'] as const
  const out: Record<string, { n: number; hits: number; rate: number }> = {}
  for (const c of components) {
    const sel = rows.filter((r) => (r.baseline_components?.[c] ?? 0) >= threshold)
    const hits = sel.filter((r) => r.hit).length
    out[c] = { n: sel.length, hits, rate: sel.length === 0 ? 0 : hits / sel.length }
  }
  return out
}

/** lift table — final_score 10단위 bucket 별 hit rate (decile-style) */
function computeLiftTable(rows: BacktestRow[]) {
  const buckets: { range: string; n: number; hits: number; rate: number }[] = []
  for (let lo = 0; lo < 100; lo += 10) {
    const hi = lo + 10
    const sel = rows.filter((r) => r.baseline_final >= lo && r.baseline_final < hi)
    const hits = sel.filter((r) => r.hit).length
    buckets.push({
      range: `${lo}-${hi}`,
      n: sel.length,
      hits,
      rate: sel.length === 0 ? 0 : hits / sel.length,
    })
  }
  return buckets.reverse() // 높은 점수 위로
}

/**
 * 권장 가중치 추천 — 컴포넌트별 hit-rate 를 정규화하여 비율 산출.
 * 단순 휴리스틱: w_c ∝ max(0, hit_rate_c - base_rate)
 */
function recommendWeights(rows: BacktestRow[]) {
  const baseRate = rows.length === 0 ? 0 : rows.filter((r) => r.hit).length / rows.length
  const comps = computeComponentHitRates(rows)
  const raw = {
    trend: Math.max(0, comps.trend.rate - baseRate),
    commerce: Math.max(0, comps.commerce.rate - baseRate),
    supplier: Math.max(0, comps.supplier.rate - baseRate),
    competition: Math.max(0, comps.competition.rate - baseRate),
  }
  const sum = raw.trend + raw.commerce + raw.supplier + raw.competition
  if (sum === 0) return { trend: 0.25, commerce: 0.25, supplier: 0.25, competition: 0.25 }
  return {
    trend: raw.trend / sum,
    commerce: raw.commerce / sum,
    supplier: raw.supplier / sum,
    competition: raw.competition / sum,
  }
}

function fmtPct(x: number) {
  return `${(x * 100).toFixed(1)}%`
}

export default async function CalibrationPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string }>
}) {
  const sp = await searchParams
  const horizon = (HORIZONS.includes(Number(sp.h) as Horizon) ? Number(sp.h) : 14) as Horizon

  const rows = await fetchBacktest(horizon)
  const precision = computePrecisionAtFinal(rows, 50)
  const compRates = computeComponentHitRates(rows, 50)
  const lift = computeLiftTable(rows)
  const recommend = recommendWeights(rows)

  // 산점도: final_score (x) × outcome_total (y)
  const scatter = rows.slice(0, 500).map((r) => {
    const outcomeTotal =
      (r.outcome_metrics?.alias_delta ?? 0) * 2 +
      (r.outcome_metrics?.supplier_new ?? 0) * 5 +
      (r.outcome_metrics?.tv_push ?? 0) * 3
    return { x: r.baseline_final, y: outcomeTotal, hit: r.hit }
  })

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">점수 캘리브레이션</h1>
        <p className="text-sm text-gray-500 mt-1">
          4점수 + final_score 의 실제 정확도 검증 · 가중치 추천
        </p>
      </header>

      {/* horizon 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {HORIZONS.map((h) => (
          <Link
            key={h}
            href={`/admin/trend-radar/calibration?h=${h}`}
            className={`px-3 py-2 text-sm ${
              horizon === h
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {h}일 호라이즌
          </Link>
        ))}
        <span className="ml-auto text-xs text-gray-400 self-center">
          {rows.length.toLocaleString()} 백테스트 row
        </span>
      </nav>

      {rows.length === 0 ? (
        <EmptyState horizon={horizon} />
      ) : (
        <>
          {/* KPI 카드 */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              label={`precision @ final≥50`}
              value={fmtPct(precision.precision)}
              hint={`${precision.hits} / ${precision.n}`}
            />
            <KpiCard
              label="base hit rate"
              value={fmtPct(rows.filter((r) => r.hit).length / rows.length)}
              hint={`전체 ${rows.length}건 평균`}
            />
            <KpiCard
              label="최고 컴포넌트"
              value={
                Object.entries(compRates).sort((a, b) => b[1].rate - a[1].rate)[0]?.[0] ?? '-'
              }
              hint="hit-rate 1위"
            />
            <KpiCard
              label="평가 호라이즌"
              value={`${horizon}일`}
              hint="baseline → outcome"
            />
          </section>

          {/* 4점수별 hit rate */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              4점수별 hit rate (≥50 임계치)
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(['trend', 'commerce', 'supplier', 'competition'] as const).map((c) => (
                <div key={c} className="rounded border border-gray-200 p-3">
                  <div className="text-xs text-gray-500">{c}</div>
                  <div className="text-2xl font-bold mt-1">
                    {fmtPct(compRates[c].rate)}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {compRates[c].hits} hits / {compRates[c].n} 후보
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 권장 가중치 */}
          <section className="rounded border border-emerald-300 bg-emerald-50/40 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              ⚖️ 권장 가중치 (현재 데이터 기반)
            </h2>
            <div className="grid grid-cols-4 gap-3">
              {(['trend', 'commerce', 'supplier', 'competition'] as const).map((c) => (
                <div key={c} className="text-center">
                  <div className="text-xs text-gray-500">{c}</div>
                  <div className="text-2xl font-mono font-bold">
                    {(recommend[c] * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-3">
              hit-rate 가 base rate 보다 높은 만큼 정규화한 휴리스틱 비율. 검증 후{' '}
              <code className="px-1 bg-white rounded">/api/admin/score-recompute-with-weights</code>{' '}
              로 시뮬레이션 가능.
            </p>
          </section>

          {/* lift table */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              Lift table — final_score 구간별 hit rate
            </h2>
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1 border-b">
              <div className="col-span-2">final 구간</div>
              <div className="col-span-2 text-right">n</div>
              <div className="col-span-2 text-right">hits</div>
              <div className="col-span-2 text-right">hit rate</div>
              <div className="col-span-4">bar</div>
            </div>
            {lift.map((b) => (
              <div
                key={b.range}
                className="grid grid-cols-12 px-2 py-1 text-sm border-b border-gray-100"
              >
                <div className="col-span-2 font-mono text-gray-700">{b.range}</div>
                <div className="col-span-2 text-right font-mono">{b.n}</div>
                <div className="col-span-2 text-right font-mono">{b.hits}</div>
                <div className="col-span-2 text-right font-mono">{fmtPct(b.rate)}</div>
                <div className="col-span-4 flex items-center">
                  <div
                    className="h-2 bg-emerald-400 rounded"
                    style={{ width: `${Math.round(b.rate * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </section>

          {/* 산점도 — SVG */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              산점도: final_score × outcome
            </h2>
            <div className="rounded border border-gray-200 p-3 bg-white">
              <Scatter points={scatter} />
              <div className="text-xs text-gray-500 mt-2">
                x: baseline final_score · y: outcome (alias×2 + supplier×5 + tv×3)
                · 초록=hit, 회색=miss · 최대 500점
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Scatter({ points }: { points: { x: number; y: number; hit: boolean }[] }) {
  const W = 720
  const H = 240
  const padL = 32
  const padB = 24
  const padT = 8
  const padR = 8

  const xMax = 100
  const yMax = Math.max(10, ...points.map((p) => p.y))
  const xScale = (x: number) => padL + ((x / xMax) * (W - padL - padR))
  const yScale = (y: number) => H - padB - ((y / yMax) * (H - padT - padB))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* axes */}
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#d1d5db" />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#d1d5db" />
      {[0, 25, 50, 75, 100].map((tick) => (
        <g key={tick}>
          <line
            x1={xScale(tick)}
            y1={H - padB}
            x2={xScale(tick)}
            y2={H - padB + 4}
            stroke="#9ca3af"
          />
          <text
            x={xScale(tick)}
            y={H - padB + 14}
            fontSize="10"
            textAnchor="middle"
            fill="#6b7280"
          >
            {tick}
          </text>
        </g>
      ))}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={xScale(p.x)}
          cy={yScale(p.y)}
          r={2.5}
          fill={p.hit ? '#10b981' : '#9ca3af'}
          opacity={p.hit ? 0.85 : 0.45}
        />
      ))}
    </svg>
  )
}

function EmptyState({ horizon }: { horizon: number }) {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 백테스트 row 가 없습니다</p>
      <p className="text-sm mt-2">
        cron <code className="px-1 bg-gray-100 rounded">scripts/run-score-backtest.mjs</code>{' '}
        가 일 1회 30/14/7일 전 스냅샷을 평가해 적재합니다.
        <br />
        horizon={horizon}일 기준 데이터를 보려면 baseline 시점 이전에 score row 가 있어야 합니다.
      </p>
    </div>
  )
}
