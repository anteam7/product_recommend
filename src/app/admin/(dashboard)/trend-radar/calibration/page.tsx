import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_trends_backtest 뷰 (supabase/trends_backtest_calibration.sql)
interface BacktestRow {
  listing_id: string
  seller_product_id: number | null
  source_goods_no: string | null
  registered_title: string | null
  product_id: string | null
  registered_at: string | null
  status: string | null
  trend_score: number | null
  commerce_score: number | null
  supplier_score: number | null
  competition_score: number | null
  final_score: number | null
  score_at: string | null
  realized_units: number
  realized_revenue: number
  realized_margin: number
  order_count: number
}

const COMPONENTS = [
  { key: 'trend_score', label: 'trend' },
  { key: 'commerce_score', label: 'commerce' },
  { key: 'supplier_score', label: 'supplier' },
  { key: 'competition_score', label: 'competition' },
] as const

// ── 통계 헬퍼 ──────────────────────────────────────────────────────────────
function rank(values: number[]): number[] {
  // 평균 순위 (tie 처리)
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length).fill(0)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++
    const avg = (i + j) / 2 + 1 // 1-based 평균 순위
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg
    i = j + 1
  }
  return ranks
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  if (n < 3) return NaN
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) return NaN
  return num / Math.sqrt(da * db)
}

// 스피어만 = 순위 기반 피어슨
function spearman(a: number[], b: number[]): number {
  return pearson(rank(a), rank(b))
}

async function fetchData() {
  const sb = createAdminClient()
  // 뷰는 타입 미생성 → as any
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_backtest')
    .select('*')
    .limit(5000)
  const rows: BacktestRow[] = (data ?? []) as BacktestRow[]
  return { rows, error: error?.message ?? null }
}

export default async function CalibrationPage() {
  const { rows, error } = await fetchData()

  // 점수 스냅샷이 있는 행만 분석 대상
  const scored = rows.filter((r) => r.final_score != null)
  const sold = scored.filter((r) => r.realized_units > 0)

  // ① decile (점수 10분위) 별 적중률 / 평균 판매
  const byScore = [...scored].sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
  const deciles: {
    bucket: number
    range: string
    n: number
    hitRate: number
    avgUnits: number
    avgMargin: number
  }[] = []
  const D = 10
  if (byScore.length > 0) {
    const size = Math.ceil(byScore.length / D)
    for (let d = 0; d < D; d++) {
      const slice = byScore.slice(d * size, (d + 1) * size)
      if (slice.length === 0) continue
      const hits = slice.filter((r) => r.realized_units > 0).length
      const lo = slice[slice.length - 1].final_score ?? 0
      const hi = slice[0].final_score ?? 0
      deciles.push({
        bucket: d + 1,
        range: `${lo.toFixed(0)}–${hi.toFixed(0)}`,
        n: slice.length,
        hitRate: hits / slice.length,
        avgUnits: slice.reduce((s, r) => s + r.realized_units, 0) / slice.length,
        avgMargin: slice.reduce((s, r) => s + r.realized_margin, 0) / slice.length,
      })
    }
  }

  // ② 4컴포넌트 각각의 실판매 상관 (스피어만 vs realized_units / realized_margin)
  const corr = COMPONENTS.map((c) => {
    const xs = scored.map((r) => (r[c.key] as number) ?? 0)
    const yU = scored.map((r) => r.realized_units)
    const yM = scored.map((r) => r.realized_margin)
    return {
      label: c.label,
      key: c.key,
      rhoUnits: spearman(xs, yU),
      rhoMargin: spearman(xs, yM),
    }
  })
  const finalCorr = {
    rhoUnits: spearman(scored.map((r) => r.final_score ?? 0), scored.map((r) => r.realized_units)),
    rhoMargin: spearman(scored.map((r) => r.final_score ?? 0), scored.map((r) => r.realized_margin)),
  }

  // ③ false-positive (고점수인데 안 팔림) / 누락 (저점수인데 팔림)
  const scoreThresh = 60
  const falsePos = scored
    .filter((r) => (r.final_score ?? 0) >= scoreThresh && r.realized_units === 0)
    .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
    .slice(0, 20)
  const missed = scored
    .filter((r) => (r.final_score ?? 0) < scoreThresh && r.realized_units > 0)
    .sort((a, b) => b.realized_units - a.realized_units)
    .slice(0, 20)

  // ④ 상관 기반 가중치 재조정 제안 (|rho| 양수만, 정규화)
  const posCorr = corr.map((c) => ({ label: c.label, w: Math.max(0, c.rhoUnits || 0) }))
  const sumW = posCorr.reduce((s, c) => s + c.w, 0)
  const suggestedWeights = posCorr.map((c) => ({
    label: c.label,
    weight: sumW > 0 ? c.w / sumW : 0.25,
  }))

  const fmtRho = (v: number) => (Number.isNaN(v) ? '—' : v.toFixed(2))
  const fmtWon = (v: number) => `₩${Math.round(v).toLocaleString('ko-KR')}`

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">발굴 점수 캘리브레이션</h1>
          <p className="mt-1 text-sm text-gray-500">
            등록 시점 점수 vs 쿠팡 실판매 — 발굴 엔진이 실제로 잘 팔리는 상품을 골랐는가
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          백테스트 뷰를 읽지 못했습니다 ({error}). <code>supabase/trends_backtest_calibration.sql</code> 적용 여부를 확인하세요.
        </div>
      )}

      {/* 요약 */}
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: '점수 스냅샷 보유 등록', v: scored.length.toLocaleString() },
          { label: '실판매 발생 (units>0)', v: sold.length.toLocaleString() },
          {
            label: 'final_score ↔ 판매량 ρ',
            v: fmtRho(finalCorr.rhoUnits),
          },
          {
            label: 'final_score ↔ 마진 ρ',
            v: fmtRho(finalCorr.rhoMargin),
          },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{c.v}</div>
          </div>
        ))}
      </section>

      {scored.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 점수↔실판매로 조인된 데이터가 없습니다. 등록·주문이 쌓이면 채워집니다.
        </div>
      ) : (
        <>
          {/* ① decile 적중률 */}
          <section className="space-y-2">
            <h2 className="text-lg font-semibold">① 점수 구간별 실판매 적중률 (precision@K)</h2>
            <p className="text-sm text-gray-500">
              점수가 높을수록 hit rate(팔린 비율)·평균 판매량이 높아야 캘리브레이션이 맞는 것.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="py-2 pr-4">구간(상위)</th>
                    <th className="py-2 pr-4">final_score</th>
                    <th className="py-2 pr-4">N</th>
                    <th className="py-2 pr-4">hit rate</th>
                    <th className="py-2 pr-4">평균 판매</th>
                    <th className="py-2 pr-4">평균 마진</th>
                  </tr>
                </thead>
                <tbody>
                  {deciles.map((d) => (
                    <tr key={d.bucket} className="border-b border-gray-100">
                      <td className="py-2 pr-4 font-medium">D{d.bucket}</td>
                      <td className="py-2 pr-4 tabular-nums">{d.range}</td>
                      <td className="py-2 pr-4 tabular-nums">{d.n}</td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 overflow-hidden rounded bg-gray-100">
                            <div
                              className="h-full bg-emerald-500"
                              style={{ width: `${Math.round(d.hitRate * 100)}%` }}
                            />
                          </div>
                          <span className="tabular-nums">{Math.round(d.hitRate * 100)}%</span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{d.avgUnits.toFixed(1)}</td>
                      <td className="py-2 pr-4 tabular-nums">{fmtWon(d.avgMargin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ② 컴포넌트 상관 + ④ 가중치 제안 */}
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">② 컴포넌트별 실판매 상관 (스피어만 ρ)</h2>
              <p className="text-sm text-gray-500">
                +1에 가까울수록 그 컴포넌트가 실판매를 잘 예측. 음수면 역상관(점수 방향이 틀림).
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="py-2 pr-4">컴포넌트</th>
                    <th className="py-2 pr-4">ρ vs 판매량</th>
                    <th className="py-2 pr-4">ρ vs 마진</th>
                  </tr>
                </thead>
                <tbody>
                  {corr.map((c) => (
                    <tr key={c.key} className="border-b border-gray-100">
                      <td className="py-2 pr-4 font-medium">{c.label}</td>
                      <td
                        className={`py-2 pr-4 tabular-nums ${
                          c.rhoUnits < 0 ? 'text-rose-600' : 'text-gray-800'
                        }`}
                      >
                        {fmtRho(c.rhoUnits)}
                      </td>
                      <td
                        className={`py-2 pr-4 tabular-nums ${
                          c.rhoMargin < 0 ? 'text-rose-600' : 'text-gray-800'
                        }`}
                      >
                        {fmtRho(c.rhoMargin)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <h2 className="text-lg font-semibold">④ 상관 기반 가중치 재조정 제안</h2>
              <p className="text-sm text-gray-500">
                판매량 상관(양수)에 비례해 final_score 가중치를 재배분한 제안. recompute_scores 튜닝 출발점.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="py-2 pr-4">컴포넌트</th>
                    <th className="py-2 pr-4">제안 가중치</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestedWeights.map((w) => (
                    <tr key={w.label} className="border-b border-gray-100">
                      <td className="py-2 pr-4 font-medium">{w.label}</td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-32 overflow-hidden rounded bg-gray-100">
                            <div
                              className="h-full bg-indigo-500"
                              style={{ width: `${Math.round(w.weight * 100)}%` }}
                            />
                          </div>
                          <span className="tabular-nums">{(w.weight * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sumW === 0 && (
                <p className="text-xs text-gray-400">
                  양의 상관이 없어 균등(25%) 폴백. 표본이 더 쌓이면 의미가 생깁니다.
                </p>
              )}
            </div>
          </section>

          {/* ③ false-positive / 누락 */}
          <section className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">
                ③-a 고점수 false-positive (score≥{scoreThresh}, 판매 0)
              </h2>
              <ListTable rows={falsePos} metric="score" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">
                ③-b 저점수 누락 (score&lt;{scoreThresh}, 판매 발생)
              </h2>
              <ListTable rows={missed} metric="units" />
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function ListTable({ rows, metric }: { rows: BacktestRow[]; metric: 'score' | 'units' }) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">해당 없음.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="py-2 pr-4">상품</th>
            <th className="py-2 pr-4">score</th>
            <th className="py-2 pr-4">판매</th>
            <th className="py-2 pr-4">마진</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.listing_id} className="border-b border-gray-100">
              <td className="max-w-[220px] truncate py-2 pr-4" title={r.registered_title ?? ''}>
                {r.registered_title ?? r.source_goods_no ?? r.listing_id}
              </td>
              <td className={`py-2 pr-4 tabular-nums ${metric === 'score' ? 'font-semibold' : ''}`}>
                {(r.final_score ?? 0).toFixed(0)}
              </td>
              <td className={`py-2 pr-4 tabular-nums ${metric === 'units' ? 'font-semibold' : ''}`}>
                {r.realized_units}
              </td>
              <td className="py-2 pr-4 tabular-nums">
                ₩{Math.round(r.realized_margin).toLocaleString('ko-KR')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
