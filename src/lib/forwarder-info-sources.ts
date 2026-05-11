export const INFO_SOURCE_TYPES = ['rates', 'services', 'notice', 'faq', 'other'] as const
export type InfoSourceType = (typeof INFO_SOURCE_TYPES)[number]

export const INFO_SOURCE_TYPE_LABELS: Record<InfoSourceType, string> = {
  rates: '배송비',
  services: '부가서비스',
  notice: '공지사항',
  faq: 'FAQ',
  other: '기타',
}

export type ForwarderInfoSource = {
  id: string
  forwarder_id: string
  source_type: InfoSourceType
  url: string
  label: string | null
  notes: string | null
  display_order: number
  is_active: boolean
  last_fetched_at: string | null
  last_fetch_status: string | null
  created_at: string
  updated_at: string
  created_by: string | null
}

export type InfoSourceInput = {
  source_type: InfoSourceType
  url: string
  label?: string | null
  notes?: string | null
  display_order?: number
  is_active?: boolean
}

export function isInfoSourceType(v: unknown): v is InfoSourceType {
  return typeof v === 'string' && (INFO_SOURCE_TYPES as readonly string[]).includes(v)
}
