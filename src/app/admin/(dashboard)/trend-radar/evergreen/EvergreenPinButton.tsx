'use client'

import { useState, useTransition } from 'react'

export default function EvergreenPinButton({
  keyword,
  source,
  initialPinned,
}: {
  keyword: string
  source: string
  initialPinned: boolean
}) {
  const [pinned, setPinned] = useState(initialPinned)
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)

  function toggle() {
    setErr(null)
    const next = !pinned
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/trends/pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keyword, source, pinned: next, notes: 'evergreen' }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setErr(json?.error ?? '실패')
          return
        }
        setPinned(next)
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : '실패')
      }
    })
  }

  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={`px-2 py-1 text-xs rounded transition-colors ${
          pinned
            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        } ${pending ? 'opacity-50 cursor-wait' : ''}`}
      >
        {pinned ? '✓ 핀됨' : '＋ 핀'}
      </button>
      {err && <span className="text-[10px] text-red-600">{err}</span>}
    </div>
  )
}
