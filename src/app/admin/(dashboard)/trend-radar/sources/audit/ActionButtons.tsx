'use client'

import { useState, useTransition } from 'react'
import { proposeSeedDraft, retireSeed } from './actions'

export function ProposeButton({
  label,
  keywords,
  category,
}: {
  label: string
  keywords: string[]
  category: string | null
}) {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState<null | 'ok' | string>(null)

  if (done === 'ok') {
    return <span className="text-xs text-green-600">✓ draft 생성됨 (승인 대기)</span>
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending || keywords.length === 0}
        onClick={() =>
          startTransition(async () => {
            const res = await proposeSeedDraft({ label, keywords, category })
            setDone(res.ok ? 'ok' : res.error)
          })
        }
        className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-40"
      >
        {pending ? '…' : '+ 시드 제안'}
      </button>
      {done && done !== 'ok' && <span className="text-xs text-red-500">{done}</span>}
    </span>
  )
}

export function RetireButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState<null | 'ok' | string>(null)

  if (done === 'ok') {
    return <span className="text-xs text-gray-400">비활성화됨</span>
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await retireSeed(id)
            setDone(res.ok ? 'ok' : res.error)
          })
        }
        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40"
      >
        {pending ? '…' : '폐기(비활성)'}
      </button>
      {done && done !== 'ok' && <span className="text-xs text-red-500">{done}</span>}
    </span>
  )
}
