/**
 * Google Analytics 4 이벤트 유틸.
 * window.gtag이 없을 때(스크립트 로드 전·광고 차단 등)도 안전하게 무시.
 */

type GtagFn = (command: 'event', name: string, params?: Record<string, unknown>) => void

declare global {
  interface Window {
    gtag?: GtagFn
    dataLayer?: unknown[]
  }
}

export function track(eventName: string, params: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, params)
    } else if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: eventName, ...params })
    }
  } catch {
    // 조용히 무시
  }
}

// 표준 이벤트 이름 (오타 방지)
export const ANALYTICS_EVENTS = {
  CALCULATE_CLICK: 'calculate_click',
  FORWARDER_CARD_CLICK: 'forwarder_card_click',
  EXTERNAL_SITE_CLICK: 'external_site_click',
  BLOG_READ_50: 'blog_read_50',
  COMPARE_FILTER_CHANGE: 'compare_filter_change',
  // v2 메인 깔때기 (홈 → /recommend) 추적
  RECOMMEND_ENTRY_SEARCH: 'recommend_entry_search',
  RECOMMEND_ENTRY_CHIP: 'recommend_entry_chip',
  RECOMMEND_ENTRY_CTA: 'recommend_entry_cta',
  // 메인 딜 배너 효과
  DEAL_BANNER_CLICK: 'deal_banner_click',
  // 준비 중 페이지 클릭 — Phase B(소셜로그인)/D(리뷰) 우선순위 데이터
  COMING_SOON_CLICK: 'coming_soon_click',
} as const
