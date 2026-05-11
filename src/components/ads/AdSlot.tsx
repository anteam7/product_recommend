'use client'

import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    adsbygoogle?: unknown[]
  }
}

type AdSlotProps = {
  /** AdSense 슬롯 ID (ca-pub-xxx 의 슬롯 단위 ID) */
  slot?: string
  /** 'auto' | 'horizontal' | 'vertical' | 'rectangle' */
  format?: 'auto' | 'horizontal' | 'vertical' | 'rectangle'
  /** 반응형 여부 */
  responsive?: boolean
  /** CSS class */
  className?: string
  /** min-height (레이아웃 shift 방지) */
  minHeight?: number
  /** 테스트용 라벨 (광고 없을 때 표시할지 여부) */
  debugLabel?: string
}

/**
 * Google AdSense 광고 슬롯.
 *
 * - NEXT_PUBLIC_ADSENSE_CLIENT env가 없으면 아무것도 렌더링하지 않음 (AdSense 미승인 상태 대응)
 * - 승인 후 env만 채우면 자동으로 광고 노출
 */
export default function AdSlot({
  slot,
  format = 'auto',
  responsive = true,
  className = '',
  minHeight = 100,
  debugLabel,
}: AdSlotProps) {
  const ref = useRef<HTMLModElement>(null)
  const client = process.env.NEXT_PUBLIC_ADSENSE_CLIENT
  const enabled = !!client && !!slot

  useEffect(() => {
    if (!enabled) return
    try {
      ;(window.adsbygoogle = window.adsbygoogle || []).push({})
    } catch {
      // 스크립트 로드 실패 시 조용히 무시
    }
  }, [enabled])

  if (!enabled) {
    if (process.env.NODE_ENV === 'development' && debugLabel) {
      return (
        <div
          className={`border border-dashed border-gray-300 rounded bg-gray-50 text-center text-xs text-gray-400 flex items-center justify-center ${className}`}
          style={{ minHeight }}
        >
          광고 슬롯 (dev) · {debugLabel}
        </div>
      )
    }
    return null
  }

  return (
    <div className={`my-4 text-center ${className}`} style={{ minHeight }}>
      <ins
        ref={ref}
        className="adsbygoogle block"
        style={{ display: 'block', minHeight }}
        data-ad-client={client}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive={responsive ? 'true' : 'false'}
      />
    </div>
  )
}
