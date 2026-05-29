import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 뷰 supabase/trends_score_backtest.sql — generated 타입 미반영이라 `as any` 캐스팅.
interface BacktestRow {
  score_id: string
  product_id: string
  canonical_name: string
  category_top: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
  was_pinned: boolean
  order_count_30d: number
  revenue_30d: number
  is_mature: boolean
}

const COMPONENTS = [
  { key: 'trend_score', label: 'trend' },
  { key: 'commerce_score', label: 'commerce' },
  { key: 'supplier_score', label: 'supplier' },
  { key: 'competition_score', label: 'competition' },
] as const
type CompKey = (typeof COMPONENTS)[number]['key']

// ── 통계 헬퍼 ────────────────────────────────────────────────

// Mann-Whitney U 기반 AUC (tie = 평균 순위). label 양/음이 모두 있어야 의미.
function auc(values: number[], labels: number[]): number | null {
  const pairs = values.map((v, i) => ({ v, y: labels[i] }))
  const nPos = pairs.filter((p) => p.y === 1).length
  const nNeg = pairs.length - nPos
  if (nPos === 0 || nNeg === 0) return null
  const sorted = [...pairs].sort((a, b) => a.v - b.v)
  // 평균 순위 부여 (tie 처리)
  const ranks = new Array(sorted.length)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j++
    const avgRank = (i + j) / 2 + 1 // 1-based
    for (let k = i; k <= j; k++) ranks[k] = avgRank
    i = j + 1
  }
  let sumRankPos = 0
  sorted.forEach((p, idx) => {
    if (p.y === 1) sumRankPos += ranks[idx]
  })
  return (sumRankPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}

// 분위(quartile)별 성공률 + top-quartile lift
function quartileLift(values: number[], labels: number[]) {
  const pairs = values
    .map((v, i) => ({ v, y: labels[i] }))
    .sort((a, b) => a.v - b.v)
  const n = pairs.length
  const base = n ? pairs.reduce((s, p) => s + p.y, 0) / n : 0
  const buckets: { rate: number; n: number }[] = []
  for (let q = 0; q < 4; q++) {
    const lo = Math.floor((q * n) / 4)
    const hi = Math.floor(((q + 1) * n) / 4)
    const slice = pairs.slice(lo, hi)
    const rate = slice.length ? slice.reduce((s, p) => s + p.y, 0) / slice.length : 0
    buckets.push({ rate, n: slice.length })
  }
  const top = buckets[3].rate
  return { buckets, base, lift: base > 0 ? top / base : 0 }
}

// 정규방정식 4x4 OLS — final_score 를 4 subscore 로 회귀 → 현재 "암묵 가중치" 복원.
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-9) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

function olsWeights(rows: BacktestRow[]): number[] | null {
  const X = rows.map((r) => COMPONENTS.map((c) => Number(r[c.key as CompKey])))
  const y = rows.map((r) => Number(r.final_score))
  const k = COMPONENTS.length
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0))
  const Xty = new Array(k).fill(0)
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i]
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]
    }
  }
  return solveLinear(XtX, Xty)
}

// 표준화 후 로지스틱 회귀 (배치 경사하강) — 결과 예측 증거기반 가중치.
function logisticWeights(rows: BacktestRow[], labels: number[]) {
  const k = COMPONENTS.length
  const raw = rows.map((r) => COMPONENTS.map((c) => Number(r[c.key as CompKey])))
  const mean = new Array(k).fill(0)
  const std = new Array(k).fill(0)
  for (const row of raw) for (let a = 0; a < k; a++) mean[a] += row[a]
  for (let a = 0; a < k; a++) mean[a] /= raw.length || 1
  for (const row of raw) for (let a = 0; a < k; a++) std[a] += (row[a] - mean[a]) ** 2
  for (let a = 0; a < k; a++) std[a] = Math.sqrt(std[a] / (raw.length || 1)) || 1
  const X = raw.map((row) => row.map((v, a) => (v - mean[a]) / std[a]))
  const w = new Array(k).fill(0)
  let bias = 0
  const lr = 0.1
  for (let iter = 0; iter < 800; iter++) {
    const gw = new Array(k).fill(0)
    let gb = 0
    for (let i = 0; i < X.length; i++) {
      let z = bias
      for (let a = 0; a < k; a++) z += w[a] * X[i][a]
      const p = 1 / (1 + Math.exp(-z))
      const err = p - labels[i]
      for (let a = 0; a < k; a++) gw[a] += err * X[i][a]
      gb += err
    }
    for (let a = 0; a < k; a++) w[a] -= (lr * gw[a]) / (X.length || 1)
    bias -= (lr * gb) / (X.length || 1)
  }
  return w // 표준화 공간 계수 (= 각 컴포넌트 1σ 변동의 로그오즈 기여)
}

// 가중치 → 합 1 정규화 (음수는 0 으로 클립: 노이즈/역신호 컴포넌트 제거 권장)
function normalizeWeights(w: number[]): number[] {
  const clipped = w.map((x) => Math.max(0, x))
  const sum = clipped.reduce((s, x) => s + x, 0)
  return sum > 0 ? clipped.map((x) => x / sum) : w.map(() => 1 / w.length)
}

async function fetchRows(): Promise<BacktestRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_score_backtest')
    .select('*')
    .limit(10000)
  if (error) throw error
  return (data ?? []) as BacktestRow[]
}

export default async function BacktestPage() {
  let rows: BacktestRow[] = []
  let loadError: string | null = null
  try {
    rows = await fetchRows()
  } catch (e: any) {
    loadError = e?.message ?? String(e)
  }

  const mature = rows.filter((r) => r.is_mature)
  const labels = mature.map((r) => (r.was_pinned || Number(r.order_count_30d) > 0 ? 1 : 0))
  const nPos = labels.filter((l) => l === 1).length
  const enough = mature.length >= 20 && nPos >= 3 && nPos < mature.length

  // ① sub-score 별 예측력
  const perComponent = COMPONENTS.map((c) => {
    const vals = mature.map((r) => Number(r[c.key as CompKey]))
    return {
      ...c,
      auc: enough ? auc(vals, labels) : null,
      ...quartileLift(vals, labels),
    }
  })

  // ② final_score 캘리브레이션 (분위별 실제 성공률)
  const finalCal = quartileLift(
    mature.map((r) => Number(r.final_score)),
    labels,
  )

  // ③ 현재 암묵 가중치(OLS) vs 증거기반(로지스틱)
  const currentRaw = mature.length >= 5 ? olsWeights(mature) : null
  const currentNorm = currentRaw ? normalizeWeights(currentRaw) : null
  const evidenceRaw = enough ? logisticWeights(mature, labels) : null
  const evidenceNorm = evidenceRaw ? normalizeWeights(evidenceRaw) : null

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🧪 스코어 백테스트 — 가중치 증거기반 재학습</h1>
          <p className="text-sm text-gray-500 mt-1">
            과거 score 스냅샷 × 사후 결과(핀 / 쿠팡 판매)를 조인해 4 sub-score 의 예측력과
            증거기반 권장 가중치를 도출.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
        <strong>방법</strong> · 결과 라벨 = (스냅샷 후 30일 내 <b>핀</b> 또는 <b>쿠팡 판매≥1</b>).
        성숙(is_mature) 스냅샷만 사용. AUC=Mann-Whitney 순위. 현재 가중치는 final_score ~ 4
        subscore <b>OLS</b> 로 복원, 증거 가중치는 결과 예측 <b>로지스틱 회귀</b>(표준화) 계수.
        매칭은 이름 ILIKE 프록시 — 정밀 FK 도입 시 신뢰도 상승.
      </div>

      {loadError && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          뷰 조회 에러: <code className="font-mono text-xs">{loadError}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_trends_score_backtest</code> 미적용 가능성 — supabase/trends_score_backtest.sql 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="전체 스냅샷" value={rows.length} />
        <Kpi label="성숙(mature)" value={mature.length} />
        <Kpi label="성공 라벨" value={nPos} highlight={nPos > 0} />
        <Kpi label="성공률(base)" value={`${(finalCal.base * 100).toFixed(1)}%`} />
        <Kpi label="final lift(top분위)" value={`${finalCal.lift.toFixed(2)}×`} highlight={finalCal.lift > 1.2} />
      </section>

      {!enough && !loadError && (
        <div className="rounded border border-dashed border-amber-300 bg-amber-50 p-6 text-center text-sm text-amber-800">
          분석에 충분한 라벨이 아직 없음 (성숙 ≥20 & 성공 ≥3 필요, 현재 성숙 {mature.length} / 성공 {nPos}).
          <br />
          score 스냅샷과 핀·쿠팡 판매가 더 누적되면 자동으로 지표가 산출됩니다. 아래 표는 가용 데이터로 부분 표시.
        </div>
      )}

      {/* ① sub-score 예측력 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">① sub-score 별 결과 예측력</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">컴포넌트</th>
                <th className="px-3 py-2 text-right">AUC</th>
                <th className="px-3 py-2 text-right">top분위 lift</th>
                <th className="px-3 py-2 text-right">Q1</th>
                <th className="px-3 py-2 text-right">Q2</th>
                <th className="px-3 py-2 text-right">Q3</th>
                <th className="px-3 py-2 text-right">Q4(상위)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {perComponent.map((c) => (
                <tr key={c.key}>
                  <td className="px-3 py-2 font-medium">{c.label}</td>
                  <td className={`px-3 py-2 text-right font-mono ${aucCls(c.auc)}`}>
                    {c.auc == null ? '—' : c.auc.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{c.lift ? `${c.lift.toFixed(2)}×` : '—'}</td>
                  {c.buckets.map((b, i) => (
                    <td key={i} className="px-3 py-2 text-right font-mono text-gray-600">
                      {(b.rate * 100).toFixed(0)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400">
          AUC 0.5 = 무작위, &gt;0.6 약한 예측력, &gt;0.7 양호. lift &lt; 1 이면 해당 점수가 오히려 역신호.
        </p>
      </section>

      {/* ② final_score 캘리브레이션 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">② final_score 분위별 판매전환 캘리브레이션</h2>
        <div className="rounded border border-gray-200 p-4">
          <div className="flex items-end gap-3 h-32">
            {finalCal.buckets.map((b, i) => (
              <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
                <div className="text-[10px] font-mono text-gray-600">{(b.rate * 100).toFixed(0)}%</div>
                <div
                  className="w-full bg-amber-400 rounded-t"
                  style={{ height: `${Math.max(2, b.rate * 100)}%` }}
                />
                <div className="text-[10px] text-gray-400 mt-1">Q{i + 1}</div>
              </div>
            ))}
          </div>
          <div className="border-t border-dashed border-gray-300 mt-2 pt-2 text-[11px] text-gray-500">
            점선 기준 base 성공률 {(finalCal.base * 100).toFixed(1)}% · 단조증가할수록 final_score 가
            잘 보정(calibrated)됨. 평탄/역전 시 가중치 재조정 신호.
          </div>
        </div>
      </section>

      {/* ③ 현재 vs 증거기반 가중치 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">③ 현재 가중치(복원) vs 증거기반 권장 가중치</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">컴포넌트</th>
                <th className="px-3 py-2 text-right">현재(OLS 복원)</th>
                <th className="px-3 py-2 text-right">증거기반(로지스틱)</th>
                <th className="px-3 py-2 text-right">Δ 변화</th>
                <th className="px-3 py-2 text-left">제안</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {COMPONENTS.map((c, i) => {
                const cur = currentNorm?.[i] ?? null
                const ev = evidenceNorm?.[i] ?? null
                const delta = cur != null && ev != null ? ev - cur : null
                return (
                  <tr key={c.key}>
                    <td className="px-3 py-2 font-medium">{c.label}</td>
                    <td className="px-3 py-2 text-right font-mono">{cur == null ? '—' : cur.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">
                      {ev == null ? '—' : ev.toFixed(3)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${
                        delta == null ? '' : delta > 0.02 ? 'text-emerald-600' : delta < -0.02 ? 'text-red-600' : 'text-gray-400'
                      }`}
                    >
                      {delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {delta == null
                        ? '—'
                        : delta > 0.05
                          ? '↑ 비중 확대'
                          : delta < -0.05
                            ? '↓ 비중 축소 (노이즈 의심)'
                            : '유지'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400">
          증거기반 가중치는 결과 예측 로지스틱 계수를 양수 클립 후 합 1 정규화한 값(score_components
          재조정 제안). 음수 계수 컴포넌트는 0 처리 — 발굴 우선순위에서 사실상 제외 권장.
        </p>
      </section>
    </div>
  )
}

function aucCls(auc: number | null): string {
  if (auc == null) return 'text-gray-400'
  if (auc >= 0.7) return 'text-emerald-600 font-semibold'
  if (auc >= 0.6) return 'text-amber-600'
  if (auc < 0.5) return 'text-red-600'
  return 'text-gray-600'
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
