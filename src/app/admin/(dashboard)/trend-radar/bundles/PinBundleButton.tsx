'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function PinBundleButton({
  bundleId,
  initialPinned,
}: {
  bundleId: string
  initialPinned: boolean
}) {
  const router = useRouter()
  const [pinned, setPinned] = useState(initialPinned)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const toggle = () => {
    setError(null)
    const next = !pinned
    setPinned(next)
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/trend-radar/bundles/pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: bundleId, pinned: next }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${res.status}`)
        }
        router.refresh()
      } catch (e) {
        setPinned(!next)
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className={`text-xs px-2 py-1 rounded border transition ${
          pinned
            ? 'bg-amber-500 text-white border-amber-500'
            : 'bg-white text-gray-600 border-gray-300 hover:border-amber-400'
        } ${pending ? 'opacity-50 cursor-wait' : ''}`}
      >
        {pinned ? '★ 핀' : '☆ 핀'}
      </button>
      {error && <div className="text-[10px] text-red-600 max-w-[100px] truncate" title={error}>{error}</div>}
    </div>
  )
}
