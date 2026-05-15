'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function SubNavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname()
  const active =
    href === '/admin/trend-radar'
      ? pathname === '/admin/trend-radar' || pathname === '/admin/trend-radar/'
      : pathname === href || pathname.startsWith(href + '/')
  return (
    <Link
      href={href}
      className={`px-3 py-2 text-sm rounded-t ${
        active
          ? 'bg-white border-x border-t border-gray-200 -mb-px font-semibold text-black'
          : 'text-gray-500 hover:text-black'
      }`}
    >
      {label}
    </Link>
  )
}
