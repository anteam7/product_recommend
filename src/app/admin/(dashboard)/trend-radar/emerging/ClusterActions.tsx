'use client'

import { useState, useTransition } from 'react'
import { promoteCluster, dismissCluster } from './actions'

export default function ClusterActions({ clusterId }: { clusterId: string }) {
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setMsg(null)
    startTransition(async () => {
      const r = await fn()
      if (!r.ok) setMsg(r.error ?? '실패')
    })
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => promoteCluster(clusterId))}
        className="text-xs px-2.5 py-1 rounded bg-black text-white hover:bg-gray-800 disabled:opacity-40"
      >
        {pending ? '처리중…' : '⛏ canonical 생성'}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => dismissCluster(clusterId))}
        className="text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
      >
        기각
      </button>
      {msg && <span className="text-xs text-red-600">{msg}</span>}
    </div>
  )
}
