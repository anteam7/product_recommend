import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RankBumpChart from './RankBumpChart'

export const dynamic = 'force-dynamic'

const TOP_N = 30
const WINDOW_DAYS = 30

interface RawScore {
  product_id: string
  final_score: number
  computed_at: string
}

// KST(UTC+9) 기준 YYYY-MM-DD
function kstDate(iso: string): string {
  const t = new Date(iso).getTime() + 9 * 3600_000
  return new Date(t).toISOString().slice(0, 10)
}

export interface TrajectoryPoint {
  day: string
  rank: number
  score: number
}
export interface ProductTrajectory {
  id: string
  name: string
  category: string
  points: TrajectoryPoint[]
  latestRank: number | null
  prevRank: number | null
  // 7일 전 대비 ΔRank (양수 = 순위 상승)
  deltaRank7: number | null
}

export interface CrossoverEvent {
  day: string
  aId: string
  aName: string
  bId: string
  bName: string
  // 역전 후 위에 올라선 상품 id
  winnerId: string
}

interface PageData {
  days: string[]
  trajectories: ProductTrajectory[]
  entrants: ProductTrajectory[]
  dropouts: ProductTrajectory[]
  risers: ProductTrajectory[]
  fallers: ProductTrajectory[]
  crossovers: CrossoverEvent[]
  hasData: boolean
}

async function fetchData(): Promise<PageData> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString()

  const { data: rawScores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: true })
    .limit(20000)

  const scores = (rawScores ?? []) as RawScore[]
  if (scores.length === 0) {
    return { days: [], trajectories: [], entrants: [], dropouts: [], risers: [], fallers: [], crossovers: [], hasData: false }
  }

  // day → product_id → 그날 마지막 점수
  const byDay = new Map<string, Map<string, number>>()
  for (const s of scores) {
    const d = kstDate(s.computed_at)
    let m = byDay.get(d)
    if (!m) { m = new Map(); byDay.set(d, m) }
    m.set(s.product_id, s.final_score) // asc 정렬이라 마지막이 그날 최신
  }

  const days = [...byDay.keys()].sort()

  // day → product_id → rank (1 = 최고점)
  const rankByDay = new Map<string, Map<string, number>>()
  const scoreByDay = new Map<string, Map<string, number>>()
  for (const d of days) {
    const m = byDay.get(d)!
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
    const rm = new Map<string, number>()
    const sm = new Map<string, number>()
    sorted.forEach(([pid, sc], i) => { rm.set(pid, i + 1); sm.set(pid, sc) })
    rankByDay.set(d, rm)
    scoreByDay.set(d, sm)
  }

  // 등장한 모든 product_id
  const allIds = new Set<string>()
  for (const m of byDay.values()) for (const pid of m.keys()) allIds.add(pid)

  // 상품명 조회
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', [...allIds])
  const byId = new Map((prods ?? []).map((p: any) => [p.id as string, p]))

  const today = days[days.length - 1]
  const yesterday = days.length >= 2 ? days[days.length - 2] : null
  // 7일(또는 가능한 만큼) 전 기준일
  const ago7 = days[Math.max(0, days.length - 8)]

  const trajectories: ProductTrajectory[] = [...allIds].map((id) => {
    const p = byId.get(id) ?? {}
    const points: TrajectoryPoint[] = []
    for (const d of days) {
      const r = rankByDay.get(d)!.get(id)
      if (r != null) points.push({ day: d, rank: r, score: scoreByDay.get(d)!.get(id) ?? 0 })
    }
    const latestRank = rankByDay.get(today)!.get(id) ?? null
    const prevRank = yesterday ? (rankByDay.get(yesterday)!.get(id) ?? null) : null
    const rankAgo7 = rankByDay.get(ago7)!.get(id) ?? null
    const deltaRank7 = latestRank != null && rankAgo7 != null ? rankAgo7 - latestRank : null
    return {
      id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      points,
      latestRank,
      prevRank,
      deltaRank7,
    }
  })

  const inTopToday = (t: ProductTrajectory) => t.latestRank != null && t.latestRank <= TOP_N
  const inTopPrev = (t: ProductTrajectory) => t.prevRank != null && t.prevRank <= TOP_N

  // 신규 진입: 오늘 Top-N 안 + 어제 Top-N 밖(또는 부재)
  const entrants = trajectories
    .filter((t) => inTopToday(t) && !inTopPrev(t))
    .sort((a, b) => (a.latestRank ?? 999) - (b.latestRank ?? 999))

  // 이탈: 어제 Top-N 안 + 오늘 밖(또는 부재)
  const dropouts = trajectories
    .filter((t) => inTopPrev(t) && !inTopToday(t))
    .sort((a, b) => (a.prevRank ?? 999) - (b.prevRank ?? 999))

  // 7일 ΔRank Risers / Fallers (양수 = 상승)
  const withDelta = trajectories.filter((t) => t.deltaRank7 != null && t.latestRank != null)
  const risers = [...withDelta].sort((a, b) => (b.deltaRank7 ?? 0) - (a.deltaRank7 ?? 0)).filter((t) => (t.deltaRank7 ?? 0) > 0).slice(0, 12)
  const fallers = [...withDelta].sort((a, b) => (a.deltaRank7 ?? 0) - (b.deltaRank7 ?? 0)).filter((t) => (t.deltaRank7 ?? 0) < 0).slice(0, 12)

  // Crossover: 어제↔오늘 Top-N 군에서 상대 순위가 뒤집힌 쌍
  const crossovers: CrossoverEvent[] = []
  if (yesterday) {
    const pool = trajectories.filter((t) => inTopToday(t) || inTopPrev(t))
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i], b = pool[j]
        if (a.prevRank == null || b.prevRank == null || a.latestRank == null || b.latestRank == null) continue
        const prevSign = Math.sign(a.prevRank - b.prevRank)
        const nowSign = Math.sign(a.latestRank - b.latestRank)
        if (prevSign !== 0 && nowSign !== 0 && prevSign !== nowSign) {
          // 오늘 더 위(작은 rank)인 쪽이 winner
          const winnerId = a.latestRank < b.latestRank ? a.id : b.id
          crossovers.push({ day: today, aId: a.id, aName: a.name, bId: b.id, bName: b.name, winnerId })
        }
      }
    }
  }
  // 역전 변화량 큰 순 (가까운 순위 변동만 너무 많지 않게 상위 20)
  crossovers.sort((x, y) => {
    const xa = trajectories.find((t) => t.id === x.winnerId)!
    const ya = trajectories.find((t) => t.id === y.winnerId)!
    return (xa.deltaRank7 ?? 0) < (ya.deltaRank7 ?? 0) ? 1 : -1
  })

  return {
    days,
    trajectories,
    entrants,
    dropouts,
    risers,
    fallers,
    crossovers: crossovers.slice(0, 20),
    hasData: true,
  }
}

export default async function RankTrajectoryPage() {
  const data = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">순위 궤적 (Rank Trajectory)</h1>
          <p className="text-sm text-gray-500 mt-1">
            절대 점수가 아닌 <b>상대 순위</b> — 점수가 정체여도 경쟁군이 떨어지면 순위는 오른다.
            Top-{TOP_N} 진입/이탈 · 역전 · 7일 ΔRank.
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          Opportunity →
        </Link>
      </header>

      {!data.hasData ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 점수 시계열이 없음. recompute cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          {/* 신규 진입 / 이탈 배지 */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <BadgeBox
              title={`🟢 신규 Top-${TOP_N} 진입`}
              empty="어제 대비 새로 진입한 상품 없음"
              items={data.entrants}
              rankKey="latestRank"
              accent="text-emerald-700"
            />
            <BadgeBox
              title={`🔴 Top-${TOP_N} 이탈`}
              empty="어제 대비 이탈한 상품 없음"
              items={data.dropouts}
              rankKey="prevRank"
              accent="text-red-700"
            />
          </section>

          {/* Bump chart */}
          <RankBumpChart days={data.days} trajectories={data.trajectories} topN={TOP_N} entrantIds={data.entrants.map((e) => e.id)} />

          {/* Risers / Fallers */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DeltaTable title="📈 Risers (7일 순위 상승)" items={data.risers} positive />
            <DeltaTable title="📉 Fallers (7일 순위 하락)" items={data.fallers} positive={false} />
          </section>

          {/* Crossover 타임라인 */}
          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              🔀 순위 역전 (Crossover) · 어제 → 오늘
            </h2>
            {data.crossovers.length === 0 ? (
              <div className="text-sm text-gray-400 py-4 text-center">최근 역전 이벤트 없음.</div>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.crossovers.map((c, i) => {
                  const winner = c.winnerId === c.aId ? c.aName : c.bName
                  const loser = c.winnerId === c.aId ? c.bName : c.aName
                  return (
                    <li key={i} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50">
                      <span className="text-xs font-mono text-gray-400">{c.day.slice(5)}</span>
                      <Link href={`/admin/trend-radar/products/${c.winnerId}`} className="font-medium hover:underline">{winner}</Link>
                      <span className="text-emerald-600 text-xs">▲ 추월</span>
                      <span className="text-gray-400">→</span>
                      <span className="text-gray-500">{loser}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function BadgeBox({
  title, items, rankKey, empty, accent,
}: {
  title: string
  items: ProductTrajectory[]
  rankKey: 'latestRank' | 'prevRank'
  empty: string
  accent: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <h2 className={`text-sm font-semibold mb-2 ${accent}`}>{title}</h2>
      {items.length === 0 ? (
        <div className="text-xs text-gray-400 py-3">{empty}</div>
      ) : (
        <div className="space-y-1">
          {items.slice(0, 10).map((t) => (
            <Link
              key={t.id}
              href={`/admin/trend-radar/products/${t.id}`}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-gray-50"
            >
              <span className="font-mono text-gray-500 w-8 text-right">#{t[rankKey]}</span>
              <span className="truncate flex-1">{t.name}</span>
              <span className="text-xs text-gray-400">{t.category}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function DeltaTable({ title, items, positive }: { title: string; items: ProductTrajectory[]; positive: boolean }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-2">{title}</h2>
      {items.length === 0 ? (
        <div className="text-xs text-gray-400 py-3">아직 해당 상품 없음.</div>
      ) : (
        <div className="space-y-1">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/admin/trend-radar/products/${t.id}`}
              className="flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-gray-50"
            >
              <span className={`font-mono w-10 text-right font-bold ${positive ? 'text-emerald-600' : 'text-red-600'}`}>
                {positive ? '+' : ''}{t.deltaRank7}
              </span>
              <span className="truncate flex-1">{t.name}</span>
              <span className="font-mono text-xs text-gray-400">#{t.latestRank}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
