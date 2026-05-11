import Link from 'next/link'
import type { CurrencyRates } from '@/lib/current-rates'
import { formatRateDate } from '@/lib/current-rates'

type Props = {
  rates: CurrencyRates
  variant?: 'compact' | 'banner'
  className?: string
}

/**
 * "실시간 환율 반영" 알림. 클릭 시 /exchange-rates 로 이동.
 * compact: 작은 pill 배지
 * banner: 본문 상단 띠 형태
 */
export default function RealTimeRateBadge({ rates, variant = 'compact', className = '' }: Props) {
  const date = formatRateDate(rates.updated_at)

  if (variant === 'banner') {
    return (
      <Link
        href="/exchange-rates"
        className={`group block bg-gradient-to-r from-blue-50 via-sky-50 to-blue-50 border border-blue-100 rounded-lg px-4 py-3 hover:border-blue-300 transition-colors ${className}`}
      >
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-600"></span>
            </span>
            <div>
              <p className="text-sm font-semibold text-gray-900">
                실시간 환율로 배송비를 계산합니다
              </p>
              <p className="text-xs text-gray-600 mt-0.5">
                네이버 금융 매매기준율 · 매일 자동 갱신 · 오늘 1 USD = {rates.USD.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원 · 100 JPY = {(rates.JPY * 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원 ({date} 기준)
              </p>
            </div>
          </div>
          <span className="text-xs text-blue-700 font-medium group-hover:underline whitespace-nowrap">
            환율 동향 →
          </span>
        </div>
      </Link>
    )
  }

  return (
    <Link
      href="/exchange-rates"
      className={`inline-flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-full px-3 py-1 text-xs text-blue-900 hover:bg-blue-100 transition-colors ${className}`}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600"></span>
      </span>
      <span>
        실시간 환율 · 1 USD = {rates.USD.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원 ({date})
      </span>
      <span className="text-blue-600">→</span>
    </Link>
  )
}
