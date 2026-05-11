'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { track, ANALYTICS_EVENTS } from '@/lib/analytics'

export type HomeDealItem = {
  id: string
  name: string
  country: string
  countryLabel: string
  phase: 'ongoing' | 'upcoming'
  badge: string
  daysLabel: string
  href: string
  description: string | null
}

const ROTATE_MS = 5500

export default function HomeDealsCarousel({ items }: { items: HomeDealItem[] }) {
  const [index, setIndex] = useState(0)
  const total = items.length

  const goTo = useCallback(
    (next: number) => {
      if (total === 0) return
      setIndex(((next % total) + total) % total)
    },
    [total],
  )

  useEffect(() => {
    if (total <= 1) return
    const t = setInterval(() => setIndex((i) => (i + 1) % total), ROTATE_MS)
    return () => clearInterval(t)
  }, [total])

  if (total === 0) return null
  const current = items[index]

  return (
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr] lg:items-stretch">
      <div className="relative overflow-hidden rounded-[24px] bg-gradient-to-br from-blue-700 to-blue-900 p-7 text-white sm:p-9">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[var(--jim-accent-positive)]/20 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--jim-accent-positive)]">
            {current.badge}
          </span>
          <span className="text-[11px] tracking-[0.12em] text-white/55">
            {current.countryLabel}
          </span>
        </div>
        <h3 className="mt-6 text-[28px] font-medium leading-[1.18] tracking-tight sm:text-[32px]">
          {current.name}
        </h3>
        {current.description && (
          <p className="mt-4 line-clamp-2 max-w-md text-sm leading-6 text-white/65">
            {current.description}
          </p>
        )}
        <p className="mt-6 text-[13px] font-medium text-white/85">{current.daysLabel}</p>

        <div className="mt-8 flex items-center justify-between gap-3">
          <Link
            href={current.href}
            onClick={() =>
              track(ANALYTICS_EVENTS.DEAL_BANNER_CLICK, {
                deal_id: current.id,
                country: current.country,
                phase: current.phase,
              })
            }
            className="inline-flex h-10 items-center rounded-full bg-white px-5 text-sm font-medium text-[var(--jim-text-primary)] transition-opacity hover:opacity-90"
          >
            딜 보기 →
          </Link>
          {total > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="이전 딜"
                onClick={() => goTo(index - 1)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white/80 transition-colors hover:bg-white/10"
              >
                ←
              </button>
              <button
                type="button"
                aria-label="다음 딜"
                onClick={() => goTo(index + 1)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white/80 transition-colors hover:bg-white/10"
              >
                →
              </button>
            </div>
          )}
        </div>

        {total > 1 && (
          <div className="absolute bottom-7 right-9 flex gap-1.5" aria-hidden="true">
            {items.map((_, i) => (
              <span
                key={i}
                className={`h-1 rounded-full transition-all ${
                  i === index ? 'w-6 bg-white/80' : 'w-1.5 bg-white/30'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      <ul className="grid gap-3">
        {items.slice(0, 4).map((it, i) => {
          const isActive = i === index
          return (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => goTo(i)}
                className={`group block w-full rounded-[18px] border p-4 text-left transition-colors ${
                  isActive
                    ? 'border-[var(--jim-border-secondary)] bg-white'
                    : 'border-[var(--jim-border-tertiary)] bg-white hover:border-[var(--jim-border-secondary)]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-medium uppercase tracking-[0.16em] ${
                      it.phase === 'ongoing'
                        ? 'text-[var(--jim-text-primary)]'
                        : 'text-[var(--jim-text-tertiary)]'
                    }`}
                  >
                    {it.badge}
                  </span>
                  <span className="text-[10px] tracking-[0.12em] text-[var(--jim-text-tertiary)]">
                    {it.countryLabel}
                  </span>
                </div>
                <p className="mt-2 line-clamp-1 text-sm font-medium text-[var(--jim-text-primary)]">
                  {it.name}
                </p>
                <p className="mt-1 text-xs text-[var(--jim-text-tertiary)]">{it.daysLabel}</p>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
