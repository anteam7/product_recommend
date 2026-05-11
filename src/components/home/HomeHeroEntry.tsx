'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { track, ANALYTICS_EVENTS } from '@/lib/analytics'

const CATEGORY_CHIPS: { key: string; emoji: string; label: string }[] = [
  { key: 'clothing', emoji: '👕', label: '의류' },
  { key: 'shoes', emoji: '👟', label: '신발' },
  { key: 'supplements', emoji: '💊', label: '영양제' },
  { key: 'cosmetics', emoji: '💄', label: '화장품' },
  { key: 'figures', emoji: '🧸', label: '피규어/인형' },
  { key: 'otaku', emoji: '🎌', label: '덕질 굿즈' },
  { key: 'cards', emoji: '🃏', label: '카드' },
  { key: 'cd-dvd', emoji: '💿', label: 'CD/DVD' },
  { key: 'toys', emoji: '🧩', label: '완구' },
  { key: 'furniture', emoji: '🪑', label: '가구' },
  { key: 'misc', emoji: '🎁', label: '잡화/장식' },
  { key: 'bags', emoji: '👜', label: '가방' },
]

export default function HomeHeroEntry() {
  const router = useRouter()
  const [q, setQ] = useState('')

  const submitSearch = useCallback(() => {
    const trimmed = q.trim()
    track(ANALYTICS_EVENTS.RECOMMEND_ENTRY_SEARCH, {
      query: trimmed || null,
      has_query: trimmed.length > 0,
    })
    const url = trimmed ? `/recommend?q=${encodeURIComponent(trimmed)}` : '/recommend'
    router.push(url)
  }, [q, router])

  const onChipClick = useCallback(
    (key: string) => {
      track(ANALYTICS_EVENTS.RECOMMEND_ENTRY_CHIP, { category: key })
      router.push(`/recommend?category=${encodeURIComponent(key)}`)
    },
    [router],
  )

  return (
    <div>
      <div
        className="mx-auto flex max-w-[680px] items-center gap-3 rounded-[22px] border border-[var(--jim-border-secondary)] bg-white px-4 py-3.5 shadow-[0_4px_24px_rgba(0,0,0,0.04)] focus-within:border-[var(--jim-text-primary)]"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="shrink-0 opacity-60"
        >
          <circle cx="11" cy="11" r="7" stroke="#888780" strokeWidth="1.5" />
          <path d="M16 16L21 21" stroke="#888780" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitSearch()
            }
          }}
          placeholder="카테고리명으로 검색 (예: 의류, 시계, 영양제)"
          aria-label="상품 검색"
          className="min-w-0 flex-1 border-none bg-transparent text-[15px] text-[var(--jim-text-primary)] outline-none placeholder:text-[var(--jim-text-tertiary)]"
        />
        <button
          type="button"
          onClick={submitSearch}
          className="hidden h-9 shrink-0 items-center gap-1 rounded-full bg-blue-600 px-5 text-[13px] font-medium text-white transition-colors hover:bg-blue-700 sm:inline-flex"
        >
          시뮬레이터 →
        </button>
        <button
          type="button"
          onClick={submitSearch}
          aria-label="시뮬레이터로 이동"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 sm:hidden"
        >
          →
        </button>
      </div>

      <div className="mt-8 text-center">
        <p className="mb-3 text-[11px] font-medium tracking-[0.12em] text-[var(--jim-text-tertiary)]">
          또는 인기 카테고리
        </p>
        <div className="mx-auto flex max-w-[720px] flex-wrap justify-center gap-2">
          {CATEGORY_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => onChipClick(c.key)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--jim-border-tertiary)] bg-white px-4 py-2 text-[13px] text-[var(--jim-text-primary)] transition-colors hover:border-[var(--jim-border-secondary)] hover:bg-[var(--jim-bg-secondary)]"
            >
              <span aria-hidden="true" className="text-[14px] leading-none">
                {c.emoji}
              </span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      </div>

      <p className="mt-7 text-center text-[11px] tracking-[0.04em] text-[var(--jim-text-tertiary)]">
        가입 없이 · 30초 안에 · 결과 무료
      </p>

      <div className="mt-4 flex justify-center">
        <Link
          href="/recommend"
          onClick={() =>
            track(ANALYTICS_EVENTS.RECOMMEND_ENTRY_CTA, { source: 'hero_secondary' })
          }
          className="text-[12px] text-[var(--jim-text-tertiary)] underline-offset-4 hover:text-[var(--jim-text-secondary)] hover:underline"
        >
          빈 시뮬레이터로 바로 시작
        </Link>
      </div>
    </div>
  )
}
