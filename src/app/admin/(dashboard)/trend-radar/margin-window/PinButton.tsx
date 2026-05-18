'use client'

import { useState, useTransition } from 'react'

export default function MarginWindowPinButton({
  keyword,
  source,
  notes,
}: {
  keyword: string
  source: string
  notes?: string
}) {
  const [pinned, setPinned] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const onClick = () => {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/trends/pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keyword, source, pinned: !pinned, notes }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${res.status}`)
        }
        setPinned((v) => !v)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      title={error ?? (pinned ? '핀 해제' : '핀 등록')}
      className={`px-2 py-1 rounded text-xs border transition-colors ${
        pinned
          ? 'bg-amber-500 border-amber-600 text-white hover:bg-amber-600'
          : 'bg-white border-gray-300 text-gray-600 hover:border-amber-400 hover:text-amber-700'
      } ${isPending ? 'opacity-50 cursor-wait' : ''}`}
    >
      {pinned ? '★ 핀됨' : '☆ 핀'}
    </button>
  )
}
