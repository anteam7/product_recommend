import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CalibrationScatter from './CalibrationScatter'

export const dynamic = 'force-dynamic'

interface OutcomeRow {
  id: string
  pin_keyword: string
  pin_source: string
  checkpoint_days: number
  predicted_final_score: number | null
  realized_score: number | null
  predicted_category: string | null
  predicted_trend_score: number | null
  predicted_commerce_score: number | null
  predicted_supplier_score: number | null
  predicted_competition_score: number | null
  observed_at: string
  realized_serp_rank: number | null
  realized_supplier_avail: number | null
  product_id: string | null
}

interface WeightRow {
  category_top: string
  w_trend: number
  w_commerce: number
  w_supplier: number
  w_competition: number
  bias: number
  sample_n: number
  residual_rmse: number | null
  computed_at: string
}

const DEFAULT_WEIGHTS = { w_trend: 0.3, w_commerce: 0.25, w_supplier: 0.25, w_competition: 0.2 }

async function fetchData() {
  const sb = createAdminClient()

  // 신규 테이블 (calibration.sql) — generated 타입 미반영이므로 `as never` 캐스팅.
  const { data: outcomes, error: oErr } = await sb
    .from('jimscanner_pin_outcomes' as never)
    .select(
      'id, pin_keyword, pin_source, checkpoint_days, predicted_final_score, realized_score, predicted_category, predicted_trend_score, predicted_commerce_score, predicted_supplier_score, predicted_competition_score, observed_at, realized_serp_rank, realized_supplier_avail, product_id',
    )
    .order('observed_at', { ascending: false })
    .limit(500) as { data: OutcomeRow[] | null; error: { message: string } | null }

  const { data: weights, error: wErr } = await sb
    .from('jimscanner_calibration_weights' as never)
    .select('*') as { data: WeightRow[] | null; error: { message: string } | null }

  return {
    outcomes: (outcomes ?? []) as OutcomeRow[],
    weights: (weights ?? []) as WeightRow[],
    error: oErr?.message ?? wErr?.message ?? null,
  }
}

function topMisses(outcomes: OutcomeRow[]): OutcomeRow[] {
  return [...outcomes]
    .filter((r) => r.predicted_final_score != null && r.realized_score != null)
    .map((r) => ({ ...r, _absDelta: Math.abs((r.realized_score ?? 0) - (r.predicted_final_score ?? 0)) }))
    .sort((a: any, b: any) => b._absDelta - a._absDelta)
    .slice(0, 10)
}

function categoryResiduals(outcomes: OutcomeRow[]) {
  const byCat = new Map<string, { n: number; resSum: number; resSqSum: number; trendBias: number; commerceBias: number; supplierBias: number; competitionBias: number }>()
  for (const r of outcomes) {
    if (r.predicted_final_score == null || r.realized_score == null) continue
    const cat = r.predicted_category ?? '_unknown'
    if (!byCat.has(cat)) {
      byCat.set(cat, { n: 0, resSum: 0, resSqSum: 0, trendBias: 0, commerceBias: 0, supplierBias: 0, competitionBias: 0 })
    }
    const acc = byCat.get(cat)!
    const residual = (r.realized_score ?? 0) - (r.predicted_final_score ?? 0)
    acc.n += 1
    acc.resSum += residual
    acc.resSqSum += residual * residual

    // 각 지표가 realized 와 얼마나 떨어졌는지 — 가중치 잔차 힌트
    if (r.predicted_trend_score != null) acc.trendBias += (r.realized_score ?? 0) - r.predicted_trend_score
    if (r.predicted_commerce_score != null) acc.commerceBias += (r.realized_score ?? 0) - r.predicted_commerce_score
    if (r.predicted_supplier_score != null) acc.supplierBias += (r.realized_score ?? 0) - r.predicted_supplier_score
    if (r.predicted_competition_score != null) acc.competitionBias += (r.realized_score ?? 0) - r.predicted_competition_score
  }
  return [...byCat.entries()].map(([cat, a]) => ({
    cat,
    n: a.n,
    meanResidual: a.n ? a.resSum / a.n : 0,
    rmse: a.n ? Math.sqrt(a.resSqSum / a.n) : 0,
    trendBias: a.n ? a.trendBias / a.n : 0,
    commerceBias: a.n ? a.commerceBias / a.n : 0,
    supplierBias: a.n ? a.supplierBias / a.n : 0,
    competitionBias: a.n ? a.competitionBias / a.n : 0,
  }))
}

export default async function CalibrationPage() {
  const { outcomes, weights, error } = await fetchData()

  const observed = outcomes.filter((r) => r.predicted_final_score != null && r.realized_score != null)
  const misses = topMisses(outcomes)
  const catResiduals = categoryResiduals(outcomes)

  const overallRmse =
    observed.length > 0
      ? Math.sqrt(
          observed.reduce((s, r) => s + ((r.realized_score ?? 0) - (r.predicted_final_score ?? 0)) ** 2, 0) /
            observed.length,
        )
      : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 캘리브레이션 (Post-Pin Outcome)</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀 채택 상품의 +30/+60/+90일 실현 점수와 사전 예측을 비교 — 모델 자체를 학습시킴.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          데이터 조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>supabase/calibration.sql</code> 적용 안 된 상태일 수 있음.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="총 관측치" value={outcomes.length} />
        <Kpi label="유효 관측치" value={observed.length} />
        <Kpi label="+30일" value={outcomes.filter((r) => r.checkpoint_days === 30).length} />
        <Kpi label="+60일" value={outcomes.filter((r) => r.checkpoint_days === 60).length} />
        <Kpi label="전체 RMSE" value={overallRmse.toFixed(2)} highlight={overallRmse > 0} />
      </section>

      {/* 1) 산점도 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">① 예측 vs 실현 산점도</h2>
        <p className="text-xs text-gray-500">
          X = 예측 final_score · Y = +90일 후 realized_score · 대각선 위 = 예측 미달, 아래 = 예측 초과.
        </p>
        {observed.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            아직 누적 데이터 없음. 핀 후 30일 경과해야 첫 관측치 생성.
            <br />
            <code className="text-xs">node --env-file=.env.local scripts/track-pin-outcomes.mjs</code>
          </div>
        ) : (
          <CalibrationScatter
            rows={observed.map((r) => ({
              id: r.id,
              predicted: r.predicted_final_score ?? 0,
              realized: r.realized_score ?? 0,
              category: r.predicted_category ?? 'all',
              checkpoint: r.checkpoint_days,
              keyword: r.pin_keyword,
            }))}
          />
        )}
      </section>

      {/* 2) 카테고리별 잔차 + 학습된 가중치 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">② 카테고리별 잔차 & 학습된 가중치</h2>
        <p className="text-xs text-gray-500">
          잔차(+) = 모델이 과소평가 · 잔차(−) = 과대평가. 가중치는 <code>jimscanner_calibration_weights</code> 에서 사용.
        </p>
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-right">n</th>
                <th className="px-3 py-2 text-right">mean 잔차</th>
                <th className="px-3 py-2 text-right">RMSE</th>
                <th className="px-3 py-2 text-right">w_trend</th>
                <th className="px-3 py-2 text-right">w_commerce</th>
                <th className="px-3 py-2 text-right">w_supplier</th>
                <th className="px-3 py-2 text-right">w_competition</th>
                <th className="px-3 py-2 text-right">bias</th>
                <th className="px-3 py-2 text-left">상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {catResiduals.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-gray-400">
                    관측 누적 후 표시
                  </td>
                </tr>
              ) : (
                catResiduals.map((c) => {
                  const w = weights.find((w) => w.category_top === c.cat)
                  return (
                    <tr key={c.cat} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium">{c.cat}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.n}</td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${
                          Math.abs(c.meanResidual) > 10 ? 'text-red-600 font-semibold' : 'text-gray-700'
                        }`}
                      >
                        {c.meanResidual > 0 ? '+' : ''}
                        {c.meanResidual.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{c.rmse.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono">{(w?.w_trend ?? DEFAULT_WEIGHTS.w_trend).toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{(w?.w_commerce ?? DEFAULT_WEIGHTS.w_commerce).toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{(w?.w_supplier ?? DEFAULT_WEIGHTS.w_supplier).toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{(w?.w_competition ?? DEFAULT_WEIGHTS.w_competition).toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{(w?.bias ?? 0).toFixed(2)}</td>
                      <td className="px-3 py-2 text-left text-gray-500">
                        {w?.sample_n ? `n=${w.sample_n}` : <span className="text-gray-400">default</span>}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400">
          → 표본 5건 이상 카테고리만 학습. 4지표 |상관계수| 비율로 가중치 분배 (V0 근사).
        </p>
      </section>

      {/* 3) Top 10 misses */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">③ 예측 빗나간 Top 10 회고</h2>
        {misses.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-gray-400 text-sm">
            관측치 부족
          </div>
        ) : (
          <div className="space-y-2">
            {misses.map((m: any) => {
              const delta = (m.realized_score ?? 0) - (m.predicted_final_score ?? 0)
              const direction = delta > 0 ? '실현 > 예측 (과소평가)' : '실현 < 예측 (과대평가)'
              return (
                <div
                  key={m.id}
                  className={`rounded border px-4 py-3 ${
                    delta > 0 ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-200 bg-rose-50/40'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="font-medium text-sm">{m.pin_keyword}</div>
                    <div className="text-xs text-gray-500 font-mono">
                      +{m.checkpoint_days}일 · {m.predicted_category ?? '?'} · {m.pin_source}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-gray-600 flex flex-wrap gap-3">
                    <span>
                      예측{' '}
                      <span className="font-mono font-semibold">
                        {(m.predicted_final_score ?? 0).toFixed(1)}
                      </span>
                    </span>
                    <span>
                      실현{' '}
                      <span className="font-mono font-semibold">{(m.realized_score ?? 0).toFixed(1)}</span>
                    </span>
                    <span className={`font-mono ${delta > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      Δ {delta > 0 ? '+' : ''}
                      {delta.toFixed(1)} ({direction})
                    </span>
                    {m.realized_serp_rank != null && (
                      <span className="text-gray-500">SERP #{m.realized_serp_rank}</span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500 font-mono">
                    trend {(m.predicted_trend_score ?? 0).toFixed(0)} · commerce{' '}
                    {(m.predicted_commerce_score ?? 0).toFixed(0)} · supplier{' '}
                    {(m.predicted_supplier_score ?? 0).toFixed(0)} · competition{' '}
                    {(m.predicted_competition_score ?? 0).toFixed(0)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">⚙️ 운영</div>
        <div>
          매일 KST 07:30 <code>scripts/track-pin-outcomes.mjs</code> 실행 → 도래한 +30/+60/+90 체크포인트 upsert →
          잔차 회귀로 카테고리 가중치 갱신 → <code>recompute_scores_calibrated()</code> RPC 호출.
        </div>
        <div>학습된 가중치는 <code>jimscanner_calibration_weights</code>, 관측 row 는 <code>jimscanner_pin_outcomes</code>.</div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-amber-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
