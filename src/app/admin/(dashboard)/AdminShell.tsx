'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import LogoutButton from '../LogoutButton'
import { OPEN_CLAIMS_HREF } from './orders/model'

type BadgeKey = 'gov_new_24h' | 'work_escalated' | 'coupang_claims'

/** 진행 중 쿠팡 반품·출고중지 — /api/admin/coupang-claims 응답 */
type ClaimAlert = {
  stop: number
  returning: number
  items: Array<{ receiptId: number; stop: boolean; label: string; productName: string | null; todo: string }>
}

/** 1분마다 + 화면 이동 때 다시 읽는다(주문 수집은 매시라 이 정도면 충분). 실패는 조용히 무시(알림만 안 뜸). */
function useCoupangClaims(pathname: string): ClaimAlert | null {
  const [v, setV] = useState<ClaimAlert | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/admin/coupang-claims', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d || typeof d.stop !== 'number' || typeof d.returning !== 'number' || !Array.isArray(d.items)) return
          setV(d as ClaimAlert)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [pathname])
  return v
}

/** 관리자 모든 화면 맨 위 — 출고중지요청이 있으면 진한 빨강(가장 급함), 반품만 있으면 연한 빨강 */
function ClaimAlertBar({ a }: { a: ClaimAlert }) {
  const urgent = a.stop > 0
  const names = a.items.map((i) => i.productName ?? '(상품명 없음)')
  return (
    <Link
      href={OPEN_CLAIMS_HREF}
      className={`block px-4 sm:px-6 lg:px-8 py-2.5 text-sm border-b ${urgent ? 'bg-rose-600 text-white border-rose-700 hover:bg-rose-700' : 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100'}`}
    >
      <span className="font-bold">{urgent ? `🛑 쿠팡 출고중지요청 ${a.stop}건` : `↩ 쿠팡 반품 진행 ${a.returning}건`}</span>
      {urgent && a.returning > 0 && <span className="ml-2 font-semibold">· ↩ 반품 진행 {a.returning}건</span>}
      <span className={`ml-2 ${urgent ? 'text-rose-100' : 'text-rose-600'}`}>
        — {urgent ? '매입처 발주 멈추고 Wing에서 출고중지 처리' : '회수 확인 후 Wing에서 반품 승인'} · {names.slice(0, 3).join(', ')}{names.length > 3 ? ' 외' : ''}
      </span>
      <span className="ml-2 underline font-semibold whitespace-nowrap">확인하기 →</span>
    </Link>
  )
}

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
    id: 'org',
    label: '조직 & 에이전트',
    items: [
      {
        href: '/admin/work-console',
        label: '작업 콘솔',
        icon: '🛰️',
        match: (p) => p.startsWith('/admin/work-console'),
        badgeKey: 'work_escalated',
      },
      {
        href: '/admin/personas',
        label: '팀 페르소나',
        icon: '🧑‍💼',
        match: (p) => p.startsWith('/admin/personas'),
      },
      {
        href: '/admin/scenarios',
        label: '작업 시나리오',
        icon: '🗺️',
        match: (p) => p.startsWith('/admin/scenarios'),
      },
      {
        href: '/admin/execution-logs',
        label: '운영 일지',
        icon: '📒',
        match: (p) => p.startsWith('/admin/execution-logs'),
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
        href: '/admin/trend-radar/domeme',
        label: '도매매 소싱',
        icon: '🧭',
        match: (p) => p === '/admin/trend-radar/domeme' || p.startsWith('/admin/trend-radar/domeme?'),
      },
      {
        href: '/admin/trend-radar/domemedb-picks',
        label: '💰 도매매 흑자',
        icon: '💰',
        match: (p) => p.startsWith('/admin/trend-radar/domemedb-picks'),
      },
      {
        href: '/admin/sourcing',
        label: '🛒 소싱 매입',
        icon: '🛒',
        match: (p) => p.startsWith('/admin/sourcing'),
      },
      {
        href: '/admin/pricewatch',
        label: '📉 시세 모니터',
        icon: '📉',
        match: (p) => p.startsWith('/admin/pricewatch'),
      },
      {
        href: '/admin/reprice',
        label: '💰 가격수정 승인',
        icon: '💰',
        match: (p) => p.startsWith('/admin/reprice'),
      },
      {
        href: '/admin/ad-products',
        label: '📣 광고 상품 관리',
        icon: '📣',
        match: (p) => p.startsWith('/admin/ad-products'),
      },
      {
        href: '/admin/trend-radar/ggsan',
        label: 'ggsan 카탈로그',
        icon: '🛒',
        match: (p) => p.startsWith('/admin/trend-radar/ggsan'),
      },
      {
        href: '/admin/trend-radar/beseller',
        label: '비셀러 카탈로그',
        icon: '🧺',
        match: (p) => p.startsWith('/admin/trend-radar/beseller'),
      },
      {
        href: '/admin/wellroot-msp',
        label: '웰루트 MSP 확인',
        icon: '🌿',
        match: (p) => p.startsWith('/admin/wellroot-msp'),
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
        href: '/admin/purchase-catalog',
        label: '매입 대상 상품',
        icon: '🧾',
        match: (p) => p.startsWith('/admin/purchase-catalog'),
      },
      {
        href: '/admin/coupang-publish',
        label: '등록 상품 관리',
        icon: '🅒',
        match: (p) => p.startsWith('/admin/coupang-publish'),
      },
    ],
  },
  {
    // 2026-10-13 쿠팡·네이버·토스 주문 메뉴를 하나로 통합(마켓 필터 ?market=). 옛 /admin/{coupang,naver,toss}-orders 는 리다이렉트.
    id: 'orders',
    label: '주문 · 매입',
    items: [
      {
        href: '/admin/orders',
        label: '주문 ↔ 매입 (전 마켓)',
        icon: '📦',
        badgeKey: 'coupang_claims',
        match: (p) => p.startsWith('/admin/orders') || p.startsWith('/admin/coupang-orders') || p.startsWith('/admin/naver-orders') || p.startsWith('/admin/toss-orders'),
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
      {
        href: '/admin/agent-log',
        label: '에이전트 로그',
        icon: '🤖',
        match: (p) => p.startsWith('/admin/agent-log'),
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
  const claims = useCoupangClaims(pathname)
  const claimCount = claims ? claims.stop + claims.returning : null

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar — Desktop */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col bg-white border-r sticky top-0 h-screen">
        <SidebarContent
          pathname={pathname}
          userEmail={userEmail}
          onNavigate={() => setMobileOpen(false)}
          claimCount={claimCount}
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
              claimCount={claimCount}
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

        {/* 진행 중 쿠팡 반품·출고중지 — 모든 화면 맨 위(주문 화면은 본문에 건별 패널이 있어 생략) */}
        {claims && claims.stop + claims.returning > 0 && !pathname.startsWith('/admin/orders') && <ClaimAlertBar a={claims} />}

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-6xl w-full">{children}</main>
      </div>
    </div>
  )
}

function SidebarContent({
  pathname,
  userEmail,
  onNavigate,
  claimCount,
}: {
  pathname: string
  userEmail: string
  onNavigate: () => void
  /** 진행 중 쿠팡 반품·출고중지 건수(AdminShell 이 읽어 내려줌) */
  claimCount: number | null
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

  // 작업 콘솔 — 확인 필요(escalated) 작업 수 배지 (폴링)
  const [workBadge, setWorkBadge] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/admin/work-instructions', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data?.items) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setWorkBadge((data.items as any[]).filter((i) => i?.status === 'escalated').length)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const badgeValues: Record<BadgeKey, number | null> = {
    gov_new_24h: govBadge,
    work_escalated: workBadge,
    coupang_claims: claimCount,
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
                                : item.badgeKey === 'work_escalated'
                                  ? `확인 필요한 작업 ${badgeValue}건`
                                  : item.badgeKey === 'coupang_claims'
                                    ? `진행 중 쿠팡 출고중지·반품 ${badgeValue}건`
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
