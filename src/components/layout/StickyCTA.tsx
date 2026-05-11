'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const HIDE_PREFIXES = ['/admin', '/login', '/compare']
const HIDE_EXACT = ['/', '/calculator']
const SCROLL_THRESHOLD = 400

/**
 * 모바일 전용 하단 고정 CTA. 200px 이상 스크롤 후에만 표시.
 * /admin, /login, /compare* 에서는 숨김(중복·방해). 홈/계산기도 이미 계산기가 있어 숨김.
 */
export default function StickyCTA() {
  const pathname = usePathname() ?? ''
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    function onScroll() {
      setVisible(window.scrollY > SCROLL_THRESHOLD)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const hidden =
    HIDE_PREFIXES.some((p) => pathname.startsWith(p)) || HIDE_EXACT.includes(pathname)

  if (hidden) return null

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-40 lg:hidden transition-transform duration-200 ${
        visible ? 'translate-y-0' : 'translate-y-full'
      }`}
      aria-hidden={!visible}
    >
      <div className="mx-3 mb-3 rounded-xl bg-blue-600 text-white shadow-lg overflow-hidden">
        <Link
          href="/compare"
          className="flex items-center justify-between px-4 py-3 active:bg-blue-700"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">지금 내 무게로 비교</p>
            <p className="text-[11px] text-blue-100 leading-tight mt-0.5">
              33곳 배대지 · 실시간 환율
            </p>
          </div>
          <span className="flex items-center gap-1 text-sm font-semibold shrink-0 ml-3">
            비교
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </Link>
      </div>
    </div>
  )
}
