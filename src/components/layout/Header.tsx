'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

type NavItem = { label: string; href: string }

const FORWARDER_ITEMS: NavItem[] = [
  { label: '배대지 목록', href: '/forwarders' },
  { label: '창고 지도', href: '/map' },
]

const SIMULATOR_ITEM: NavItem = { label: '시뮬레이터', href: '/recommend' }

const FLAT_ITEMS: NavItem[] = [
  { label: '블로그', href: '/blog' },
  { label: '세일 일정', href: '/deals' },
  { label: '환율', href: '/exchange-rates' },
  // { label: '후기', href: '/preparing?feature=reviews' },
]

// const AUTH_ITEM: NavItem = { label: '로그인', href: '/preparing?feature=login' }

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

function DesktopDropdown({
  label,
  items,
  pathname,
}: {
  label: string
  items: NavItem[]
  pathname: string | null
}) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = items.some((it) => isActive(pathname, it.href))

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => {
        cancelClose()
        setOpen(true)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) scheduleClose()
      }}
    >
      <button
        type="button"
        className={`text-sm font-medium transition-colors flex items-center gap-1 ${
          active ? 'text-[var(--jim-text-primary)]' : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
        }`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {label}
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="3 5 6 8 9 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-1/2 -translate-x-1/2 pt-2 z-50"
        >
          <div className="min-w-[180px] rounded-[18px] border border-[var(--jim-border-tertiary)] bg-white py-2">
            {items.map((it) => {
              const itActive = isActive(pathname, it.href)
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  role="menuitem"
                  className={`block px-4 py-2 text-sm transition-colors ${
                    itActive
                      ? 'text-[var(--jim-text-primary)] bg-[var(--jim-bg-secondary)] font-medium'
                      : 'text-[var(--jim-text-secondary)] hover:bg-[var(--jim-bg-secondary)] hover:text-[var(--jim-text-primary)]'
                  }`}
                >
                  {it.label}
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const pathname = usePathname()

  // pathname 바뀌면 모바일 메뉴 자동 닫기
  useEffect(() => {
    setIsMenuOpen(false)
  }, [pathname])

  if (pathname?.startsWith('/admin')) return null

  return (
    <header className="sticky top-0 z-50 w-full border-b border-[var(--jim-border-tertiary)] bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/70">
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2" aria-label="짐스캐너 홈">
            <Image
              src="/jimscanner-logo.png"
              alt="짐스캐너"
              width={345}
              height={80}
              priority
              className="h-8 w-auto sm:h-9"
            />
            <span className="hidden text-xs text-gray-400 sm:inline">배대지 비교</span>
          </Link>

          <nav className="hidden md:flex items-center space-x-6">
            <Link
              href={SIMULATOR_ITEM.href}
              className={`text-sm font-medium transition-colors ${
                isActive(pathname, SIMULATOR_ITEM.href)
                  ? 'text-[var(--jim-text-primary)]'
                  : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
              }`}
            >
              {SIMULATOR_ITEM.label}
            </Link>
            <DesktopDropdown label="배대지" items={FORWARDER_ITEMS} pathname={pathname} />
            {FLAT_ITEMS.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className={`text-sm font-medium transition-colors ${
                  isActive(pathname, it.href)
                    ? 'text-[var(--jim-text-primary)]'
                    : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
                }`}
              >
                {it.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center space-x-2">
            {/* <Link
              href={AUTH_ITEM.href}
              className="hidden text-sm font-medium text-[var(--jim-text-secondary)] transition-colors hover:text-[var(--jim-text-primary)] md:inline"
            >
              {AUTH_ITEM.label}
            </Link> */}

            <button
              className="md:hidden p-2 rounded-md text-[var(--jim-text-secondary)] hover:bg-[var(--jim-bg-secondary)] hover:text-[var(--jim-text-primary)]"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              aria-label="메뉴 열기"
              aria-expanded={isMenuOpen}
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {isMenuOpen ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>

        {isMenuOpen && (
          <div className="md:hidden py-3 border-t border-[var(--jim-border-tertiary)]">
            <nav className="flex flex-col">
              {/* 시뮬레이터 */}
              <Link
                href={SIMULATOR_ITEM.href}
                className={`py-2 pl-1 text-sm font-medium ${
                  isActive(pathname, SIMULATOR_ITEM.href)
                    ? 'text-[var(--jim-text-primary)]'
                    : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
                }`}
              >
                {SIMULATOR_ITEM.label}
              </Link>

              {/* 배대지 그룹 */}
              <div className="px-1 pt-3 pb-1 text-xs font-medium text-[var(--jim-text-tertiary)] uppercase tracking-wide">
                배대지
              </div>
              {FORWARDER_ITEMS.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`py-2 pl-4 text-sm ${
                    isActive(pathname, it.href)
                      ? 'text-[var(--jim-text-primary)] font-medium'
                      : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
                  }`}
                >
                  {it.label}
                </Link>
              ))}

              {/* 기타 단일 */}
              <div className="px-1 pt-3 pb-1 text-xs font-medium text-[var(--jim-text-tertiary)] uppercase tracking-wide">
                더 보기
              </div>
              {FLAT_ITEMS.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`py-2 pl-4 text-sm ${
                    isActive(pathname, it.href)
                      ? 'text-[var(--jim-text-primary)] font-medium'
                      : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
                  }`}
                >
                  {it.label}
                </Link>
              ))}

              {/* <Link
                href={AUTH_ITEM.href}
                className={`py-2 pl-4 text-sm ${
                  isActive(pathname, AUTH_ITEM.href)
                    ? 'text-[var(--jim-text-primary)] font-medium'
                    : 'text-[var(--jim-text-secondary)] hover:text-[var(--jim-text-primary)]'
                }`}
              >
                {AUTH_ITEM.label}
              </Link> */}

              <Link
                href="/recommend"
                className="mt-4 rounded-full bg-[var(--jim-bg-inverse)] px-4 py-2 text-center text-sm font-medium text-white"
              >
                시뮬레이터 시작 →
              </Link>
            </nav>
          </div>
        )}
      </div>
    </header>
  )
}
