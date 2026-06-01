import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 카테고리별 트렌드 생존곡선 — 소싱 깊이 캘리브레이터
// jimscanner_trends_survival_curve RPC (supabase/trends_v4_survival_curve.sql)
// 코호트(first_seen_at 주차)별 KM식 생존율 → 카테고리 median lifespan(중앙값 수명)
// 이 base-rate 로 MSP 수량단계·번들 깊이·재고 베팅을 감이 아닌 데이터로 보정.
// ─────────────────────────────────────────────────────────────

interface CurveRow {
  category_top: string
  week_offset: number
  at_risk: number
  survived: number
  survival_rate: number
}

const SCORE_OPTIONS = [
  { v: 40, label: '40 (느슨)' },
  { v: 50, label: '50 (기본)' },
  { v: 60, label: '60 (엄격)' },
] as const

const MAX_WEEKS = 16

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  health: { label: '건강식품', color: '#16a34a' },
  living: { label: '리빙·생활', color: '#d97706' },
  digital: { label: '디지털', color: '#2563eb' },
}

function catMeta(cat: string) {
  return CATEGORY_META[cat] ?? { label: cat, color: '#6b7280' }
}

async function fetchCurve(minScore: number) {
  const sb = createAdminClient()
  // RPC는 supabase/trends_v4_survival_curve.sql 에 존재하나 generated 타입 미반영 — gen:types 후 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_trends_survival_curve' as never, {
    min_score: minScore,
    max_weeks: MAX_WEEKS,
  } as never)
  if (error) return { rows: [] as CurveRow[], error: error.message }
  return { rows: (data ?? []) as CurveRow[], error: null as string | null }
}

interface CategoryStat {
  category: string
  cohortSize: number          // week_offset 0 의 at_risk (관측 가능 코호트 모수)
  medianLifespan: number | null   // survival_rate 가 0.5 이하로 처음 떨어지는 주차 (null = 관측창 내 미달)
  curve: CurveRow[]
}

function buildStats(rows: CurveRow[]): CategoryStat[] {
  const byCat = new Map<string, CurveRow[]>()
  for (const r of rows) {
    const list = byCat.get(r.category_top) ?? []
    list.push(r)
    byCat.set(r.category_top, list)
  }

  const stats: CategoryStat[] = []
  for (const [category, curveRaw] of byCat) {
    const curve = [...curveRaw].sort((a, b) => a.week_offset - b.week_offset)
    const cohortSize = curve.find((c) => c.week_offset === 0)?.at_risk ?? 0
    let medianLifespan: number | null = null
    for (const c of curve) {
      if (Number(c.survival_rate) <= 0.5) {
        medianLifespan = c.week_offset
        break
      }
    }
    stats.push({ category, cohortSize, medianLifespan, curve })
  }
  // 코호트 큰 순
  stats.sort((a, b) => b.cohortSize - a.cohortSize)
  return stats
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/survival' + (qs ? `?${qs}` : '')
}

export default async function SurvivalPage({
  searchParams,
}: {
  searchParams: Promise<{ score?: string }>
}) {
  const sp = await searchParams
  const score = parseInt(sp.score ?? '50', 10)
  const minScore = SCORE_OPTIONS.some((s) => s.v === score) ? score : 50
  const current: Record<string, string> = { score: String(minScore) }

  const { rows, error } = await fetchCurve(minScore)
  const stats = buildStats(rows)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📉 트렌드 생존곡선</h1>
          <p className="text-sm text-gray-500 mt-1">
            발굴 상품 코호트(주차)별 생존율 · 카테고리 <strong>중앙값 수명</strong> = 소싱 깊이·재고 베팅 base-rate
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 임계 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">활성 임계 final_score ≥</span>
        {SCORE_OPTIONS.map((s) => (
          <Link
            key={s.v}
            href={buildHref(current, { score: String(s.v) })}
            className={`px-2 py-1 text-xs rounded ${
              minScore === s.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            {s.label}
          </Link>
        ))}
        <span className="text-[11px] text-gray-400">
          (해당 주차에 final_score 가 임계 이상인 score row 가 1개라도 있으면 그 주에 &apos;살아있음&apos;)
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_survival_curve</code> 가 DB에 적용 안 됐을 가능성.
            supabase/trends_v4_survival_curve.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && stats.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 코호트 데이터 없음</div>
          <div className="text-xs text-gray-400">
            jimscanner_trends_scores 시계열이 1주 이상 누적되어야 곡선이 그려짐. recompute_scores cron 누적 후 재방문.
          </div>
        </div>
      ) : (
        <>
          {/* 카테고리별 잔존수명 배지 카드 */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {stats.map((s) => {
              const m = catMeta(s.category)
              return (
                <div key={s.category} className="rounded border border-gray-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: m.color }} />
                    <span className="text-xs font-medium text-gray-700">{m.label}</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold" style={{ color: m.color }}>
                    {s.medianLifespan != null ? `${s.medianLifespan}주` : `> ${MAX_WEEKS}주`}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">기대 잔존수명 (중앙값)</div>
                  <div className="text-[11px] text-gray-400 mt-1">코호트 {s.cohortSize.toLocaleString()}개</div>
                </div>
              )
            })}
          </section>

          {/* 생존곡선 차트 */}
          <SurvivalChart stats={stats} />

          {/* 소싱 가이드 */}
          <section className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900 space-y-1">
            <div className="font-semibold">🧭 소싱 깊이 해석 가이드</div>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>중앙값 수명 <strong>≤ 3주</strong> → 단발 트렌드. MSP 1개 단계 위주, 번들 얕게, 재고 최소 베팅.</li>
              <li>중앙값 수명 <strong>4~7주</strong> → 중기. MSP 2개 단계 허용, 번들 중간 깊이.</li>
              <li>중앙값 수명 <strong>≥ 8주</strong> → 지속 수요. MSP 3개 단계·번들 깊게·재고 적극 베팅 검토.</li>
            </ul>
          </section>

          {/* 데이터 표 */}
          <section className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-3">카테고리</th>
                  {Array.from({ length: MAX_WEEKS + 1 }, (_, i) => (
                    <th key={i} className="py-2 px-1 text-center font-mono">{i}w</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => {
                  const byOffset = new Map(s.curve.map((c) => [c.week_offset, c]))
                  const m = catMeta(s.category)
                  return (
                    <tr key={s.category} className="border-b border-gray-100">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: m.color }} />
                        {m.label}
                      </td>
                      {Array.from({ length: MAX_WEEKS + 1 }, (_, i) => {
                        const c = byOffset.get(i)
                        if (!c) return <td key={i} className="py-2 px-1 text-center text-gray-300">·</td>
                        const pct = Math.round(Number(c.survival_rate) * 100)
                        return (
                          <td
                            key={i}
                            className="py-2 px-1 text-center font-mono"
                            title={`offset ${i}주 · 생존 ${c.survived}/${c.at_risk}`}
                            style={{ color: pct <= 50 ? '#9ca3af' : m.color }}
                          >
                            {pct}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-400 mt-2">
              값 = 생존율(%) · 우측 절단(아직 t주를 관측 못 한 최근 코호트)은 분모에서 제외해 보정. 50% 이하는 회색.
            </p>
          </section>
        </>
      )}
    </div>
  )
}

// 인라인 SVG 생존곡선 (의존성 없음)
function SurvivalChart({ stats }: { stats: CategoryStat[] }) {
  const W = 720
  const H = 280
  const padL = 40
  const padR = 16
  const padT = 16
  const padB = 32
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const xFor = (offset: number) => padL + (offset / MAX_WEEKS) * plotW
  const yFor = (rate: number) => padT + (1 - rate) * plotH

  return (
    <div className="rounded border border-gray-200 p-4 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 480 }}>
        {/* y 그리드 */}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line
              x1={padL}
              y1={yFor(g)}
              x2={W - padR}
              y2={yFor(g)}
              stroke={g === 0.5 ? '#d1d5db' : '#f3f4f6'}
              strokeWidth={1}
              strokeDasharray={g === 0.5 ? '4 3' : undefined}
            />
            <text x={padL - 6} y={yFor(g) + 3} textAnchor="end" fontSize={9} fill="#9ca3af">
              {Math.round(g * 100)}%
            </text>
          </g>
        ))}
        {/* x 라벨 */}
        {Array.from({ length: MAX_WEEKS + 1 }, (_, i) => i).filter((i) => i % 2 === 0).map((i) => (
          <text key={i} x={xFor(i)} y={H - padB + 14} textAnchor="middle" fontSize={9} fill="#9ca3af">
            {i}w
          </text>
        ))}
        {/* 곡선 (step) */}
        {stats.map((s) => {
          const m = catMeta(s.category)
          const pts = [...s.curve].sort((a, b) => a.week_offset - b.week_offset)
          if (pts.length === 0) return null
          let d = ''
          pts.forEach((p, idx) => {
            const x = xFor(p.week_offset)
            const y = yFor(Number(p.survival_rate))
            if (idx === 0) {
              d += `M ${x} ${y}`
            } else {
              const prevY = yFor(Number(pts[idx - 1].survival_rate))
              d += ` L ${x} ${prevY} L ${x} ${y}`
            }
          })
          return (
            <g key={s.category}>
              <path d={d} fill="none" stroke={m.color} strokeWidth={2} />
              {pts.map((p) => (
                <circle
                  key={p.week_offset}
                  cx={xFor(p.week_offset)}
                  cy={yFor(Number(p.survival_rate))}
                  r={2}
                  fill={m.color}
                />
              ))}
            </g>
          )
        })}
      </svg>
      {/* 범례 */}
      <div className="flex flex-wrap gap-3 mt-2">
        {stats.map((s) => {
          const m = catMeta(s.category)
          return (
            <div key={s.category} className="flex items-center gap-1.5 text-xs text-gray-600">
              <span className="inline-block w-3 h-0.5" style={{ backgroundColor: m.color }} />
              {m.label}
              {s.medianLifespan != null && (
                <span className="text-gray-400">(중앙값 {s.medianLifespan}주)</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
