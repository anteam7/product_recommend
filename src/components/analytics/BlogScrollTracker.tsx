'use client'

import { useEffect, useRef } from 'react'
import { track, ANALYTICS_EVENTS } from '@/lib/analytics'

/**
 * 블로그 상세 페이지에 삽입.
 * 문서 스크롤이 50%를 처음 넘는 순간 blog_read_50 이벤트 한 번 발사.
 */
export default function BlogScrollTracker({ slug, title }: { slug: string; title: string }) {
  const firedRef = useRef(false)

  useEffect(() => {
    function onScroll() {
      if (firedRef.current) return
      const docHeight = document.documentElement.scrollHeight - window.innerHeight
      if (docHeight <= 0) return
      const ratio = window.scrollY / docHeight
      if (ratio >= 0.5) {
        firedRef.current = true
        track(ANALYTICS_EVENTS.BLOG_READ_50, { slug, title })
        window.removeEventListener('scroll', onScroll)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [slug, title])

  return null
}
