/**
 * "요금 마지막 확인일" 미니 배지.
 * 확인일이 7일 이내면 녹색, 30일 이내면 호박색, 그 이상이면 회색.
 * 신뢰도 신호(AdSense E-E-A-T)로 각 배대지 카드·상세 헤더에 노출.
 */
export default function LastVerifiedBadge({
  at,
  size = 'sm',
  className = '',
}: {
  at: string | null | undefined
  size?: 'xs' | 'sm' | 'md'
  className?: string
}) {
  if (!at) return null
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null

  const diffMs = Date.now() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  let label: string
  if (diffDays < 1) label = '오늘 확인'
  else if (diffDays < 7) label = `${diffDays}일 전 확인`
  else {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    label = `${y}-${m}-${d} 확인`
  }

  const tone =
    diffDays <= 7
      ? 'bg-green-50 text-green-700 border-green-200'
      : diffDays <= 30
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-gray-50 text-gray-600 border-gray-200'

  const sizeCls =
    size === 'xs'
      ? 'text-[10px] px-1.5 py-0.5'
      : size === 'md'
      ? 'text-sm px-2.5 py-1'
      : 'text-xs px-2 py-0.5'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${tone} ${sizeCls} ${className}`}
      title={`마지막 요금 확인: ${date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`}
    >
      <svg
        className={size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      {label}
    </span>
  )
}
