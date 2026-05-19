'use client'

import { useState } from 'react'

type Decision = 'reject' | 'hide' | 'approve'

export default function RejectActions({
  productId,
  surface = 'trend-radar',
  rejectProb,
}: {
  productId: string
  surface?: string
  rejectProb?: number | null
}) {
  const [busy, setBusy] = useState<Decision | null>(null)
  const [done, setDone] = useState<Decision | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function send(decision: Decision) {
    setBusy(decision); setErr(null)
    try {
      const res = await fetch('/api/admin/trend-radar/reject-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, decision, surface }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setErr(j.error ?? `HTTP ${res.status}`)
      } else {
        setDone(decision)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="flex items-center gap-1 text-[10px]"
      onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      {typeof rejectProb === 'number' && (
        <span
          className={`px-1.5 py-0.5 rounded font-mono ${
            rejectProb >= 0.6 ? 'bg-red-100 text-red-700'
            : rejectProb >= 0.4 ? 'bg-amber-100 text-amber-700'
            : 'bg-gray-100 text-gray-500'
          }`}
          title="reject_probability — 학습된 거절 확률"
        >
          r={rejectProb.toFixed(2)}
        </span>
      )}
      {done ? (
        <span className="text-gray-500">✓ {done}</span>
      ) : (
        <>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => send('approve')}
            className="px-1.5 py-0.5 rounded border border-gray-200 hover:bg-green-50 hover:text-green-700"
          >
            {busy === 'approve' ? '...' : '👍'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => send('hide')}
            className="px-1.5 py-0.5 rounded border border-gray-200 hover:bg-gray-50"
          >
            {busy === 'hide' ? '...' : '🙈 hide'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => send('reject')}
            className="px-1.5 py-0.5 rounded border border-gray-200 hover:bg-red-50 hover:text-red-700"
          >
            {busy === 'reject' ? '...' : '✕ reject'}
          </button>
        </>
      )}
      {err && <span className="text-red-600 ml-1">{err}</span>}
    </div>
  )
}
