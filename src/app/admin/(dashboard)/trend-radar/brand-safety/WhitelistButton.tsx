'use client'

import { useState, useTransition } from 'react'
import { whitelistHit } from './actions'

export default function WhitelistButton({ hitId }: { hitId: string }) {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  if (done) {
    return <span className="text-xs text-gray-500">화이트리스트 처리됨</span>
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm('이 hit 을 오탐으로 처리(화이트리스트)할까요?')) return
        startTransition(async () => {
          const res = await whitelistHit(hitId)
          if (res?.ok) setDone(true)
          else alert(res?.error ?? 'failed')
        })
      }}
      className="text-xs px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-50"
    >
      {pending ? '처리 중...' : '오탐 → 화이트리스트'}
    </button>
  )
}
