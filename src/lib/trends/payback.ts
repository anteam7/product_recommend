// 현금 회수 시뮬레이터 — 순수 함수
// supabase/payback_simulator.sql 의 로직과 동일하게 유지.
// 마이그레이션 적용 전이라도 SSR 에서 즉시 그리드 계산.

export type VelocityProfile = 'conservative' | 'base' | 'aggressive'

export interface PaybackInput {
  unitCost: number       // 도매가 (원)
  capitalWon: number     // 투입 자본 (원)
  velocity: number       // 일판매수량 (개/일)
  marginPct: number      // 마진율 (%)
}

export interface PaybackResult {
  unitCost: number
  capitalWon: number
  velocity: number
  marginPct: number
  salePrice: number
  unitsPurchasable: number
  dailyProfit: number
  paybackDays: number
  roi90d: number
  warning: 'negative_margin' | 'slow_payback' | null
  cumulative: number[]   // 1..90일 누적 회수액 (sparkline 용)
}

export const CAPITAL_OPTIONS = [500_000, 1_000_000, 3_000_000, 5_000_000] as const

export const VELOCITY_PROFILES: Record<VelocityProfile, { label: string; multiplier: number }> = {
  conservative: { label: '보수', multiplier: 0.5 },
  base: { label: '기본', multiplier: 1.0 },
  aggressive: { label: '공격', multiplier: 1.7 },
}

// commerce_score 0~100 → 일판매수량 0.3~8 개/일 (base velocity)
export function estimateVelocity(commerceScore: number | null | undefined): number {
  const s = commerceScore ?? 30
  return Math.max(0.3, s / 12.5)
}

export function simulatePayback({
  unitCost,
  capitalWon,
  velocity,
  marginPct,
}: PaybackInput): PaybackResult {
  const safeUnitCost = unitCost > 0 ? unitCost : 10_000
  const salePrice = safeUnitCost * (1 + marginPct / 100)
  const unitsPurchasable = Math.max(0, Math.floor(capitalWon / safeUnitCost))
  const unitMargin = salePrice - safeUnitCost
  const dailyProfit = velocity * unitMargin

  let paybackDays = 9999
  let warning: PaybackResult['warning'] = null
  if (dailyProfit <= 0) {
    warning = 'negative_margin'
  } else {
    paybackDays = Math.round((capitalWon / dailyProfit) * 100) / 100
    if (paybackDays > 120) warning = 'slow_payback'
  }

  const roi90d =
    capitalWon > 0 ? Math.round(((dailyProfit * 90) / capitalWon) * 10000) / 100 : 0

  // 누적 회수액 (90일) — 자본 회수 후에도 단순 선형 누적 (재투자 회전 모델은 V1)
  const cumulative: number[] = []
  for (let d = 1; d <= 90; d++) {
    cumulative.push(Math.round(dailyProfit * d))
  }

  return {
    unitCost: safeUnitCost,
    capitalWon,
    velocity,
    marginPct,
    salePrice: Math.round(salePrice),
    unitsPurchasable,
    dailyProfit: Math.round(dailyProfit),
    paybackDays,
    roi90d,
    warning,
    cumulative,
  }
}

export function formatWon(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString()}만`
  return n.toLocaleString()
}

export function formatDays(days: number): string {
  if (days >= 9999) return '회수불가'
  if (days >= 1000) return `${Math.round(days)}일+`
  return `${days.toFixed(days >= 100 ? 0 : 1)}일`
}
