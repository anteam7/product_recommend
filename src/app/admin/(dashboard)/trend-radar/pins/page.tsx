import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PinHealthRow, { type PinHealth } from './PinHealthRow'

export const dynamic = 'force-dynamic'

const DAYS_WINDOW = 30

async function fetchData(): Promise<{ rows: PinHealth[]; err: string | null }> {
  const sb = createAdminClient()

  // RPC jimscanner_pin_portfolio_health: trends_pins_v2.sql 적용 후 가용.
  // 미적용 환경에서도 페이지가 죽지 않도록 fallback 으로 빈 핀 목록 폴백.
  const { data, error } = await sb.rpc(
    'jimscanner_pin_portfolio_health' as never,
    { days_window: DAYS_WINDOW } as never,
  )

  if (error) {
    return { rows: [], err: error.message }
  }
  return { rows: ((data as unknown) as PinHealth[]) ?? [], err: null }
}

function aggregateKPI(rows: PinHealth[]) {
  const live = rows.filter((r) => r.status === 'live')
  const exitWin = rows.filter((r) => r.status === 'exit_win').length
  const exitLoss = rows.filter((r) => r.status === 'exit_loss').length
  const exitDead = rows.filter((r) => r.status === 'exit_dead').length

  const risk = live.filter((r) => (r.delta_final ?? 0) <= -15 || r.signal_alive === false).length
  const rising = live.filter((r) => (r.delta_final ?? 0) >= 5).length

  const deltas = live
    .map((r) => r.delta_final)
    .filter((v): v is number => v !== null && v !== undefined && !Number.isNaN(v))
  const avgDelta = deltas.length === 0 ? null : deltas.reduce((a, b) => a + b, 0) / deltas.length

  return {
    total: rows.length,
    liveCount: live.length,
    riskCount: risk,
    risingCount: rising,
    avgDelta,
    exitWin,
    exitLoss,
    exitDead,
  }
}

function KPI({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const toneCls =
    tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : 'text-gray-900'
  return (
    <div className="rounded border border-gray-200 px-4 py-3">
      <div className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>}
    </div>
  )
}

export default async function PinsPage() {
  const { rows, err } = await fetchData()
  const kpi = aggregateKPI(rows)

  const live = rows.filter((r) => r.status === 'live')
  const exited = rows.filter((r) => r.status !== 'live')

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀 포트폴리오 헬스보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            진입 후 Δscore 추적. 운영자가 익절·손절·사망 마킹 시 #15 백테스트 학습 피드로 자동 흘러감.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {err && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          RPC 미적용 또는 호출 실패: <span className="font-mono">{err}</span>
          <br />
          <span>
            supabase/trends_pins_v2.sql 적용 후 새로고침하세요.
          </span>
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KPI label="살아있는 핀" value={String(kpi.liveCount)} hint={`전체 ${kpi.total}`} />
        <KPI
          label="위험 핀"
          value={String(kpi.riskCount)}
          hint="Δ<-15 or 시그널 끊김"
          tone={kpi.riskCount > 0 ? 'bad' : 'neutral'}
        />
        <KPI
          label="평균 Δfinal"
          value={kpi.avgDelta === null ? '–' : (kpi.avgDelta >= 0 ? '+' : '') + kpi.avgDelta.toFixed(1)}
          hint="live 핀 기준"
          tone={kpi.avgDelta === null ? 'neutral' : kpi.avgDelta >= 0 ? 'good' : 'bad'}
        />
        <KPI
          label="누적 익절 / 손절"
          value={`${kpi.exitWin} / ${kpi.exitLoss}`}
          hint={`사망 ${kpi.exitDead}`}
        />
        <KPI label="상승 핀" value={String(kpi.risingCount)} hint="Δ≥+5" tone={kpi.risingCount > 0 ? 'good' : 'neutral'} />
      </div>

      {/* live pins */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">추적 중 ({live.length})</h2>
        {live.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-10 text-center text-gray-500">
            <p className="text-sm">추적 중인 핀 없음. 트렌드 레이더에서 핀하세요.</p>
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {live.map((r) => (
              <PinHealthRow key={`${r.source}::${r.keyword}`} row={r} />
            ))}
          </div>
        )}
      </section>

      {/* exited pins (백테스트 ground truth) */}
      {exited.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">사후 결과 ({exited.length})</h2>
          <div className="rounded border border-gray-200 divide-y divide-gray-100 opacity-80">
            {exited.map((r) => (
              <PinHealthRow key={`${r.source}::${r.keyword}`} row={r} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
