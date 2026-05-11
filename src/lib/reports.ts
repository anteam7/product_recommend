export const REPORT_TARGET_TYPES = [
  'forwarder',
  'rate',
  'center',
  'service',
  'blog_post',
  'deal',
  'exchange_rate',
  'other',
] as const
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number]

export const REPORT_REASON_CATEGORIES = [
  { value: 'price_error', label: '요금·수수료 오류' },
  { value: 'address_error', label: '주소·연락처 오류' },
  { value: 'service_error', label: '서비스 내용 오류' },
  { value: 'expired', label: '기간·만료 오류' },
  { value: 'broken_link', label: '링크 깨짐' },
  { value: 'other', label: '기타' },
] as const
export type ReportReasonCategory = (typeof REPORT_REASON_CATEGORIES)[number]['value']

export const REPORT_STATUSES = [
  'pending',
  'in_review',
  'resolved',
  'rejected',
  'duplicate',
  'spam',
] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export type Report = {
  id: string
  target_type: ReportTargetType
  target_slug: string | null
  target_id: string | null
  target_url: string
  reason_category: string
  description: string
  correct_info: string | null
  source_url: string | null
  reporter_email: string | null
  reporter_ip: string
  reporter_ua: string | null
  status: ReportStatus
  admin_note: string | null
  admin_action_label: string | null
  diff_summary: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

export type PublicResolvedReport = {
  id: string
  admin_action_label: string | null
  diff_summary: string | null
  resolved_at: string
}

export function reasonLabel(value: string): string {
  return REPORT_REASON_CATEGORIES.find((r) => r.value === value)?.label ?? value
}

export function statusLabel(status: ReportStatus): string {
  switch (status) {
    case 'pending':
      return '대기'
    case 'in_review':
      return '검토중'
    case 'resolved':
      return '정정 완료'
    case 'rejected':
      return '기각'
    case 'duplicate':
      return '중복'
    case 'spam':
      return '스팸'
  }
}
