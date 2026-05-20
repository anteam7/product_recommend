'use client'

import { useState } from 'react'

export default function PinButton({ keyword }: { keyword: string }) {
  const [pinned, setPinned] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    if (loading || pinned) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trends/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword,
          source: 'serp_stockout',
          pinned: true,
          notes: 'OOS pressure 상승 — 진입 후보',
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(body?.error ?? `HTTP ${res.status}`)
      } else {
        setPinned(true)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading || pinned}
      className={`text-xs px-2 py-1 rounded border transition-colors ${
        pinned
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 cursor-default'
          : 'border-gray-300 hover:border-black hover:bg-gray-50'
      }`}
      title={err ?? undefined}
    >
      {pinned ? '✓ 핀됨' : loading ? '핀…' : '핀 후보 큐로'}
    </button>
  )
}
