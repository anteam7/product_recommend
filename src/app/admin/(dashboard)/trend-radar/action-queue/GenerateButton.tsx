'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function GenerateButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onClick() {
    setLoading(true)
    setMsg(null)
    try {
      const res = await fetch('/api/admin/trend-radar/action-queue/generate', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg(`에러: ${json.error ?? res.status}`)
        return
      }
      const results = (json.results ?? []) as Array<{ action_type: string; inserted: number }>
      const total = results.reduce((a, r) => a + (r.inserted ?? 0), 0)
      setMsg(
        total === 0
          ? '신규 카드 없음.'
          : `+${total} (${results.map((r) => `${r.action_type}:${r.inserted}`).join(', ')})`,
      )
      startTransition(() => router.refresh())
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'unknown')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={loading || pending}
        className="text-sm px-3 py-1.5 rounded bg-black text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {loading ? '생성 중…' : '🔄 트리거 룰 실행'}
      </button>
      {msg && <span className="text-xs text-gray-600">{msg}</span>}
    </div>
  )
}
