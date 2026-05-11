'use client'

import { useEffect } from 'react'

const GA_ID = 'G-TS4P13JPTY'

// admin 영역에서 GA4 측정 끔. 인라인 동기 스크립트(layout.tsx)가 첫 페이지뷰를
// 차단하고, 이 컴포넌트는 SPA 네비게이션으로 /admin 진입 시 플래그를 다시 세팅.
// 언마운트 시(어드민에서 일반 페이지로 이동) 플래그 해제하여 일반 트래픽 재계측.
export default function DisableGA() {
  useEffect(() => {
    const w = window as unknown as Record<string, boolean>
    w[`ga-disable-${GA_ID}`] = true
    return () => {
      w[`ga-disable-${GA_ID}`] = false
    }
  }, [])
  return null
}
