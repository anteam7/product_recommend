'use client'

import { track, ANALYTICS_EVENTS } from '@/lib/analytics'

type Props = {
  href: string
  /** 배대지 slug or 블로그 slug 등 컨텍스트 식별자 */
  context?: string
  /** 유출 경로 분류 (예: 'forwarder_detail_hero', 'blog_reference') */
  source?: string
  className?: string
  children: React.ReactNode
  title?: string
}

/**
 * 외부 사이트로 나가는 링크. 클릭 시 external_site_click 이벤트 발사.
 */
export default function ExternalLink({ href, context, source, className, children, title }: Props) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={className}
      onClick={() => {
        track(ANALYTICS_EVENTS.EXTERNAL_SITE_CLICK, {
          href,
          context: context ?? '',
          source: source ?? '',
        })
      }}
    >
      {children}
    </a>
  )
}
