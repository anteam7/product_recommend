'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { confirmAlias, splitAlias, mergeProducts } from './actions'

function useAction() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setErr(null)
    start(async () => {
      const r = await fn()
      if (!r.ok) setErr(r.error ?? '실패')
      else router.refresh()
    })
  }
  return { pending, err, run }
}

const BTN =
  'text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

export function SplitButton({ aliasId, productId }: { aliasId: string; productId: string }) {
  const { pending, err, run } = useAction()
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (confirm('이 alias 를 새 캐노니컬 상품으로 분할할까요?')) run(() => splitAlias(aliasId, productId))
        }}
        className={`${BTN} border-rose-300 text-rose-700 hover:bg-rose-50`}
      >
        {pending ? '…' : '✂ 분할'}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => confirmAlias(aliasId, productId))}
        className={`${BTN} border-gray-300 text-gray-600 hover:bg-gray-50`}
        title="이 매핑이 옳다고 확정 (confidence=1.0)"
      >
        ✓ 정상
      </button>
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </span>
  )
}

export function ConfirmButton({ aliasId, productId }: { aliasId: string; productId: string }) {
  const { pending, err, run } = useAction()
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => confirmAlias(aliasId, productId))}
        className={`${BTN} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
        title="LLM 매핑을 운영자가 확정 (confidence=1.0, 재분류 제외)"
      >
        {pending ? '…' : '✓ 확정'}
      </button>
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </span>
  )
}

export function MergeButton({ sourceId, targetId }: { sourceId: string; targetId: string }) {
  const { pending, err, run } = useAction()
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (confirm('두 캐노니컬을 하나로 병합할까요? (왼쪽 → 오른쪽 흡수, 왼쪽 삭제)'))
            run(() => mergeProducts(sourceId, targetId))
        }}
        className={`${BTN} border-indigo-300 text-indigo-700 hover:bg-indigo-50`}
      >
        {pending ? '…' : '⇉ 병합'}
      </button>
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
    </span>
  )
}
