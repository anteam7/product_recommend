// 클라이언트 헬퍼: 부가서비스 토글 합산, 정렬, 포맷
// 서버 호출 없이 즉시 반응하는 토글/정렬 계산을 담당.

import type {
  ForwarderRecommendation,
  ServiceOption,
  SearchResult,
  EstimateResponse,
} from './types'

export type SelectedServices = Record<string /* forwarder_id */, Set<string /* service_id */>>

export function totalForForwarder(
  fw: ForwarderRecommendation,
  selected: Set<string> | undefined,
): number {
  if (!selected || selected.size === 0) return fw.base_price_krw
  let sum = fw.base_price_krw
  for (const s of fw.available_services) {
    if (selected.has(s.id) && s.is_simple && typeof s.price_krw === 'number') {
      sum += s.price_krw
    }
  }
  return sum
}

export type SortKey = 'base_price' | 'total_with_services'

export function sortForwarders(
  forwarders: ForwarderRecommendation[],
  selected: SelectedServices,
  key: SortKey,
): ForwarderRecommendation[] {
  if (key === 'base_price') {
    return [...forwarders].sort((a, b) => a.base_price_krw - b.base_price_krw)
  }
  return [...forwarders].sort(
    (a, b) =>
      totalForForwarder(a, selected[a.forwarder_id]) -
      totalForForwarder(b, selected[b.forwarder_id]),
  )
}

export function formatKrw(n: number): string {
  return `₩${n.toLocaleString('ko-KR')}`
}

export function formatKg(n: number): string {
  return `${n.toFixed(2)}kg`
}

// 부가서비스 표시: 단순 가격은 토글, 복잡은 정보용
export function partitionServices(services: ServiceOption[]): {
  toggleable: ServiceOption[]
  informational: ServiceOption[]
} {
  const toggleable: ServiceOption[] = []
  const informational: ServiceOption[] = []
  for (const s of services) {
    if (s.is_simple) toggleable.push(s)
    else informational.push(s)
  }
  return { toggleable, informational }
}

// fetch wrappers
export async function searchTaxonomy(q: string): Promise<SearchResult[]> {
  const url = q.trim()
    ? `/api/recommend/search?q=${encodeURIComponent(q.trim())}`
    : '/api/recommend/search'
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) return []
  const data = (await res.json()) as { results?: SearchResult[] }
  return data.results ?? []
}

export type EstimateRequestBody = {
  items: Array<{
    label_ko: string
    category_tag: string
    brand: string | null
    pcs: number
    unit_value_usd?: number | null
  }>
  country?: 'US' | 'JP' | 'CN' | null
  shipping_mode?: 'air' | 'sea' | null
  member_grade_level?: number
  local_shipping_usd?: number | null
}

export async function estimateCart(body: EstimateRequestBody): Promise<EstimateResponse | { error: string }> {
  const res = await fetch('/api/recommend/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const data = (await res.json()) as EstimateResponse | { error: string }
  return data
}

// 카트 아이템 (페이지 로컬 상태)
export type CartItem = {
  key: string // 고유 ID (브라우저 내부 식별)
  label_ko: string
  category_tag: string
  brand: string | null
  pcs: number
  icon_emoji: string | null
  default_country: 'US' | 'JP' | 'CN' | null
  unit_value_usd: number | null // 사용자 입력 (관부가세 계산용, 선택)
}

export function newCartKey(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// SearchResult → CartItem 변환
export function searchResultToCartItem(r: SearchResult, pcs = 1): CartItem | null {
  if (!r.category_tag) return null
  return {
    key: newCartKey(),
    label_ko: r.label_ko,
    category_tag: r.category_tag,
    brand: r.brand_canonical,
    pcs,
    icon_emoji: r.icon_emoji,
    default_country: r.default_country,
    unit_value_usd: null,
  }
}

export const COUNTRY_LABEL: Record<'US' | 'JP' | 'CN', string> = {
  US: '🇺🇸 미국',
  JP: '🇯🇵 일본',
  CN: '🇨🇳 중국',
}

export const MODE_LABEL: Record<'air' | 'sea', string> = {
  air: '✈️ 항공',
  sea: '🚢 항운',
}

export const CONFIDENCE_LABEL: Record<'high' | 'mid' | 'low', { ko: string; emoji: string; tone: string }> = {
  high: { ko: '높음', emoji: '⭐⭐⭐', tone: 'text-emerald-600' },
  mid:  { ko: '보통', emoji: '⭐⭐',   tone: 'text-amber-600' },
  low:  { ko: '낮음', emoji: '⭐',     tone: 'text-rose-600' },
}
