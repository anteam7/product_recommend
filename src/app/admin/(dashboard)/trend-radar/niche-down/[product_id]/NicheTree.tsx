'use client'

import { useState, useTransition } from 'react'

interface Leaf {
  id: string
  pivot_value: string
  derived_query: string
  sub_competition: number | null
  sub_volume_est: number | null
  sub_intent: string | null
  score_delta: number | null
  promoted_to_pin: boolean
  rationale: string | null
  isBest: boolean
}

interface Group {
  axis: string
  axisLabel: string
  leaves: Leaf[]
}

const INTENT_COLOR: Record<string, string> = {
  commerce: 'bg-emerald-100 text-emerald-700',
  info: 'bg-sky-100 text-sky-700',
  mixed: 'bg-violet-100 text-violet-700',
}

export default function NicheTree({ groups }: { groups: Group[] }) {
  const [promoted, setPromoted] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const g of groups) for (const l of g.leaves) if (l.promoted_to_pin) init[l.id] = true
    return init
  })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function promote(id: string) {
    setError(null)
    try {
      const res = await fetch('/api/admin/trend-radar/niche-pivot/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pivotId: id }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'failed')
        return
      }
      setPromoted((prev) => ({ ...prev, [id]: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {groups.map((g) => (
        <div key={g.axis} className="pl-6 border-l-2 border-gray-300">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">
            {g.axisLabel}{' '}
            <span className="text-gray-400 normal-case">({g.leaves.length})</span>
          </div>
          <div className="space-y-2">
            {g.leaves.map((l) => {
              const isPromoted = promoted[l.id] ?? l.promoted_to_pin
              return (
                <div
                  key={l.id}
                  className={`rounded border px-3 py-2 ${
                    l.isBest
                      ? 'border-amber-400 bg-amber-50 ring-2 ring-amber-200'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <div className="font-medium text-sm flex items-center gap-2">
                        {l.isBest && (
                          <span className="text-amber-600 text-xs font-bold">★ BEST</span>
                        )}
                        <span className="px-2 py-0.5 rounded bg-gray-100 text-xs">
                          {l.pivot_value}
                        </span>
                        <span className="text-gray-700">{l.derived_query}</span>
                      </div>
                      {l.rationale && (
                        <div className="text-xs text-gray-500 mt-1">{l.rationale}</div>
                      )}
                    </div>
                    <div className="col-span-2 text-xs text-right">
                      {l.sub_intent ? (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] ${
                            INTENT_COLOR[l.sub_intent] ?? 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {l.sub_intent}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </div>
                    <div className="col-span-1 text-right text-xs font-mono text-gray-600">
                      comp {l.sub_competition ?? '—'}
                    </div>
                    <div className="col-span-1 text-right text-xs font-mono text-gray-600">
                      vol {l.sub_volume_est ?? '—'}
                    </div>
                    <div className="col-span-1 text-right text-xs font-mono">
                      {l.score_delta != null ? (
                        <span
                          className={
                            l.score_delta >= 0 ? 'text-emerald-700 font-bold' : 'text-red-600'
                          }
                        >
                          {l.score_delta > 0 ? '+' : ''}
                          {l.score_delta}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </div>
                    <div className="col-span-2 text-right">
                      {isPromoted ? (
                        <span className="text-xs text-gray-500 px-2 py-1 bg-gray-100 rounded">
                          📌 핀됨
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startTransition(() => promote(l.id))}
                          disabled={pending}
                          className="text-xs px-2 py-1 rounded bg-black text-white hover:bg-gray-800 disabled:opacity-50"
                        >
                          핀 후보로
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
