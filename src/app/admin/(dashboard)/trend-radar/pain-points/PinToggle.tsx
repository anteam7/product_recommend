'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function PinToggle({ id, initialPinned }: { id: string; initialPinned: boolean }) {
  const [pinned, setPinned] = useState(initialPinned)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  async function toggle() {
    const next = !pinned
    setPinned(next)
    try {
      const res = await fetch('/api/admin/pain-points/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, pinned: next }),
      })
      if (!res.ok) throw new Error(`pin ${res.status}`)
      startTransition(() => router.refresh())
    } catch {
      setPinned(!next)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className={`text-base leading-none px-2 py-1 rounded transition-colors ${
        pinned ? 'text-amber-600 hover:text-amber-800' : 'text-gray-300 hover:text-amber-500'
      }`}
      aria-label={pinned ? '핀 해제' : '핀 고정'}
      title={pinned ? '핀 해제' : '핀 고정'}
    >
      {pinned ? '★' : '☆'}
    </button>
  )
}
