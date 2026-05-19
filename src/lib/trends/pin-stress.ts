/**
 * 핀별 마진 스트레스 테스트.
 *
 * 입력은 supabase/pin_stress.sql 의 `jimscanner_pin_stress_inputs` 뷰 1행.
 * 4개 외생인자(환율/관세율/도매가/택배비) 를 ±5/±10/±20% 흔들어
 * 토네이도 차트용 마진 변동폭 + BEP(임계 %) + 내성 등급 산출.
 *
 * Base margin (KRW)
 *   = selling_price
 *     − (supplier_price_krw)
 *     − (supplier_price_krw * duty_rate / 100)       // 관세 (간이)
 *     − (selling_price * vat_rate / 100)             // 부가세 (간이, 셀러 부담분)
 *     − shipping_krw
 *     − handling_krw
 *
 * Note: 정확한 통관세는 면세한도/품목별 룰이 있으나, 본 계산은 핀별 '상대' 민감도
 * 비교가 목적이므로 위 단순 모형을 사용. UI 에 면책 문구 명시.
 */

export interface PinStressInputs {
  product_id: string
  name: string | null
  category_top: string | null
  category_mid: string | null
  final_score: number | null
  trend_score: number | null
  commerce_score: number | null
  supplier_score: number | null
  competition_score: number | null
  scored_at: string | null
  supplier_source: string | null
  supplier_price_krw: number | null
  supplier_price_original: number | null
  supplier_currency: string | null
  supplier_collected_at: string | null
  cny_krw: number
  usd_krw: number
  duty_rate_percent: number
  vat_rate_percent: number
  shipping_krw: number
  handling_krw: number
  selling_price_krw_est: number | null
}

export type StressFactor = 'fx' | 'duty' | 'supplier' | 'shipping'

export interface StressPoint {
  factor: StressFactor
  delta_pct: number // -20, -10, -5, +5, +10, +20
  margin_krw: number
  margin_pct: number // margin / selling_price * 100
  delta_from_base_krw: number
}

export interface StressResult {
  product_id: string
  name: string
  category_top: string | null
  selling_price_krw: number
  supplier_price_krw: number
  base_margin_krw: number
  base_margin_pct: number
  points: StressPoint[]
  /** 각 인자별 BEP(마진이 0이 되는 변동률 %) — 양수면 그만큼 악화가 허용됨. */
  bep: Record<StressFactor, number | null>
  resilience: 'strong' | 'normal' | 'fragile' | 'unknown'
  /** 계산 가능 여부 + 사유 */
  computable: boolean
  reason?: string
}

const FACTOR_LABEL: Record<StressFactor, string> = {
  fx: '환율(CNY→KRW)',
  duty: '관세율',
  supplier: '도매가',
  shipping: '국제택배비',
}

export function factorLabel(f: StressFactor): string {
  return FACTOR_LABEL[f]
}

interface Inputs {
  selling: number
  supplier: number
  duty: number // %
  vat: number // %
  shipping: number
  handling: number
  fx: number // unused in direct calc, but supplier_price_krw was already converted via fx; 변동률을 supplier 가격에 적용 = fx 변동.
}

function computeMargin(i: Inputs): number {
  // 관세는 supplier(원가) 기준, VAT 는 selling 기준 (간이)
  const customs = (i.supplier * i.duty) / 100
  const vat = (i.selling * i.vat) / 100
  return i.selling - i.supplier - customs - vat - i.shipping - i.handling
}

function applyShock(base: Inputs, factor: StressFactor, deltaPct: number): Inputs {
  const k = 1 + deltaPct / 100
  switch (factor) {
    case 'fx':
      // CNY 가 강해지면 한국 원가 상승 → supplier_krw 가 k 배
      return { ...base, supplier: base.supplier * k }
    case 'duty':
      return { ...base, duty: base.duty * k }
    case 'supplier':
      return { ...base, supplier: base.supplier * k }
    case 'shipping':
      return { ...base, shipping: base.shipping * k }
  }
}

function findBep(base: Inputs, factor: StressFactor): number | null {
  // 양/음의 방향으로 1% 씩 200% 까지 스캔 — 마진 부호가 뒤집히는 첫 지점.
  const baseMargin = computeMargin(base)
  if (baseMargin <= 0) return 0 // 이미 음수면 BEP=0
  for (let d = 1; d <= 200; d++) {
    // 인자별로 '악화 방향'을 정의: fx/supplier/shipping/duty 모두 + 증가가 마진 악화.
    const m = computeMargin(applyShock(base, factor, d))
    if (m <= 0) return d
  }
  return null
}

export function computeStress(input: PinStressInputs): StressResult {
  const selling = Number(input.selling_price_krw_est ?? 0)
  const supplier = Number(input.supplier_price_krw ?? 0)
  const duty = Number(input.duty_rate_percent ?? 0)
  const vat = Number(input.vat_rate_percent ?? 10)
  const shipping = Number(input.shipping_krw ?? 0)
  const handling = Number(input.handling_krw ?? 0)
  const fx = Number(input.cny_krw ?? 0)

  const skeleton: StressResult = {
    product_id: input.product_id,
    name: input.name ?? '(이름 없음)',
    category_top: input.category_top,
    selling_price_krw: selling,
    supplier_price_krw: supplier,
    base_margin_krw: 0,
    base_margin_pct: 0,
    points: [],
    bep: { fx: null, duty: null, supplier: null, shipping: null },
    resilience: 'unknown',
    computable: false,
  }

  if (!supplier || supplier <= 0 || !selling || selling <= 0) {
    return { ...skeleton, reason: '도매가 또는 추정 판매가가 없음' }
  }

  const base: Inputs = { selling, supplier, duty, vat, shipping, handling, fx }
  const baseMargin = computeMargin(base)
  const baseMarginPct = (baseMargin / selling) * 100

  const deltas = [-20, -10, -5, 5, 10, 20]
  const factors: StressFactor[] = ['fx', 'duty', 'supplier', 'shipping']
  const points: StressPoint[] = []
  for (const f of factors) {
    for (const d of deltas) {
      const shocked = computeMargin(applyShock(base, f, d))
      points.push({
        factor: f,
        delta_pct: d,
        margin_krw: shocked,
        margin_pct: (shocked / selling) * 100,
        delta_from_base_krw: shocked - baseMargin,
      })
    }
  }

  const bep: Record<StressFactor, number | null> = {
    fx: findBep(base, 'fx'),
    duty: findBep(base, 'duty'),
    supplier: findBep(base, 'supplier'),
    shipping: findBep(base, 'shipping'),
  }

  // 등급 산정:
  //   strong  = 모든 인자 ±10% 에서 마진 양수
  //   fragile = 한 인자라도 ±5% 에서 마진 음수
  //   else    = normal
  let strong = true
  let fragile = false
  for (const f of factors) {
    for (const d of [5, 10]) {
      const m = computeMargin(applyShock(base, f, d))
      if (m <= 0) {
        strong = false
        if (d === 5) fragile = true
      }
    }
  }
  const resilience: StressResult['resilience'] =
    baseMargin <= 0 ? 'fragile' : fragile ? 'fragile' : strong ? 'strong' : 'normal'

  return {
    ...skeleton,
    base_margin_krw: baseMargin,
    base_margin_pct: baseMarginPct,
    points,
    bep,
    resilience,
    computable: true,
  }
}

export function resilienceBadge(r: StressResult['resilience']): { label: string; cls: string } {
  switch (r) {
    case 'strong':
      return { label: '내성↑', cls: 'bg-green-100 text-green-800 border-green-300' }
    case 'normal':
      return { label: '보통', cls: 'bg-gray-100 text-gray-700 border-gray-300' }
    case 'fragile':
      return { label: '취약', cls: 'bg-red-100 text-red-800 border-red-300' }
    default:
      return { label: '계산불가', cls: 'bg-yellow-50 text-yellow-700 border-yellow-300' }
  }
}
