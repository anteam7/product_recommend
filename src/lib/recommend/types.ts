// /recommend 시뮬레이터 공유 타입
// API ↔ 클라이언트 양쪽에서 사용

export type Country = 'US' | 'JP' | 'CN'
export type ShippingMode = 'air' | 'sea' // shipping_rates 컬럼명 그대로
export type Confidence = 'high' | 'mid' | 'low'

// 자동완성 결과
// kind 의미:
//   'category'       — 카테고리 매핑 (예: "청바지" → 의류)
//   'brand'          — 브랜드 자체 (카테고리 미정. 카테고리 조합이 없을 때만 노출)
//   'ip'             — IP/캐릭터 (브랜드와 동일 처리)
//   'brand_category' — 브랜드 × 카테고리 조합 (예: "나이키 신발", n=3) ← 클릭 권장 항목
export type SearchResult = {
  kind: 'category' | 'brand' | 'ip' | 'brand_category'
  label_ko: string
  label_en: string | null
  category_tag: string | null
  brand_canonical: string | null
  default_country: Country | null
  icon_emoji: string | null
  sample_n: number | null // 매니페스트 표본 수 (있으면 ⭐⭐⭐ 표시)
  weight_median_kg: number | null // 미리보기용 (개당 중앙값)
}

// 카트 항목 (사용자 입력)
export type CartItemInput = {
  label_ko: string // 사용자에게 보이는 텍스트 (의류, 나이키, ...)
  category_tag: string // CLOTHES, NUTRITIONAL PRODUCTS, ...
  brand: string | null // 'Nike', 'Carhartt' (없으면 카테고리 전체 분포)
  pcs: number
  unit_value_usd?: number | null // 관부가세 계산용 (선택)
}

// 카트 항목별 추정 결과
export type CartItemEstimate = {
  input: CartItemInput
  weight_per_pc_kg: { p25: number; median: number; p75: number } | null
  sample_n: number
  confidence: Confidence
  matched_source: 'category_brand_country' | 'category_brand' | 'category_country' | 'category_only' | 'no_match'
}

// 부가서비스 옵션
export type ServiceOption = {
  id: string
  category: string // '합배송' | '검수' | '포장' | ...
  service_name: string
  price_krw: number | null
  price_text: string | null
  is_simple: boolean // true = 고정가, 토글 가능 / false = 별도 문의 등 정보용
}

// 배대지별 추천 결과
export type ForwarderRecommendation = {
  forwarder_id: string
  slug: string
  name: string
  logo_url: string | null
  country: Country
  shipping_type: ShippingMode
  center_name: string | null
  weight_bracket: { min: number; max: number }
  base_price_krw: number
  member_grade: string
  grade_level: number
  available_services: ServiceOption[]
}

// 카트 전체 추정
export type CartEstimate = {
  items: CartItemEstimate[]
  total_weight_kg: { p25: number; median: number; p75: number }
  confidence: Confidence
}

// estimate API 응답
export type EstimateResponse = {
  cart: CartEstimate
  recommended_country: Country | null
  recommended_mode: ShippingMode
  forwarders: ForwarderRecommendation[]
  duty: DutyResponse | null // 사용자 가격 입력 시만 채워짐
  notes: string[]
}

export type DutyCategoryBreakdown = {
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

export type DutyResponse = {
  has_value_input: boolean
  total_value_usd: number
  total_value_krw: number
  local_shipping_usd: number
  local_shipping_krw: number
  cif_usd: number
  cif_krw: number
  threshold_usd: number
  threshold_reason: string
  is_over_threshold: boolean
  excluded_categories: string[]
  by_category: DutyCategoryBreakdown[]
  total_duty_krw: number
  total_excise_krw: number
  total_vat_krw: number
  total_tax_krw: number
  notes: string[]
  usd_to_krw: number
}

// estimate API 요청
export type EstimateRequest = {
  items: CartItemInput[]
  country?: Country | null
  shipping_mode?: ShippingMode | null // 사용자가 명시적으로 'sea'/'air' 선택 가능
  member_grade_level?: number // 기본 1
  local_shipping_usd?: number | null // 현지 배송비 (사이트 → 배대지)
}
