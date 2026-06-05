import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import MomentumBoard, { type MomentumRow } from './MomentumBoard'

export const dynamic = 'force-dynamic'

// 한 product 당 최근 N 스냅샷만 시계열로 사용
const WINDOW = 6
// 모멘텀 계산에 최소 필요한 스냅샷 수 (속도=1차차분, 가속=2차차분)
const MIN_POINTS = 3

interface ScoreSnapshot {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

type AxisKey = 'trend' | 'commerce' | 'supplier' | 'competition'
const AXES: AxisKey[] = ['trend', 'commerce', 'supplier', 'competition']

// 단순 1차차분의 평균 = 최근 평균 기울기(속도)
function velocity(series: number[]): number {
  if (series.length < 2) return 0
  let sum = 0
  for (let i = 1; i < series.length; i++) sum += series[i] - series[i - 1]
  return sum / (series.length - 1)
}

// 기울기 변화(가속도) = 마지막 기울기 − 그 이전 기울기
function acceleration(series: number[]): number {
  const n = series.length
  if (n < 3) return 0
  const last = series[n - 1] - series[n - 2]
  const prev = series[n - 2] - series[n - 3]
  return last - prev
}

async function fetchData(): Promise<{ rows: MomentumRow[]; window: number }> {
  const sb = createAdminClient()

  // 마이그레이션 없이 기존 시계열 그대로 사용. 넉넉히 가져와 product 별로 묶는다.
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(8000)

  // product_id → 최근→과거 순 스냅샷 (최대 WINDOW 개)
  const byProduct = new Map<string, ScoreSnapshot[]>()
  for (const s of (scores ?? []) as ScoreSnapshot[]) {
    const arr = byProduct.get(s.product_id) ?? []
    if (arr.length < WINDOW) {
      arr.push(s)
      byProduct.set(s.product_id, arr)
    }
  }

  const ids = [...byProduct.keys()]
  if (ids.length === 0) return { rows: [], window: WINDOW }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const rows: MomentumRow[] = []
  for (const [pid, snapsDesc] of byProduct.entries()) {
    if (snapsDesc.length < MIN_POINTS) continue
    // 시간 오름차순으로 뒤집어 시계열 구성
    const snaps = [...snapsDesc].reverse()

    const finalSeries = snaps.map((s) => Number(s.final_score))
    const axisSeries: Record<AxisKey, number[]> = {
      trend: snaps.map((s) => Number(s.trend_score)),
      commerce: snaps.map((s) => Number(s.commerce_score)),
      supplier: snaps.map((s) => Number(s.supplier_score)),
      competition: snaps.map((s) => Number(s.competition_score)),
    }

    const finalNow = finalSeries[finalSeries.length - 1]
    const finalVel = velocity(finalSeries)
    const finalAcc = acceleration(finalSeries)

    const axisDelta = {} as Record<AxisKey, { now: number; vel: number; acc: number }>
    for (const ax of AXES) {
      const ser = axisSeries[ax]
      axisDelta[ax] = {
        now: ser[ser.length - 1],
        vel: velocity(ser),
        acc: acceleration(ser),
      }
    }

    // 가속상승 점수: 빠르게 오르고(속도) + 가속하며(가속) + 아직 절대값 낮을수록 선점가치 ↑
    // headroom = (100 - 현재점수)/100 → 고점일수록 0 에 수렴해 후행지표 강등
    const headroom = Math.max(0, (100 - finalNow) / 100)
    const momentum = finalVel * 1.5 + finalAcc * 1.0
    const rising = momentum * (0.5 + 0.5 * headroom)

    const p = byId.get(pid) ?? {}
    rows.push({
      id: pid,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      points: snaps.length,
      finalNow,
      finalVel: round1(finalVel),
      finalAcc: round1(finalAcc),
      rising: round1(rising),
      sparkline: finalSeries.map((v) => round1(v)),
      axes: {
        trend: packAxis(axisDelta.trend),
        commerce: packAxis(axisDelta.commerce),
        supplier: packAxis(axisDelta.supplier),
        competition: packAxis(axisDelta.competition),
      },
    })
  }

  return { rows, window: WINDOW }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function packAxis(a: { now: number; vel: number; acc: number }) {
  return { now: round1(a.now), vel: round1(a.vel), acc: round1(a.acc) }
}

export default async function MomentumPage() {
  const { rows, window } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Momentum Board</h1>
          <p className="mt-1 text-sm text-gray-500">
            점수의 <b>방향</b>을 본다 — 최근 {window}회 스냅샷의 속도(1차차분)·가속도(2차차분).
            절대점수는 후행지표라, 아직 낮지만 <b>가속 상승</b>하는 후보를 위로 올려 정점 전 선점.
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 underline hover:text-black">
          Opportunity →
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          시계열이 아직 부족합니다 (product 당 최소 {MIN_POINTS}회 스냅샷 필요). recompute_scores cron 누적 후 다시 방문.
        </div>
      ) : (
        <MomentumBoard rows={rows} />
      )}
    </div>
  )
}
