'use client'

import Link from 'next/link'
import { track, ANALYTICS_EVENTS } from '@/lib/analytics'

type Props = {
  slug: string
  href: string
  /** 어디서 클릭했는지 (list · home · compare · related 등) */
  source?: string
  className?: string
  children: React.ReactNode
}

/**
 * 배대지 카드 링크 래퍼. 클릭 시 forwarder_card_click 이벤트 발사.
 * 내부 링크이므로 next/link 사용.
 */
export default function ForwarderCardLink({ slug, href, source, className, children }: Props) {
  return (
    <Link
      href={href}
      className={className}
      onClick={() => {
        track(ANALYTICS_EVENTS.FORWARDER_CARD_CLICK, {
          slug,
          href,
          source: source ?? '',
        })
      }}
    >
      {children}
    </Link>
  )
}
