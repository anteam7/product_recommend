'use client'

import { usePathname } from 'next/navigation'
import ReportButton from './ReportButton'
import type { ReportTargetType } from '@/lib/reports'

const HIDE_PREFIXES = ['/admin', '/login', '/privacy', '/terms']

/**
 * 전역 floating "정보 정정 요청" 버튼. 관리자·로그인·정책 페이지에서는 숨김.
 * target_type은 URL prefix로 추정. 구체적 target이 있는 페이지는 별도 inline 버튼을 쓰는 편이 낫음.
 */
export default function GlobalReportButton() {
  const pathname = usePathname() ?? ''

  if (HIDE_PREFIXES.some((p) => pathname.startsWith(p))) return null

  const { targetType, targetSlug } = inferTarget(pathname)

  return (
    <ReportButton
      mode="floating"
      targetType={targetType}
      targetSlug={targetSlug}
    />
  )
}

function inferTarget(pathname: string): {
  targetType: ReportTargetType
  targetSlug?: string
} {
  const segs = pathname.split('/').filter(Boolean)
  if (segs[0] === 'forwarders' && segs[1]) {
    return { targetType: 'forwarder', targetSlug: segs[1] }
  }
  if (segs[0] === 'blog' && segs[1]) {
    return { targetType: 'blog_post', targetSlug: segs[1] }
  }
  if (segs[0] === 'deals') {
    return { targetType: 'deal' }
  }
  if (segs[0] === 'exchange-rates') {
    return { targetType: 'exchange_rate' }
  }
  return { targetType: 'other' }
}
