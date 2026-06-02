'use client'

import { useState, useTransition } from 'react'
import { promoteTokenToSeed, pruneSeed, reactivateSeed } from './actions'

function useAction(fn: (arg: string) => Promise<{ ok: boolean; error?: string }>) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const run = (arg: string) =>
    start(async () => {
      setMsg(null)
      const res = await fn(arg)
      if (!res.ok) setMsg(res.error ?? '실패')
    })
  return { run, pending, msg }
}

export function PromoteButton({ token }: { token: string }) {
  const { run, pending, msg } = useAction(promoteTokenToSeed)
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => run(token)}
        disabled={pending}
        className="rounded bg-black px-2 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-40"
      >
        {pending ? '추가중…' : '+ 시드 추가'}
      </button>
      {msg && <span className="text-xs text-red-600">{msg}</span>}
    </span>
  )
}

export function PruneButton({ seedId }: { seedId: string }) {
  const { run, pending, msg } = useAction(pruneSeed)
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => run(seedId)}
        disabled={pending}
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
      >
        {pending ? '…' : '가지치기'}
      </button>
      {msg && <span className="text-xs text-red-600">{msg}</span>}
    </span>
  )
}

export function ReactivateButton({ seedId }: { seedId: string }) {
  const { run, pending } = useAction(reactivateSeed)
  return (
    <button
      onClick={() => run(seedId)}
      disabled={pending}
      className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
    >
      {pending ? '…' : '복구'}
    </button>
  )
}
