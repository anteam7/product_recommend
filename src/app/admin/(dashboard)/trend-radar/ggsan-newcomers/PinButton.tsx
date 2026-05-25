'use client'

import { useState } from 'react'

interface Props {
  goodsNo: string
  title: string
  initialPinned: boolean
  noteSeed: string
}

export default function PinButton({ goodsNo, title, initialPinned, noteSeed }: Props) {
  const [pinned, setPinned] = useState(initialPinned)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trend-radar/ggsan-newcomers/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goodsNo, title, note: noteSeed }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'failed')
      setPinned(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (pinned) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">📌 핀됨</span>
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
      title={err ?? '핀 + 자동 메모'}
    >
      {busy ? '...' : '📌 핀'}
    </button>
  )
}
