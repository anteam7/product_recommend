// 관부가세 계산 — 순수 함수
//
// 한국 관세청 / 관세법 시행령 기준 (2026-04-27 리서치).
// 면세한도:
//   - 미국 항공 특송: $200 (한미 FTA)
//   - 그 외 / 목록통관 배제 품목: $150
// 계산식:
//   관세 = 카테고리별 (가격 × 세율%)
//   부가세 = (카트 가격 + 관세 + 개별소비세) × 10%
//   * 운송료는 v1에서 부가세 과세표준 미포함 (단순화)
//
// 면책: 본 계산은 일반 가이드 기준 추정치.
// 실제 부과액은 통관 시 결정되며 차이가 있을 수 있음.

export type Country = 'US' | 'JP' | 'CN'
export type ShippingMode = 'air' | 'sea'

export type DutyRow = {
  category_tag: string
  label_ko: string
  duty_rate_percent: number
  vat_rate_percent: number
  excise_rate_percent: number | null
  excise_threshold_krw: number | null
  personal_use_limit: number | null
  personal_use_limit_unit: string | null
  excluded_from_list_clearance: boolean
  source: string | null
  notes: string | null
}

export type CartItemForDuty = {
  category_tag: string
  pcs: number
  unit_value_usd: number | null
}

export type CategoryDutyBreakdown = {
  category_tag: string
  label_ko: string
  value_usd: number
  value_krw: number
  duty_krw: number
  excise_krw: number
  duty_rate_percent: number
  is_personal_use_exceeded: boolean
  personal_use_note: string | null
}

export type DutyEstimate = {
  has_value_input: boolean // 사용자가 가격을 1개라도 입력했는지
  total_value_usd: number // 상품가 합계
  total_value_krw: number
  local_shipping_usd: number // 현지 배송비 (사이트 → 배대지)
  local_shipping_krw: number
  cif_usd: number // 면세한도 검사·부가세 과세표준 (상품가 + 현지 배송비)
  cif_krw: number
  threshold_usd: number // 적용된 면세한도
  threshold_reason: string // 'fta_us_air' | 'standard_150' | 'excluded_categories'
  is_over_threshold: boolean
  excluded_categories: string[] // 목록통관 배제 카테고리 (label_ko)
  by_category: CategoryDutyBreakdown[]
  total_duty_krw: number
  total_excise_krw: number
  total_vat_krw: number
  total_tax_krw: number
  notes: string[]
}

export function determineThresholdUsd(args: {
  country: Country
  shipping_mode: ShippingMode
  hasExcludedCategory: boolean
}): { threshold: number; reason: string } {
  if (args.hasExcludedCategory) {
    return { threshold: 150, reason: 'excluded_categories' }
  }
  if (args.country === 'US' && args.shipping_mode === 'air') {
    return { threshold: 200, reason: 'fta_us_air' }
  }
  return { threshold: 150, reason: 'standard_150' }
}

export function calculateDuty(args: {
  items: CartItemForDuty[]
  rates: DutyRow[]
  country: Country
  shipping_mode: ShippingMode
  usdToKrw: number
  localShippingUsd?: number | null // 현지 배송비 (사이트 → 배대지)
}): DutyEstimate {
  const { items, rates, country, shipping_mode, usdToKrw } = args
  const ratesByCat = new Map<string, DutyRow>()
  for (const r of rates) ratesByCat.set(r.category_tag, r)

  // 항목별 가격 (입력 안 된 건 0 취급)
  const itemsWithValue = items.map((it) => ({
    ...it,
    value_usd: it.unit_value_usd != null && it.unit_value_usd > 0 ? it.unit_value_usd * it.pcs : 0,
  }))
  const has_value_input = itemsWithValue.some((it) => it.value_usd > 0)
  const total_value_usd = itemsWithValue.reduce((s, it) => s + it.value_usd, 0)
  const total_value_krw = Math.round(total_value_usd * usdToKrw)

  // 현지 배송비
  const local_shipping_usd =
    args.localShippingUsd != null && args.localShippingUsd > 0 ? args.localShippingUsd : 0
  const local_shipping_krw = Math.round(local_shipping_usd * usdToKrw)

  // CIF (면세한도 검사·부가세 과세표준 기준)
  // 한국 관세: 면세한도 = 상품가 + 현지운임 + 보험료
  //           관세 = 상품가 × 세율 (운임 미포함)
  //           부가세 = (CIF + 관세 + 개별소비세) × 10%
  const cif_usd = total_value_usd + local_shipping_usd
  const cif_krw = Math.round(cif_usd * usdToKrw)

  // 카테고리별 합산
  const byCatMap = new Map<string, { value_usd: number; pcs: number }>()
  for (const it of itemsWithValue) {
    const cur = byCatMap.get(it.category_tag) ?? { value_usd: 0, pcs: 0 }
    cur.value_usd += it.value_usd
    cur.pcs += it.pcs
    byCatMap.set(it.category_tag, cur)
  }

  // 목록통관 배제 카테고리 검사
  const excluded_categories: string[] = []
  for (const cat of byCatMap.keys()) {
    const r = ratesByCat.get(cat)
    if (r?.excluded_from_list_clearance) {
      excluded_categories.push(r.label_ko)
    }
  }

  // 면세한도 결정
  const { threshold, reason } = determineThresholdUsd({
    country,
    shipping_mode,
    hasExcludedCategory: excluded_categories.length > 0,
  })

  // 면세한도 검사는 CIF (상품가 + 현지 배송비) 기준
  const is_over_threshold = has_value_input && cif_usd > threshold

  // 카테고리별 관세 계산
  const by_category: CategoryDutyBreakdown[] = []
  let total_duty_krw = 0
  let total_excise_krw = 0
  const notes: string[] = []

  for (const [catTag, agg] of byCatMap) {
    const r = ratesByCat.get(catTag)
    const value_krw = Math.round(agg.value_usd * usdToKrw)

    let duty_krw = 0
    let excise_krw = 0
    let is_personal_use_exceeded = false
    let personal_use_note: string | null = null

    if (r) {
      // 자가사용 한도 검사 (영양제 6병 등)
      if (r.personal_use_limit && agg.pcs > r.personal_use_limit) {
        is_personal_use_exceeded = true
        personal_use_note = `자가사용 ${r.personal_use_limit}${r.personal_use_limit_unit ?? ''} 한도 초과 (${agg.pcs}${r.personal_use_limit_unit ?? ''})`
      }

      // 면세초과 시 관세 부과 (또는 자가사용 한도 초과)
      const should_charge = is_over_threshold || is_personal_use_exceeded
      if (should_charge && agg.value_usd > 0) {
        duty_krw = Math.round((value_krw * r.duty_rate_percent) / 100)
        // 개별소비세 (시계 등 luxury)
        if (
          r.excise_rate_percent &&
          r.excise_threshold_krw &&
          value_krw > r.excise_threshold_krw
        ) {
          excise_krw = Math.round((value_krw * r.excise_rate_percent) / 100)
        }
      }
    }

    by_category.push({
      category_tag: catTag,
      label_ko: r?.label_ko ?? catTag,
      value_usd: Math.round(agg.value_usd * 100) / 100,
      value_krw,
      duty_krw,
      excise_krw,
      duty_rate_percent: r?.duty_rate_percent ?? 0,
      is_personal_use_exceeded,
      personal_use_note,
    })
    total_duty_krw += duty_krw
    total_excise_krw += excise_krw
  }

  // 부가세 = (CIF + 관세 + 개별소비세) × 10%
  // CIF = 상품가 + 현지 배송비. 한국 배대지 운임은 별도 신고라 v1에서 미반영.
  const vat_base = cif_krw + total_duty_krw + total_excise_krw
  const total_vat_krw =
    is_over_threshold || by_category.some((b) => b.is_personal_use_exceeded)
      ? Math.round(vat_base * 0.1)
      : 0
  const total_tax_krw = total_duty_krw + total_excise_krw + total_vat_krw

  // notes
  if (excluded_categories.length > 0) {
    notes.push(
      `${excluded_categories.join(', ')} 는 목록통관 배제 품목 → 국가 무관 $150 면세 한도가 적용됩니다.`,
    )
  }
  if (is_over_threshold) {
    const breakdown =
      local_shipping_usd > 0
        ? ` (상품 $${total_value_usd.toFixed(2)} + 현지배송 $${local_shipping_usd.toFixed(2)})`
        : ''
    notes.push(
      `상품가+현지배송비 합계 $${cif_usd.toFixed(2)}${breakdown} 가 면세한도 $${threshold} 를 초과합니다.`,
    )
  }
  for (const b of by_category) {
    if (b.personal_use_note) notes.push(`${b.label_ko}: ${b.personal_use_note}`)
  }
  if (has_value_input) {
    notes.push('본 추정은 일반 간이세율/일반관세 기준입니다. 실제 부과액은 통관 시 결정됩니다.')
  }

  return {
    has_value_input,
    total_value_usd: Math.round(total_value_usd * 100) / 100,
    total_value_krw,
    local_shipping_usd: Math.round(local_shipping_usd * 100) / 100,
    local_shipping_krw,
    cif_usd: Math.round(cif_usd * 100) / 100,
    cif_krw,
    threshold_usd: threshold,
    threshold_reason: reason,
    is_over_threshold,
    excluded_categories,
    by_category,
    total_duty_krw,
    total_excise_krw,
    total_vat_krw,
    total_tax_krw,
    notes,
  }
}
