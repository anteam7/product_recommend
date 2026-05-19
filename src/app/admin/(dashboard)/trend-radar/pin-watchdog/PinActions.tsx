'use client'
import { useState, useTransition } from 'react'

type ActionKind = 'hold' | 'refresh_listing' | 'lookalike' | 'terminate'

const LABELS: Record<ActionKind, string> = {
  hold: '보류',
  refresh_listing: '갱신',
  lookalike: '대체핀',
  terminate: '종료',
}

const TONE: Record<ActionKind, string> = {
  hold: 'border-gray-300 text-gray-700 hover:bg-gray-100',
  refresh_listing: 'border-blue-300 text-blue-700 hover:bg-blue-50',
  lookalike: 'border-purple-300 text-purple-700 hover:bg-purple-50',
  terminate: 'border-red-300 text-red-700 hover:bg-red-50',
}

export default function PinActions({ keyword, source }: { keyword: string; source: string }) {
  const [busy, setBusy] = useState<ActionKind | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  async function run(kind: ActionKind) {
    const reason = kind === 'terminate'
      ? window.prompt(`핀 종료 사유 (${keyword}):`, 'SERP 포화·점수 하락 지속')
      : window.prompt(`사유 (${kind}, ${keyword}):`, '')
    if (kind === 'terminate' && !reason) return
    setBusy(kind)
    try {
      const res = await fetch('/api/admin/trend-radar/pins/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, source, action: kind, reason: reason ?? '' }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDone(`✗ ${json.error ?? res.status}`)
      } else {
        setDone(`✓ ${LABELS[kind]}`)
        startTransition(() => {
          // soft refresh via location reload (server component invalidation)
          if (kind === 'terminate') window.location.reload()
        })
      }
    } catch (e) {
      setDone(`✗ ${e instanceof Error ? e.message : 'err'}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex gap-1 justify-end items-center">
      {(['hold', 'refresh_listing', 'lookalike', 'terminate'] as const).map((k) => (
        <button
          key={k}
          onClick={() => run(k)}
          disabled={busy !== null}
          className={`px-2 py-0.5 rounded border text-[11px] ${TONE[k]} ${
            busy === k ? 'opacity-50' : ''
          }`}
        >
          {LABELS[k]}
        </button>
      ))}
      {done && <span className="text-[10px] text-gray-500 ml-1">{done}</span>}
    </div>
  )
}
