'use client'
import { useState } from 'react'

export default function NewsLeadPinButton({ keyword }: { keyword: string }) {
  const [pinned, setPinned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const toggle = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trends/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyword,
          source: 'news_lead',
          pinned: !pinned,
          notes: pinned ? null : 'news → search lead candidate',
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setPinned(!pinned)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={toggle}
        disabled={busy}
        className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
          pinned
            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        } disabled:opacity-50`}
      >
        {busy ? '...' : pinned ? '✓ 핀됨' : '📌 핀'}
      </button>
      {err && <div className="text-[10px] text-red-600 max-w-[140px] truncate" title={err}>{err}</div>}
    </div>
  )
}
