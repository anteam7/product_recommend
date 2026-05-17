'use client'

import { useState, useTransition } from 'react'

export interface LookalikeRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  category_sim: number
  price_sim: number
  supply_sim: number
  demand_sim: number
  composite_sim: number
  winner_avg_price: number | null
  winner_dominant_cate: string | null
  winner_match_count: number
}

interface Props {
  pinKeyword: string
  pinSource: string
  rows: LookalikeRow[]
}

export function PinLookalikeDrawer({ pinKeyword, pinSource, rows }: Props) {
  const [open, setOpen] = useState(false)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(new Set())
  const [, startTransition] = useTransition()

  const previewCount = rows.length

  return (
    <div className="border-t border-gray-100 bg-gray-50/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-2 text-xs text-gray-600 hover:bg-gray-100 flex items-center justify-between"
      >
        <span>
          {open ? '▾' : '▸'} Lookalike 추천 {previewCount}개
          <span className="text-gray-400 ml-2">
            (기준 핀: &quot;{pinKeyword}&quot; · {pinSource})
          </span>
        </span>
        <span className="text-gray-400">composite score 순</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-2">
          {rows.map((r) => {
            const key = `${pinSource}::${pinKeyword}::${r.goods_no}`
            const isPinned = pinnedKeys.has(key)
            const isPending = pendingKey === key

            return (
              <div
                key={r.goods_no}
                className={`rounded border bg-white px-3 py-2 flex items-start gap-3 ${
                  r.is_imminent ? 'border-red-200' : 'border-gray-200'
                }`}
              >
                <div className="w-14 h-14 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                  {r.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  )}
                  {r.is_imminent && (
                    <span className="absolute top-0 left-0 bg-red-600 text-white text-[8px] px-1 leading-tight rounded-br">
                      임박
                    </span>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-1.5">
                  <a
                    href={r.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className="block text-sm font-medium leading-snug hover:underline"
                    title={r.title}
                  >
                    {r.title}
                  </a>
                  <div className="text-[11px] text-gray-500">
                    {r.cate_label ?? r.cate_cd ?? '카테고리 X'} · {r.goods_no}
                    {r.price_krw != null && (
                      <span className="ml-2 text-gray-700">{r.price_krw.toLocaleString()}원</span>
                    )}
                    {r.winner_avg_price != null && (
                      <span className="ml-2 text-gray-400">
                        (winner 평균가 {r.winner_avg_price.toLocaleString()}원)
                      </span>
                    )}
                  </div>
                  <SimBars row={r} />
                </div>

                <div className="text-right flex-shrink-0 space-y-1 w-24">
                  <div className="text-lg font-bold font-mono text-emerald-700">
                    {(Number(r.composite_sim) * 100).toFixed(0)}
                  </div>
                  <div className="text-[10px] text-gray-400">composite</div>
                  <button
                    type="button"
                    disabled={isPinned || isPending}
                    onClick={() => {
                      setPendingKey(key)
                      startTransition(async () => {
                        try {
                          const res = await fetch('/api/admin/trends/pin', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                              keyword: r.title,
                              source: 'ggsan_lookalike',
                              pinned: true,
                              notes: `lookalike of "${pinKeyword}" (${(Number(r.composite_sim) * 100).toFixed(0)})`,
                            }),
                          })
                          if (res.ok) {
                            setPinnedKeys((s) => new Set(s).add(key))
                          }
                        } finally {
                          setPendingKey(null)
                        }
                      })
                    }}
                    className={`w-full text-[11px] px-2 py-1 rounded ${
                      isPinned
                        ? 'bg-emerald-100 text-emerald-700 cursor-default'
                        : isPending
                          ? 'bg-gray-200 text-gray-500 cursor-wait'
                          : 'bg-black text-white hover:bg-gray-800'
                    }`}
                  >
                    {isPinned ? '✓ 핀 완료' : isPending ? '...' : '핀 등록'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SimBars({ row }: { row: LookalikeRow }) {
  const bars: { label: string; v: number; color: string }[] = [
    { label: '카테고리', v: row.category_sim, color: 'bg-purple-500' },
    { label: '가격대', v: row.price_sim, color: 'bg-blue-500' },
    { label: '공급', v: Math.min(1, row.supply_sim), color: 'bg-amber-500' },
    { label: '수요', v: Math.min(1, row.demand_sim), color: 'bg-rose-500' },
  ]
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {bars.map((b) => {
        const pct = Math.max(0, Math.min(1, Number(b.v))) * 100
        return (
          <div key={b.label} className="min-w-0">
            <div className="flex items-center justify-between text-[9px] text-gray-500 mb-0.5">
              <span>{b.label}</span>
              <span className="font-mono">{pct.toFixed(0)}</span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
              <div className={`h-full ${b.color}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
