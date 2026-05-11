export type ShippingType = 'air' | 'marine' | 'express' | 'unknown'

export type ParsedRate = {
  country: string              // ISO-2, e.g. 'US' / 'JP' / 'CN' / 'EU' / 'HK'
  center_name: string | null   // 'CA', 'NJ', 'OR' or null
  weight_min: number
  weight_max: number
  weight_unit: 'kg' | 'lb'
  price_krw: number | null
  price_usd: number | null
  price_jpy: number | null
  price_cny: number | null
  price_eur: number | null
  shipping_type: ShippingType
  service_label: string | null   // '일반', 'The빠른', 'OR Express' 등
  member_grade: string           // '일반' / 'VIP' / 'VVIP' 등 (기본 '일반')
  grade_level: number            // 1=기본, 2/3=상위
}

export type FetchResultStatus = 'ok' | 'partial' | 'error'

export type FetchResult = {
  forwarder_id: string
  forwarder_slug: string
  source_id: string | null
  source_url: string
  status: FetchResultStatus
  rates: ParsedRate[]
  raw_snapshot: string | null   // 원문 HTML/JSON (디버깅용, 길이 제한 없음 — TEXT 컬럼)
  error_message: string | null
  duration_ms: number
  countries: string[]
}

export type FetcherContext = {
  forwarder_id: string
  forwarder_slug: string
  source_id: string | null
  source_url: string
  source_label: string | null
  source_notes: string | null
}

export type RateFetcher = (ctx: FetcherContext) => Promise<{
  rates: ParsedRate[]
  raw_snapshot: string
}>
