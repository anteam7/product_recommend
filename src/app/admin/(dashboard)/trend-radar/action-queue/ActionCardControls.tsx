'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function ActionCardControls({
  id,
  currentStatus,
}: {
  id: string
  currentStatus: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function patch(status: 'snoozed' | 'done' | 'skipped') {
    setErr(null)
    const body: Record<string, unknown> = { status }
    if (note.trim()) body.decision_note = note.trim()
    if (status === 'snoozed') body.snooze_hours = 24

    try {
      const res = await fetch(`/api/admin/trend-radar/action-queue/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setErr(json.error ?? `HTTP ${res.status}`)
        return
      }
      setNote('')
      startTransition(() => router.refresh())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'unknown')
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="결정 메모 (선택)"
        className="w-full text-[11px] rounded border border-gray-200 px-2 py-1 focus:outline-none focus:border-gray-400"
        maxLength={500}
      />
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => patch('done')}
          disabled={pending}
          className="flex-1 text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          ✓ done
        </button>
        {currentStatus !== 'snoozed' && (
          <button
            type="button"
            onClick={() => patch('snoozed')}
            disabled={pending}
            className="flex-1 text-[11px] px-2 py-1 rounded bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
          >
            💤 24h
          </button>
        )}
        <button
          type="button"
          onClick={() => patch('skipped')}
          disabled={pending}
          className="flex-1 text-[11px] px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
        >
          ✕ skip
        </button>
      </div>
      {err && <div className="text-[10px] text-rose-600">{err}</div>}
    </div>
  )
}
