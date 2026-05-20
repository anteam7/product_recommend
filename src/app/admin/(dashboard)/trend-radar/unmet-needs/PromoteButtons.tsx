'use client'

import { useTransition } from 'react'
import { promoteNeedToSeed, pinNeedAsKeyword } from './actions'

export function PromoteButtons({
  needText,
  category,
  alreadyPromoted,
}: {
  needText: string
  category: string | null
  alreadyPromoted: boolean
}) {
  const [pending, start] = useTransition()

  return (
    <div className="flex gap-1 items-center">
      <button
        type="button"
        disabled={pending || alreadyPromoted}
        onClick={() =>
          start(async () => {
            const r = await promoteNeedToSeed(needText, category)
            if (!r.ok) alert(`promote 실패: ${r.error}`)
          })
        }
        className={`px-2 py-1 text-xs rounded border ${
          alreadyPromoted
            ? 'border-green-300 bg-green-50 text-green-700 cursor-not-allowed'
            : 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
        } disabled:opacity-50`}
      >
        {alreadyPromoted ? '✓ seed 등록됨' : pending ? '...' : '+ seed 등록'}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await pinNeedAsKeyword(needText)
            if (!r.ok) alert(`pin 실패: ${r.error}`)
          })
        }
        className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        📌 pin
      </button>
    </div>
  )
}
