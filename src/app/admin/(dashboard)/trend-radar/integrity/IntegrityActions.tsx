'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type ActionBody =
  | { action: 'merge'; fromProductId: string; toProductId: string }
  | { action: 'split'; productId: string; alias: string }
  | { action: 'ignore'; findingKey: string; kind: string }

export function IntegrityActions({
  buttons,
}: {
  buttons: { label: string; body: ActionBody; tone?: 'primary' | 'danger' | 'muted'; confirm?: string }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function run(i: number, body: ActionBody, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBusy(i)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trends/integrity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(json.error ?? `HTTP ${res.status}`)
        setBusy(null)
        return
      }
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        {buttons.map((b, i) => {
          const tone =
            b.tone === 'primary'
              ? 'bg-black text-white hover:bg-gray-800'
              : b.tone === 'danger'
                ? 'border border-red-300 text-red-600 hover:bg-red-50'
                : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
          return (
            <button
              key={i}
              onClick={() => run(i, b.body, b.confirm)}
              disabled={busy !== null}
              className={`text-xs px-2.5 py-1 rounded disabled:opacity-50 ${tone}`}
            >
              {busy === i ? '…' : b.label}
            </button>
          )
        })}
      </div>
      {err && <span className="text-[10px] text-red-500">{err}</span>}
    </div>
  )
}
