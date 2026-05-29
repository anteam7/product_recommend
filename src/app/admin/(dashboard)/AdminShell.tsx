'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import LogoutButton from '../LogoutButton'

type BadgeKey = 'gov_new_24h'

type NavItem = {
  href: string
  label: string
  icon: string
  match?: (path: string) => boolean
  badgeKey?: BadgeKey
}

type NavGroup = {
  id: string
  label: string
  items: NavItem[]
}

// 메뉴 추가 방법: 해당 그룹의 items 배열에 NavItem 객체를 추가하면 됨.
// 새 그룹이 필요하면 NAV_GROUPS 배열에 NavGroup 을 추가.
const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: '개요',
    items: [
      {
        href: '/admin/trend-radar',
        label: '대시보드',
        icon: '🏠',
        match: (p) =>
          p === '/admin' ||
          p === '/admin/' ||
          p === '/admin/trend-radar' ||
          p === '/admin/trend-radar/',
      },
    ],
  },
  {
    id: 'discovery',
    label: '위탁 발굴',
    items: [
      {
        href: '/admin/trend-radar/recommend',
        label: '⭐ 추천 후보',
        icon: '⭐',
        match: (p) => p.startsWith('/admin/trend-radar/recommend'),
      },
      {
        href: '/admin/trend-radar/ggsan',
        label: 'ggsan 카탈로그',
        icon: '🛒',
        match: (p) => p.startsWith('/admin/trend-radar/ggsan'),
      },
      {
        href: '/admin/trend-radar/tv-ggsan-match',
        label: 'TV ↔ ggsan 매칭',
        icon: '📺',
        match: (p) => p.startsWith('/admin/trend-radar/tv-ggsan-match'),
      },
      {
        href: '/admin/trend-radar/opportunity',
        label: '기회 점수',
        icon: '🎯',
        match: (p) => p.startsWith('/admin/trend-radar/opportunity'),
      },
      {
        href: '/admin/trend-radar/review-velocity',
        label: '리뷰 속도 (실판매)',
        icon: '📈',
        match: (p) => p.startsWith('/admin/trend-radar/review-velocity'),
      },
      {
        href: '/admin/trend-radar/tv-pushes',
        label: 'TV 편성표',
        icon: '📡',
        match: (p) => p.startsWith('/admin/trend-radar/tv-pushes'),
      },
      {
        href: '/admin/trend-radar/sources',
        label: '수집 상태',
        icon: '⚙️',
        match: (p) => p.startsWith('/admin/trend-radar/sources'),
      },
      {
        href: '/admin/trend-radar/pins',
        label: '핀 (채택 후보)',
        icon: '📌',
        match: (p) => p.startsWith('/admin/trend-radar/pins'),
      },
    ],
  },
  {
    id: 'coupang',
    label: '쿠팡 자동등록',
    items: [
      {
        href: '/admin/coupang-publish',
        label: '등록 상품 관리',
        icon: '🅒',
        match: (p) => p.startsWith('/admin/coupang-publish'),
      },
      {
        href: '/admin/coupang-orders',
        label: '주문 ↔ 매입',
        icon: '📦',
        match: (p) => p.startsWith('/admin/coupang-orders'),
      },
    ],
  },
  {
    id: 'meta',
    label: '메타',
    items: [
      {
        href: '/admin/improvement-ideas',
        label: '개선 제안',
        icon: '💡',
        match: (p) => p.startsWith('/admin/improvement-ideas'),
      },
    ],
  },
]

const NAV_FLAT: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

const COLLAPSED_STORAGE_KEY = 'admin:nav:collapsed:v1'

function isItemActive(item: NavItem, pathname: string) {
  return item.match ? item.match(pathname) : pathname === item.href
}

export default function AdminShell({
  userEmail,
  children,
}: {
  userEmail: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? ''
  const [mobileOpen, setMobileOpen] = useState(false)

  const currentItem = NAV_FLAT.find((i) => isItemActive(i, pathname))

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar — Desktop */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col bg-white border-r sticky top-0 h-screen">
        <SidebarContent
          pathname={pathname}
          userEmail={userEmail}
          onNavigate={() => setMobileOpen(false)}
        />
      </aside>

      {/* Sidebar — Mobile overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 z-40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="fixed left-0 top-0 bottom-0 w-64 bg-white border-r z-50 lg:hidden flex flex-col">
            <SidebarContent
              pathname={pathname}
              userEmail={userEmail}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </>
      )}

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar */}
        <header className="lg:hidden sticky top-0 z-30 bg-white border-b flex items-center h-14 px-4 gap-3">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="메뉴 열기"
            className="p-1.5 -ml-1.5 rounded hover:bg-gray-100"
          >
            <svg className="w-6 h-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <Link href="/admin/trend-radar" className="font-bold text-gray-900 truncate">
            위탁 발굴 <span className="text-amber-600">Personal</span>
          </Link>
          {currentItem && (
            <span className="text-sm text-gray-500 ml-2 truncate">{currentItem.label}</span>
          )}
        </header>

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-6xl w-full">{children}</main>
      </div>
    </div>
  )
}

function SidebarContent({
  pathname,
  userEmail,
  onNavigate,
}: {
  pathname: string
  userEmail: string
  onNavigate: () => void
}) {
  // 시장 시그널 메뉴 — 24h 신규 정부 공지 카운트 배지
  const [govBadge, setGovBadge] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/market-signals/badges')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        if (typeof data.gov_new_24h === 'number') setGovBadge(data.gov_new_24h)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const badgeValues: Record<BadgeKey, number | null> = {
    gov_new_24h: govBadge,
  }

  // 그룹별 접힘 상태. 활성 메뉴가 있는 그룹은 항상 펼쳐진 상태로 시작.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {}
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY)
        if (raw) Object.assign(initial, JSON.parse(raw))
      } catch {}
    }
    // 활성 그룹은 강제로 펼침
    for (const group of NAV_GROUPS) {
      if (group.items.some((i) => isItemActive(i, pathname))) {
        initial[group.id] = false
      }
    }
    return initial
  })

  function toggleGroup(id: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }

  return (
    <>
      <div className="px-5 py-5 border-b">
        <Link href="/admin/trend-radar" onClick={onNavigate} className="block">
          <div className="font-bold text-gray-900 text-lg leading-none">
            위탁 발굴 <span className="text-amber-600">Personal</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">건강식품 도매 발굴 (로컬 전용)</div>
        </Link>
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {NAV_GROUPS.map((group, idx) => {
          const isCollapsed = !!collapsed[group.id]
          const groupHasActive = group.items.some((i) => isItemActive(i, pathname))
          const isSingleton = group.items.length === 1
          return (
            <div key={group.id} className={idx === 0 ? '' : 'mt-4'}>
              {/* 그룹 헤더: 단일 항목 그룹은 헤더 숨김 */}
              {!isSingleton && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400 hover:text-gray-600"
                >
                  <span>{group.label}</span>
                  <span className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>›</span>
                </button>
              )}
              {(isSingleton || !isCollapsed) && (
                <div className="space-y-1 mt-1">
                  {group.items.map((item) => {
                    const active = isItemActive(item, pathname)
                    const badgeValue = item.badgeKey ? badgeValues[item.badgeKey] : null
                    const showBadge = badgeValue !== null && badgeValue > 0
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={onNavigate}
                        className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                          active
                            ? 'bg-blue-50 text-blue-700'
                            : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
                        }`}
                      >
                        <span className="text-base leading-none">{item.icon}</span>
                        <span className="flex-1">{item.label}</span>
                        {showBadge && (
                          <span
                            title={
                              item.badgeKey === 'gov_new_24h'
                                ? `24시간 내 새 정부 공지 ${badgeValue}건`
                                : undefined
                            }
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-500 text-white"
                          >
                            {badgeValue}
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </div>
              )}
              {/* 접혀있는데 활성 메뉴가 그 안에 있으면 힌트 점 표시 */}
              {!isSingleton && isCollapsed && groupHasActive && (
                <div className="px-3 pt-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
                </div>
              )}
            </div>
          )
        })}

      </nav>

      <div className="px-5 py-4 border-t space-y-2">
        <p className="text-xs text-gray-500 truncate" title={userEmail}>
          {userEmail}
        </p>
        <LogoutButton />
      </div>
    </>
  )
}
