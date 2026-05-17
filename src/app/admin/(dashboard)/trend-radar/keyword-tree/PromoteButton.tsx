'use client'
import { useState, useTransition } from 'react'

export default function PromoteButton({
  keyword,
  source,
}: {
  keyword: string
  source: string
}) {
  const [pending, start] = useTransition()
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (done) {
    return <span className="text-xs text-green-600">✓ 핀됨</span>
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          setError(null)
          const res = await fetch('/api/admin/keyword-expansion/promote', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ keyword, source }),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            setError(typeof j?.error === 'string' ? j.error : 'failed')
            return
          }
          setDone(true)
        })
      }
      className="text-xs rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
      title="공백 후보를 핀으로 승급"
    >
      {pending ? '...' : error ? `재시도 (${error})` : '핀으로 승급'}
    </button>
  )
}
