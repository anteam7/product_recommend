import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// 파이프라인 리드타임 분해 보드 — Cycle-Time CFD & Bottleneck Audit
// raw → classify → pin → publish → first_order 5단계 stage 추적
// ────────────────────────────────────────────────────────────

type StageKey = 'raw' | 'classify' | 'pin' | 'publish' | 'first_order'

const STAGES: { key: StageKey; label: string; color: string }[] = [
  { key: 'raw', label: 'raw 시그널', color: '#94a3b8' },
  { key: 'classify', label: 'LLM 분류', color: '#60a5fa' },
  { key: 'pin', label: '핀', color: '#fbbf24' },
  { key: 'publish', label: '쿠팡 발행', color: '#34d399' },
  { key: 'first_order', label: '첫 주문', color: '#a78bfa' },
]

const STAGE_COL: Record<StageKey, keyof CycleRow> = {
  raw: 'raw_seen_at',
  classify: 'classified_at',
  pin: 'pinned_at',
  publish: 'published_at',
  first_order: 'first_order_at',
}

interface CycleRow {
  product_id: string
  canonical_name: string | null
  category_top: string | null
  raw_seen_at: string | null
  classified_at: string | null
  pinned_at: string | null
  published_at: string | null
  first_order_at: string | null
}

const DAY_MS = 86_400_000

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const d = (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS
  if (!Number.isFinite(d) || d < 0) return null
  return d
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

// 현재 product 가 어느 stage 에 머물러 있는지: 가장 마지막으로 도달한 stage 다음.
function currentStage(r: CycleRow): { stage: StageKey; enteredAt: string | null } {
  let lastReached: StageKey = 'raw'
  let lastAt: string | null = null
  for (const s of STAGES) {
    const v = r[STAGE_COL[s.key]] as string | null
    if (v) {
      lastReached = s.key
      lastAt = v
    }
  }
  // first_order 도달 = 파이프라인 종료
  if (lastReached === 'first_order') return { stage: 'first_order', enteredAt: lastAt }
  // 그 외엔 그 다음 stage 가 WIP
  const idx = STAGES.findIndex((s) => s.key === lastReached)
  const next = STAGES[idx + 1]
  return { stage: next?.key ?? 'first_order', enteredAt: lastAt }
}

async function fetchCycle(): Promise<CycleRow[]> {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const { data, error } = await sb
    .from('jimscanner_pipeline_cycle_v')
    .select('product_id, canonical_name, category_top, raw_seen_at, classified_at, pinned_at, published_at, first_order_at')
    .limit(2000)
  if (error) {
    // 뷰 마이그레이션 미적용 — 빈 상태로 fallback
    return []
  }
  return (data ?? []) as unknown as CycleRow[]
}

export default async function PipelineCyclePage() {
  const rows = await fetchCycle()

  // ── 단계별 WIP + 체류시간 분포
  const now = Date.now()
  const wipByStage = new Map<StageKey, { ages: number[]; entered: { row: CycleRow; ageDays: number }[] }>()
  for (const s of STAGES) wipByStage.set(s.key, { ages: [], entered: [] })

  // ── 단계 전이 dwell time (직전 stage → 현 stage 까지 며칠)
  const dwellByStage = new Map<StageKey, number[]>()
  for (const s of STAGES) dwellByStage.set(s.key, [])

  for (const r of rows) {
    // dwell 시간: stage 도달한 경우, 직전 stage 와의 차이를 dwellByStage[stage] 에 push
    for (let i = 1; i < STAGES.length; i++) {
      const prev = r[STAGE_COL[STAGES[i - 1].key]] as string | null
      const cur = r[STAGE_COL[STAGES[i].key]] as string | null
      const d = daysBetween(prev, cur)
      if (d !== null) dwellByStage.get(STAGES[i].key)!.push(d)
    }
    // WIP: first_order 도달 안 한 product 만
    if (!r.first_order_at) {
      const { stage, enteredAt } = currentStage(r)
      if (stage === 'first_order') continue
      const bucket = wipByStage.get(stage)!
      const ageDays = enteredAt ? (now - new Date(enteredAt).getTime()) / DAY_MS : 0
      bucket.ages.push(ageDays)
      bucket.entered.push({ row: r, ageDays })
    }
  }

  // ── CFD: 최근 30일 일자별 누적 stage reach 수
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const days: string[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * DAY_MS)
    days.push(d.toISOString().slice(0, 10))
  }

  const cfd: Record<StageKey, number[]> = {
    raw: new Array(days.length).fill(0),
    classify: new Array(days.length).fill(0),
    pin: new Array(days.length).fill(0),
    publish: new Array(days.length).fill(0),
    first_order: new Array(days.length).fill(0),
  }
  for (let i = 0; i < days.length; i++) {
    const cutoff = new Date(days[i] + 'T23:59:59.999Z').getTime()
    for (const r of rows) {
      for (const s of STAGES) {
        const v = r[STAGE_COL[s.key]] as string | null
        if (v && new Date(v).getTime() <= cutoff) cfd[s.key][i]++
      }
    }
  }

  // ── Little's Law throughput: 최근 7일 first_order 도달 수 / 7
  const sevenAgo = now - 7 * DAY_MS
  const throughput7d =
    rows.filter((r) => r.first_order_at && new Date(r.first_order_at).getTime() >= sevenAgo).length / 7

  // ── 5일 이상 정체 백로그
  const stuckBacklog: { stage: StageKey; row: CycleRow; ageDays: number }[] = []
  for (const [stage, b] of wipByStage.entries()) {
    for (const e of b.entered) {
      if (e.ageDays >= 5) stuckBacklog.push({ stage, row: e.row, ageDays: e.ageDays })
    }
  }
  stuckBacklog.sort((a, b) => b.ageDays - a.ageDays)

  const empty = rows.length === 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">파이프라인 리드타임 분해 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            raw → classify → pin → publish → first_order. 어디서 며칠 잠기는지 측정 · Little's Law 로 적정 처리량 역산.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {empty ? (
        <EmptyState />
      ) : (
        <>
          {/* 1) 단계별 WIP + 체류시간 (P50/P95) */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">① 단계별 WIP · 체류시간</h2>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              {STAGES.map((s) => {
                const b = wipByStage.get(s.key)!
                const dwell = [...(dwellByStage.get(s.key) ?? [])].sort((x, y) => x - y)
                const p50 = percentile(dwell, 50)
                const p95 = percentile(dwell, 95)
                return (
                  <div key={s.key} className="rounded border border-gray-200 p-4">
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: s.color }} />
                      {s.label}
                    </div>
                    <div className="text-3xl font-bold mt-1">{b.entered.length}</div>
                    <div className="text-xs text-gray-400 mt-1">현재 WIP</div>
                    <div className="text-xs text-gray-500 mt-2 font-mono">
                      P50 {p50.toFixed(1)}d · P95 {p95.toFixed(1)}d
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              최근 7일 처리량 (first_order/day): <b className="font-mono">{throughput7d.toFixed(2)}</b>
              {' · '}
              Little's Law 추정 리드타임 ≈{' '}
              <b className="font-mono">
                {throughput7d > 0 ? (rows.filter((r) => !r.first_order_at).length / throughput7d).toFixed(1) : '∞'}
              </b>
              일
            </div>
          </section>

          {/* 2) 일자별 CFD */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">② 일자별 CFD (30일 누적)</h2>
            <CFDChart days={days} cfd={cfd} />
          </section>

          {/* 3) WIP age 분포 */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">③ WIP age 분포 (단계별)</h2>
            <div className="space-y-2">
              {STAGES.filter((s) => s.key !== 'first_order').map((s) => {
                const ages = [...(wipByStage.get(s.key)?.ages ?? [])].sort((a, b) => a - b)
                if (ages.length === 0) {
                  return (
                    <div key={s.key} className="grid grid-cols-12 text-xs items-center">
                      <div className="col-span-2 text-gray-500">{s.label}</div>
                      <div className="col-span-10 text-gray-400">WIP 없음</div>
                    </div>
                  )
                }
                const min = ages[0]
                const p50 = percentile(ages, 50)
                const p95 = percentile(ages, 95)
                const max = ages[ages.length - 1]
                return (
                  <div key={s.key} className="grid grid-cols-12 text-xs items-center gap-2">
                    <div className="col-span-2 text-gray-700">{s.label}</div>
                    <div className="col-span-8">
                      <BoxPlot min={min} p50={p50} p95={p95} max={max} color={s.color} />
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-500">
                      {min.toFixed(1)}/{p50.toFixed(1)}/{p95.toFixed(1)}/{max.toFixed(1)}d
                    </div>
                  </div>
                )
              })}
              <div className="text-xs text-gray-400 mt-1">min / P50 / P95 / max (일)</div>
            </div>
          </section>

          {/* 4) 5일 이상 정체 백로그 */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              ④ 5일 이상 정체 백로그 <span className="text-xs text-gray-500">({stuckBacklog.length}건)</span>
            </h2>
            {stuckBacklog.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
                5일 이상 잠긴 항목 없음 — 파이프라인 흐름 양호.
              </div>
            ) : (
              <div className="rounded border border-gray-200 divide-y divide-gray-100">
                <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 bg-gray-50">
                  <div className="col-span-1">단계</div>
                  <div className="col-span-6">상품</div>
                  <div className="col-span-2">카테고리</div>
                  <div className="col-span-1 text-right">정체일</div>
                  <div className="col-span-2 text-right">바로가기</div>
                </div>
                {stuckBacklog.slice(0, 50).map((b) => {
                  const stage = STAGES.find((s) => s.key === b.stage)!
                  return (
                    <div key={b.row.product_id} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
                      <div className="col-span-1">
                        <span
                          className="inline-block px-2 py-0.5 rounded text-xs text-white"
                          style={{ background: stage.color }}
                        >
                          {stage.label}
                        </span>
                      </div>
                      <div className="col-span-6 truncate">{b.row.canonical_name ?? b.row.product_id}</div>
                      <div className="col-span-2 text-xs text-gray-500">{b.row.category_top ?? '-'}</div>
                      <div className="col-span-1 text-right font-mono font-bold text-rose-600">
                        {b.ageDays.toFixed(1)}d
                      </div>
                      <div className="col-span-2 text-right">
                        <Link
                          href={jumpUrl(b.stage, b.row)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {jumpLabel(b.stage)} →
                        </Link>
                      </div>
                    </div>
                  )
                })}
                {stuckBacklog.length > 50 && (
                  <div className="px-3 py-2 text-xs text-gray-500 text-center">
                    +{stuckBacklog.length - 50}건 더 (상위 50건만 표시)
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 5) 슬랙 알림 토글 (placeholder) */}
          <SlackToggle stuckCount={stuckBacklog.length} />
        </>
      )}
    </div>
  )
}

function jumpUrl(stage: StageKey, row: CycleRow): string {
  switch (stage) {
    case 'classify':
      return `/admin/trend-radar/products/${row.product_id}`
    case 'pin':
      return `/admin/trend-radar/pins`
    case 'publish':
      return `/admin/coupang-publish?q=${encodeURIComponent(row.canonical_name ?? '')}`
    case 'first_order':
      return `/admin/coupang-orders?q=${encodeURIComponent(row.canonical_name ?? '')}`
    default:
      return `/admin/trend-radar`
  }
}

function jumpLabel(stage: StageKey): string {
  switch (stage) {
    case 'classify': return '분류'
    case 'pin': return '핀'
    case 'publish': return '발행'
    case 'first_order': return '주문'
    default: return '대시보드'
  }
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
      <p className="text-base font-medium">파이프라인 cycle 데이터 없음</p>
      <p className="text-sm">
        <code className="px-1 bg-gray-100 rounded">supabase/pipeline_cycle_time.sql</code> 적용 후
        <br />
        jimscanner_pipeline_cycle_v 가 채워지면 자동으로 보드가 그려집니다.
      </p>
    </div>
  )
}

// ───────────── 차트 컴포넌트 (의존성 없이 SVG 로) ─────────────

function CFDChart({ days, cfd }: { days: string[]; cfd: Record<StageKey, number[]> }) {
  const W = 800
  const H = 220
  const PAD_L = 36
  const PAD_R = 12
  const PAD_T = 8
  const PAD_B = 28

  // 누적 max: stage 별 값은 raw>=classify>=pin>=publish>=first_order 라고 가정 (CFD 정의)
  let maxY = 0
  for (let i = 0; i < days.length; i++) {
    const top = cfd.raw[i] // raw 가 가장 위
    if (top > maxY) maxY = top
  }
  if (maxY === 0) maxY = 1

  const xScale = (i: number) => PAD_L + (i / Math.max(1, days.length - 1)) * (W - PAD_L - PAD_R)
  const yScale = (v: number) => PAD_T + (1 - v / maxY) * (H - PAD_T - PAD_B)

  // 각 stage line area: stage 위쪽 line + 아래쪽 line(=다음 stage line). 가장 안쪽 = first_order.
  // 순서: raw(top) → classify → pin → publish → first_order(bottom)
  const orderedStages: StageKey[] = ['first_order', 'publish', 'pin', 'classify', 'raw']
  // 가장 안쪽부터 그려야 위쪽 stage 영역이 그 차이만큼 보임

  const areas = orderedStages.map((sk) => {
    const arr = cfd[sk]
    const top = arr.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ')
    const bottom = `${xScale(days.length - 1)},${yScale(0)} ${xScale(0)},${yScale(0)}`
    const stage = STAGES.find((s) => s.key === sk)!
    return { d: `${top} ${bottom}`, color: stage.color, key: sk, label: stage.label }
  })

  return (
    <div className="rounded border border-gray-200 p-3 bg-white">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="xMinYMin meet">
        {/* y axis ticks */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = PAD_T + (1 - t) * (H - PAD_T - PAD_B)
          return (
            <g key={t}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="#e5e7eb" strokeWidth={1} />
              <text x={PAD_L - 4} y={y + 3} fontSize={9} fill="#9ca3af" textAnchor="end">
                {Math.round(maxY * t)}
              </text>
            </g>
          )
        })}
        {/* areas (안쪽부터 큰 영역으로 stack) — 큰 다각형이 작은 다각형을 덮음 → 역순으로 그려야 */}
        {[...areas].reverse().map((a) => (
          <polygon key={a.key} points={a.d} fill={a.color} opacity={0.85} />
        ))}
        {/* x axis labels (every ~5th day) */}
        {days.map((d, i) =>
          i % 5 === 0 || i === days.length - 1 ? (
            <text key={d} x={xScale(i)} y={H - 8} fontSize={9} fill="#6b7280" textAnchor="middle">
              {d.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      {/* 범례 */}
      <div className="flex flex-wrap gap-3 mt-2 text-xs text-gray-600">
        {STAGES.map((s) => (
          <div key={s.key} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  )
}

function BoxPlot({
  min,
  p50,
  p95,
  max,
  color,
}: {
  min: number
  p50: number
  p95: number
  max: number
  color: string
}) {
  const W = 400
  const H = 20
  const lo = 0
  const hi = Math.max(max, 1)
  const x = (v: number) => ((v - lo) / (hi - lo)) * W
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-5">
      <line x1={x(min)} x2={x(max)} y1={H / 2} y2={H / 2} stroke="#9ca3af" strokeWidth={1} />
      <rect
        x={x(p50)}
        y={H / 2 - 5}
        width={Math.max(2, x(p95) - x(p50))}
        height={10}
        fill={color}
        opacity={0.6}
      />
      <line x1={x(p50)} x2={x(p50)} y1={H / 2 - 6} y2={H / 2 + 6} stroke="#111" strokeWidth={1.5} />
    </svg>
  )
}

function SlackToggle({ stuckCount }: { stuckCount: number }) {
  // server component — 실제 토글은 후속 PR. UI 만 stub.
  return (
    <section className="rounded border border-gray-200 bg-amber-50/40 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">슬랙 알림</div>
          <div className="text-xs text-gray-600 mt-0.5">
            5일 이상 정체 단계 발견 시 #ops-pipeline 채널에 토픽 알림
            {stuckCount > 0 && (
              <span className="ml-2 text-rose-600 font-semibold">· 현재 {stuckCount}건 정체</span>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-500">
          토글 설정: <code className="px-1 bg-white rounded border">SLACK_PIPELINE_WEBHOOK</code> env
        </div>
      </div>
    </section>
  )
}
