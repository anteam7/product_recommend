/**
 * Newsvendor 기반 초도 발주량 추천.
 *
 * 입력은 의도적으로 단순화돼 있다 — 카테고리 KM 생존곡선(#13), 반감기(#31), 가격탄력성(#18),
 * 반품률(#17), 공급사 신뢰성(#14) 같은 분석들이 결과로 produces 한 요약 통계 (p10/p50/p90 수요,
 * return_rate, 단가, 가격) 만 받는다. 분석 자체의 구현은 별도이며, 여기서는 그 결과를 한 결정으로
 * 합치는 어그리게이터 역할만 한다.
 *
 * 알고리즘:
 *  - 효과 수요 = demand * (1 - return_rate)
 *  - Cu (under-stock) = price - unit_cost   (놓친 마진)
 *  - Co (over-stock) = unit_cost            (재고 손실, salvage 0 가정 — 보수적)
 *  - critical_ratio  = Cu / (Cu + Co)
 *  - q*              = F^-1(critical_ratio)   — F 는 수요 분포의 CDF
 *  - bootstrap N=2000 샘플로 분포 추정 후 q* 와 기대 마진 계산.
 *
 * 수요 분포: lognormal 로 근사. p10/p50/p90 로부터 mu, sigma 추정 (메디안 = exp(mu),
 * IQR ratio ~ exp(sigma * (z90 - z10))). 이상치 보정 + 양변환.
 */

export type PoInput = {
  demandP10: number
  demandP50: number
  demandP90: number
  returnRate: number   // 0 ~ 1
  unitCost: number     // KRW
  price: number        // KRW
  samples?: number     // bootstrap N, default 2000
  seed?: number        // deterministic when set
}

export type PoResult = {
  recommendedQty: number
  expectedProfit: number
  criticalRatio: number
  contributionMargin: number
  qtyP10: number
  qtyP50: number
  qtyP90: number
  effectiveDemandP50: number
  bootstrapSamples: number
}

// 표준정규분포 분위수의 근사값 (Beasley-Springer-Moro 단순화).
// 0 < p < 1 에서 사용. 정확도 ±1e-4 면 충분 — newsvendor 결과는 정수 반올림으로 떨어진다.
function invStdNormal(p: number): number {
  if (p <= 0) return -8
  if (p >= 1) return 8
  // Acklam's approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q: number, r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

// 시드 가능한 PRNG (mulberry32) — bootstrap 의 결정성 확보용.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fitLognormal(p10: number, p50: number, p90: number): { mu: number; sigma: number } {
  // 메디안 보호: 너무 작거나 음수면 1 로 cap.
  const median = Math.max(p50, 1)
  const lo = Math.max(p10, 0.5)
  const hi = Math.max(p90, lo + 0.5)
  const mu = Math.log(median)
  // sigma 추정: ln(p90/p50) ≈ sigma * z(0.9), z(0.9) ≈ 1.2816
  const sigmaHi = Math.log(hi / median) / 1.2816
  const sigmaLo = Math.log(median / lo) / 1.2816
  const sigma = Math.max((sigmaHi + sigmaLo) / 2, 0.05)
  return { mu, sigma }
}

export function recommendPO(input: PoInput): PoResult {
  const samples = input.samples ?? 2000
  const rng = input.seed != null ? mulberry32(input.seed) : Math.random
  const returnRate = Math.min(Math.max(input.returnRate, 0), 0.95)

  const { mu, sigma } = fitLognormal(input.demandP10, input.demandP50, input.demandP90)

  // bootstrap: lognormal(mu, sigma) 에서 N 샘플 → 효과수요로 변환.
  const draws = new Float64Array(samples)
  for (let i = 0; i < samples; i++) {
    const u = Math.min(Math.max(rng(), 1e-6), 1 - 1e-6)
    const z = invStdNormal(u)
    const d = Math.exp(mu + sigma * z) * (1 - returnRate)
    draws[i] = d
  }
  draws.sort()

  // critical ratio.
  const cu = Math.max(input.price - input.unitCost, 0)
  const co = Math.max(input.unitCost, 1)              // salvage 0 가정
  const criticalRatio = cu / (cu + co)
  const denom = Math.max(input.price, 1)
  const contributionMargin = (input.price - input.unitCost) / denom

  // q*: bootstrap 분포의 critical_ratio 분위수 — 단위 정수 반올림.
  const pick = (p: number) => {
    const idx = Math.min(Math.max(Math.floor(p * (samples - 1)), 0), samples - 1)
    return draws[idx]
  }
  const qStar = Math.max(Math.round(pick(criticalRatio)), 0)

  // 기대 마진: E[ price * min(D, q) - unitCost * q ].
  let totalProfit = 0
  for (let i = 0; i < samples; i++) {
    const d = draws[i]
    const sold = d < qStar ? d : qStar
    totalProfit += input.price * sold - input.unitCost * qStar
  }
  const expectedProfit = totalProfit / samples

  return {
    recommendedQty: qStar,
    expectedProfit: Math.round(expectedProfit),
    criticalRatio,
    contributionMargin,
    qtyP10: Math.round(pick(0.10)),
    qtyP50: Math.round(pick(0.50)),
    qtyP90: Math.round(pick(0.90)),
    effectiveDemandP50: Math.round(input.demandP50 * (1 - returnRate)),
    bootstrapSamples: samples,
  }
}

// 핀에 분석 결과가 아직 없을 때 쓰는 기본 가정 — 시드 시그널에서 추정한 평균선.
// 후속 #13/#17/#18/#31 분석이 들어오면 핀별로 override.
export const DEFAULT_PIN_ASSUMPTIONS = {
  demandP10: 30,
  demandP50: 80,
  demandP90: 220,
  returnRate: 0.10,
  unitCost: 8000,
  price: 24000,
} as const
