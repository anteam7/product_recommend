'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export default function ManualUpdateButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  async function handleClick() {
    setLoading(true)
    setMessage(null)

    try {
      const res = await fetch('/api/admin/trigger-rate-update', { method: 'POST' })
      const data = await res.json()

      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? '업데이트에 실패했습니다.' })
      } else {
        const summary = data.results
          .map((r: { currency: string; status: string; rate_krw: number | null }) =>
            r.status === 'success' ? `${r.currency}=${r.rate_krw}` : `${r.currency}:에러`,
          )
          .join(', ')
        setMessage({ type: 'success', text: `업데이트 완료 — ${summary}` })
        router.refresh()
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : '네트워크 오류',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={handleClick}
        disabled={loading}
        className="bg-blue-600 hover:bg-blue-700"
      >
        {loading ? '갱신 중…' : '지금 업데이트'}
      </Button>
      {message && (
        <p
          className={`text-xs px-3 py-1.5 rounded border max-w-md text-right ${
            message.type === 'success'
              ? 'text-green-700 bg-green-50 border-green-100'
              : 'text-red-700 bg-red-50 border-red-100'
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
