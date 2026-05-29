import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 발굴 병목 진단 — Score Gap Closer & 다음수(Next-Best-Action) 큐
//
// final_score = trend×0.30 + commerce×0.30 + supplier×0.20 + competition×0.20
//   (docs/trend-radar-v4-execution-plan.md §5.5)
//
// 진입 임계(THRESHOLD) 바로 아래 '아깝게 탈락한' 경계 상품만 골라,
// final 을 임계 위로 올리는 데 가장 효율적인 '구속 하위점수(binding
// constraint)' 1개를 marginal-lift = weight × (100 − subscore) 로 산출하고
// 액션 템플릿에 매핑한다. 상단 Pareto = 전체 near-miss 의 구속요인 분포.
// ─────────────────────────────────────────────────────────────

const WEIGHTS = {
  trend: 0.3,
  commerce: 0.3,
  supplier: 0.2,
  competition: 0.2,
} as const

type Dim = keyof typeof WEIGHTS

const DEFAULT_THRESHOLD = 75
const DEFAULT_BAND = 12 // [threshold − band, threshold) 구간만 near-miss

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

// 구속요인 → 액션 템플릿
const ACTION: Record<
  Dim,
  { label: string; action: string; href: string | null; tone: string }
> = {
  supplier: {
    label: '공급(supplier)',
    action: '더 싼 도매처 재탐색 — ggsan 매칭 재실행',
    href: '/admin/trend-radar/recommend',
    tone: 'bg-emerald-100 text-emerald-800',
  },
  competition: {
    label: '경쟁(competition)',
    action: '관망 / 리프라이싱 대기 — 경쟁 완화 시 재진입',
    href: '/admin/trend-radar/opportunity',
    tone: 'bg-sky-100 text-sky-800',
  },
  commerce: {
    label: '상업성(commerce)',
    action: '가격대 재포지셔닝 — 마진·구매의도 재설계',
    href: null,
    tone: 'bg-amber-100 text-amber-800',
  },
  trend: {
    label: '트렌드(trend)',
    action: '재수집 대기 — 시그널 누적 필요',
    href: '/admin/trend-radar/sources',
    tone: 'bg-violet-100 text-violet-800',
  },
}

const DIMS: Dim[] = ['trend', 'commerce', 'supplier', 'competition']

interface NearMiss {
  id: string
  name: string
  category: string
  final: number
  gap: number // threshold − final  (필요한 +Δ)
  scores: Record<Dim, number>
  binding: Dim
  marginalLift: number // weight × (100 − subscore)
  reachableFinal: number // 구속요인을 100 으로 올렸을 때 도달 가능한 final
  recoverable: boolean // 단일 레버만으로 임계 도달 가능?
}

async function fetchNearMiss(threshold: number, band: number) {
  const sb = createAdminClient()

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  // product_id 별 latest 1건
  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  // near-miss 구간: [threshold − band, threshold)
  const lo = threshold - band
  const bandRows = latest.filter(
    (s) => Number(s.final_score) >= lo && Number(s.final_score) < threshold,
  )

  const ids = bandRows.map((s) => s.product_id)
  const byId = new Map<string, { canonical_name: string; category_top: string }>()
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', ids)
    for (const p of (prods ?? []) as any[]) {
      byId.set(p.id, { canonical_name: p.canonical_name, category_top: p.category_top })
    }
  }

  const rows: NearMiss[] = bandRows.map((s) => {
    const scoresByDim: Record<Dim, number> = {
      trend: Number(s.trend_score),
      commerce: Number(s.commerce_score),
      supplier: Number(s.supplier_score),
      competition: Number(s.competition_score),
    }
    // marginal-lift = weight × (개선여지 = 100 − subscore)
    // → 가장 큰 레버 1개가 binding constraint (가장 효율적인 회수 지점)
    let binding: Dim = 'trend'
    let best = -1
    for (const d of DIMS) {
      const lift = WEIGHTS[d] * (100 - scoresByDim[d])
      if (lift > best) {
        best = lift
        binding = d
      }
    }
    const final = Number(s.final_score)
    const p = byId.get(s.product_id)
    const reachableFinal = Math.min(100, final + best)
    return {
      id: s.product_id,
      name: p?.canonical_name ?? '?',
      category: p?.category_top ?? 'all',
      final,
      gap: threshold - final,
      scores: scoresByDim,
      binding,
      marginalLift: best,
      reachableFinal,
      recoverable: reachableFinal >= threshold,
    }
  })

  // 회수 우선순위: 단일 레버로 살릴 수 있고(gap 대비 lift 큼), gap 작은 순
  rows.sort((a, b) => {
    if (a.recoverable !== b.recoverable) return a.recoverable ? -1 : 1
    return a.gap - b.gap
  })

  return { rows, total: latest.length }
}

export default async function GapCloserPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; band?: string }>
}) {
  const sp = await searchParams
  const threshold = clamp(parseInt(sp.t ?? '', 10) || DEFAULT_THRESHOLD, 40, 95)
  const band = clamp(parseInt(sp.band ?? '', 10) || DEFAULT_BAND, 4, 30)

  const { rows, total } = await fetchNearMiss(threshold, band)

  // Pareto: 구속요인별 분포
  const counts: Record<Dim, number> = { trend: 0, commerce: 0, supplier: 0, competition: 0 }
  for (const r of rows) counts[r.binding]++
  const pareto = DIMS.map((d) => ({ dim: d, count: counts[d] }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
  const nearTotal = rows.length || 1
  let cum = 0
  const paretoCum = pareto.map((x) => {
    cum += x.count
    return { ...x, pct: x.count / nearTotal, cumPct: cum / nearTotal }
  })
  const topBottleneck = paretoCum[0]

  const recoverableCount = rows.filter((r) => r.recoverable).length

  const BANDS = [8, 12, 16, 20]
  const THRESHOLDS = [70, 75, 80]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 Gap Closer — 발굴 병목 진단</h1>
          <p className="text-sm text-gray-500 mt-1">
            진입 임계 바로 아래 &apos;아깝게 탈락한&apos; 경계 상품만 골라, 어디를 손보면 가장
            효율적으로 살아나는지(binding constraint)와 다음수를 제시.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">진입 임계</span>
          {THRESHOLDS.map((t) => (
            <Link
              key={t}
              href={`/admin/trend-radar/gap-closer?t=${t}&band=${band}`}
              className={`px-2 py-1 text-xs rounded ${threshold === t ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {t}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">near-miss 폭 (−Δ)</span>
          {BANDS.map((b) => (
            <Link
              key={b}
              href={`/admin/trend-radar/gap-closer?t=${threshold}&band=${b}`}
              className={`px-2 py-1 text-xs rounded ${band === b ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {b}
            </Link>
          ))}
        </div>
        <div className="text-xs text-gray-400 font-mono ml-auto">
          구간 [{threshold - band} ~ {threshold}) · 전체 {total}개 중 {rows.length}개 경계
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="near-miss 후보" value={rows.length} />
        <Kpi label="단일 레버로 회수 가능" value={recoverableCount} highlight={recoverableCount > 0} />
        <Kpi
          label="최대 병목"
          value={topBottleneck ? `${ACTION[topBottleneck.dim].label.split('(')[0]} ${Math.round(topBottleneck.pct * 100)}%` : '—'}
        />
        <Kpi label="진입 임계" value={threshold} />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          이 구간에 경계 상품이 없습니다. 임계/폭을 조정하거나 score cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          {/* Pareto: 구속요인 분포 */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">
              구속요인(binding constraint) 분포 — &apos;어떤 행동이 가장 많은 후보를 살리나&apos;
            </h2>
            <p className="text-xs text-gray-500">
              {topBottleneck && (
                <>
                  near-miss 의 <strong>{Math.round(topBottleneck.pct * 100)}%</strong> 가{' '}
                  <strong>{ACTION[topBottleneck.dim].label}</strong> 병목 → 운영 전략은{' '}
                  <span className="font-medium">&quot;{ACTION[topBottleneck.dim].action}&quot;</span> 에
                  자원 집중.
                </>
              )}
            </p>
            <div className="rounded border border-gray-200 divide-y divide-gray-100">
              {paretoCum.map((x) => (
                <div key={x.dim} className="flex items-center gap-3 px-4 py-2">
                  <div className="w-28 text-xs font-medium shrink-0">{ACTION[x.dim].label}</div>
                  <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
                    <div
                      className={`h-full ${ACTION[x.dim].tone}`}
                      style={{ width: `${Math.round(x.pct * 100)}%` }}
                    />
                  </div>
                  <div className="w-12 text-right text-xs font-mono">{x.count}</div>
                  <div className="w-14 text-right text-xs font-mono text-gray-500">
                    {Math.round(x.pct * 100)}%
                  </div>
                  <div className="w-16 text-right text-[10px] font-mono text-gray-400">
                    누적 {Math.round(x.cumPct * 100)}%
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 상품별 다음수 큐 */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">
              다음수(Next-Best-Action) 큐 — 현재점수 → 필요한 +Δ → 추천 액션 → 예상 도달 final
            </h2>
            <div className="rounded border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">상품</th>
                    <th className="px-3 py-2 text-right">현재 final</th>
                    <th className="px-3 py-2 text-right">필요 +Δ</th>
                    <th className="px-3 py-2 text-left">구속요인</th>
                    <th className="px-3 py-2 text-left">추천 액션</th>
                    <th className="px-3 py-2 text-right">예상 도달</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => {
                    const act = ACTION[r.binding]
                    return (
                      <tr key={r.id} className={r.recoverable ? '' : 'opacity-60'}>
                        <td className="px-3 py-2">
                          <Link
                            href={`/admin/trend-radar/products/${r.id}`}
                            className="font-medium hover:underline"
                          >
                            {r.name}
                          </Link>
                          <div className="text-[10px] text-gray-400 font-mono">
                            {r.category} · T{Math.round(r.scores.trend)} C
                            {Math.round(r.scores.commerce)} S{Math.round(r.scores.supplier)} K
                            {Math.round(r.scores.competition)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold">
                          {r.final.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-600">
                          +{r.gap.toFixed(1)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded ${act.tone}`}>{act.label}</span>
                          <div className="text-[10px] text-gray-400 font-mono mt-0.5">
                            lift {r.marginalLift.toFixed(1)} (여지{' '}
                            {Math.round(100 - r.scores[r.binding])} × w
                            {WEIGHTS[r.binding]})
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {act.href ? (
                            <Link href={act.href} className="hover:underline text-gray-800">
                              {act.action}
                            </Link>
                          ) : (
                            <span className="text-gray-800">{act.action}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          <span className={r.recoverable ? 'text-emerald-700 font-bold' : 'text-gray-500'}>
                            {r.reachableFinal.toFixed(1)}
                          </span>
                          {r.recoverable ? (
                            <span className="text-emerald-600"> ✓</span>
                          ) : (
                            <span className="text-gray-400 text-[10px]"> 부족</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400">
              ✓ = 구속요인 하나만 100 으로 끌어올려도 임계 도달. 부족 = 레버 2개 이상 필요(저효율).
              점수 약어: T트렌드 C상업성 S공급 K경쟁.
            </p>
          </section>

          {/* 공식 */}
          <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
            <div className="font-semibold text-gray-700">📐 산출 공식</div>
            <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
              final = trend×0.30 + commerce×0.30 + supplier×0.20 + competition×0.20
              <br />
              marginal_lift(d) = weight(d) × (100 − score(d))
              <br />
              binding_constraint = argmax_d marginal_lift(d)
              <br />
              예상 도달 final = min(100, final + max_d marginal_lift(d))
            </code>
          </section>
        </>
      )}
    </div>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
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
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
