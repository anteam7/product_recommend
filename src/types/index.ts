export interface Forwarder {
  id: string
  name: string
  slug: string
  website: string | null
  /** 공식 후기 게시판 URL (메인 사이트와 별도). 자동생성 supabase 타입에 아직 없어 optional. */
  official_reviews_url?: string | null
  logo_url: string | null
  description: string | null
  pros: string[] | null
  cons: string[] | null
  features: string[] | null
  is_active: boolean
  created_at: string
}

export interface ShippingRate {
  id: string
  forwarder_id: string
  country: string
  center_name: string | null
  weight_min: number
  weight_max: number
  weight_unit: 'kg' | 'lb' | 'lbs' | null
  price_krw: number | null
  price_usd: number | null
  price_jpy: number | null
  price_cny: number | null
  shipping_type: string
  service_label: string | null
  member_grade: string
  grade_level: number | null
  source: 'manual' | 'json_import' | 'ai_extract' | null
  updated_at: string
}

export interface AdditionalService {
  id: string
  forwarder_id: string
  category: string
  service_name: string
  price_text: string | null
  price_numeric: number | null
  price_currency: 'KRW' | 'USD' | 'JPY' | null
  price_unit: string | null
  description: string | null
  conditions: string | null
  display_order: number
  is_active: boolean
  source: 'manual' | 'json_import' | null
  updated_at: string
}

export const SERVICE_CATEGORIES = [
  '검수', '포장', '합배송', '보관', '통관', '반송',
  '보험', '검역', '수출신고', '폐기', '구매대행', '배송변경', '알림', '기타',
] as const
export type ServiceCategory = typeof SERVICE_CATEGORIES[number]

export interface Center {
  id: string
  forwarder_id: string
  country: string
  country_name: string | null
  center_name: string | null
  address: string | null
  shipping_type: string | null
  min_weight: number | null
  storage_days: number
  state: string | null
  is_tax_free: boolean
  special_benefit: string | null
  lat: number | null
  lng: number | null
}

export interface MemberGradeDefinition {
  id: string
  forwarder_id: string
  grade_name: string
  grade_level: 1 | 2 | 3
  discount_percent: number
  min_shipments: number | null
  description: string | null
}

export interface ForwarderWithRates extends Forwarder {
  shipping_rates: ShippingRate[]
}

export interface CalculatorResult {
  forwarder: Forwarder
  rate: ShippingRate | null
  price: number | null
  isUniformPricing?: boolean
  alternatives?: { rate: ShippingRate; price: number }[]
}

export type Country = 'US' | 'JP' | 'CN'
export type ShippingType = 'air' | 'sea'
export type GradeLevel = 1 | 2 | 3

export const COUNTRIES: { code: Country; name: string; flag: string }[] = [
  { code: 'US', name: '미국', flag: '🇺🇸' },
  { code: 'JP', name: '일본', flag: '🇯🇵' },
  { code: 'CN', name: '중국', flag: '🇨🇳' },
]

export const WEIGHT_STEPS = [
  0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20
]

export type ReviewTone = '긍정' | '중립' | '부정' | '혼재'
export type ReviewSentiment = '긍정 우세' | '혼재' | '부정 우세' | '데이터 없음'
export type ReviewDataAvailability = 'full' | 'limited' | 'none'

export interface ForwarderReview {
  id: string
  forwarder_id: string
  country: Country
  review_date: string | null
  url: string | null
  platform: string | null
  summary: string
  tone: ReviewTone
  keywords: string[]
  is_hidden: boolean
  source: 'collected' | 'manual'
  created_at: string
  updated_at: string
}

export interface ForwarderReviewSummary {
  forwarder_id: string
  country: Country
  review_count: number
  overall_sentiment: ReviewSentiment | null
  notable_issues: string | null
  data_availability: ReviewDataAvailability
  data_availability_note: string | null
  collected_at: string | null
  created_at: string
  updated_at: string
}
