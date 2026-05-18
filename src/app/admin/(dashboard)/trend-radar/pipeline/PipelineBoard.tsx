'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { moveStage, type Stage } from './actions'
import type { PipelineCard } from './page'

const STAGE_LABEL: Record<Stage, string> = {
  discovery: '발굴',
  sourcing: '소싱',
  listing: '리스팅',
  live: '판매중',
  profitable: '수익화',
  rejected: '반려',
}
const STAGE_COLOR: Record<Stage, string> = {
  discovery: 'bg-slate-100 border-slate-300',
  sourcing: 'bg-blue-50 border-blue-300',
  listing: 'bg-amber-50 border-amber-300',
  live: 'bg-emerald-50 border-emerald-300',
  profitable: 'bg-violet-50 border-violet-300',
  rejected: 'bg-gray-100 border-gray-300',
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="text-[10px] text-gray-400">스코어 이력 부족</div>
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const width = 80
  const height = 20
  const step = values.length > 1 ? width / (values.length - 1) : 0
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={width} height={height} className="block">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="text-blue-500"
      />
    </svg>
  )
}

export default function PipelineBoard({
  cards,
  stages,
}: {
  cards: PipelineCard[]
  stages: Stage[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [hoverStage, setHoverStage] = useState<Stage | null>(null)
  const [error, setError] = useState<string | null>(null)

  const byStage = new Map<Stage, PipelineCard[]>()
  for (const s of stages) byStage.set(s, [])
  for (const c of cards) byStage.get(c.stage)?.push(c)

  const handleDrop = (stage: Stage) => {
    if (!draggingId) return
    const card = cards.find((c) => c.productId === draggingId)
    if (!card || card.stage === stage) {
      setDraggingId(null)
      setHoverStage(null)
      return
    }
    setError(null)
    startTransition(async () => {
      const res = await moveStage(card.productId, stage)
      if (!res.ok) setError(res.error)
      router.refresh()
    })
    setDraggingId(null)
    setHoverStage(null)
  }

  if (cards.length === 0) {
    return (
      <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
        <p className="text-base font-medium">파이프라인에 카드 없음</p>
        <p className="text-sm mt-2">
          상품을 핀하면 자동으로 <span className="font-semibold">소싱</span> 단계로 진입.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          전환 실패: {error}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {stages.map((stage) => {
          const list = byStage.get(stage) ?? []
          const isHover = hoverStage === stage
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault()
                if (hoverStage !== stage) setHoverStage(stage)
              }}
              onDragLeave={() => {
                if (hoverStage === stage) setHoverStage(null)
              }}
              onDrop={() => handleDrop(stage)}
              className={`rounded border-2 ${STAGE_COLOR[stage]} ${
                isHover ? 'ring-2 ring-black ring-offset-1' : ''
              } min-h-[200px]`}
            >
              <div className="px-3 py-2 border-b border-black/10 flex items-baseline justify-between">
                <div className="font-semibold text-sm">{STAGE_LABEL[stage]}</div>
                <div className="text-xs text-gray-500">{list.length}</div>
              </div>
              <div className="p-2 space-y-2">
                {list.length === 0 && (
                  <div className="text-[11px] text-gray-400 px-2 py-3 text-center">
                    카드를 여기로 드래그
                  </div>
                )}
                {list.map((c) => (
                  <article
                    key={c.productId}
                    draggable
                    onDragStart={() => setDraggingId(c.productId)}
                    onDragEnd={() => {
                      setDraggingId(null)
                      setHoverStage(null)
                    }}
                    className={`bg-white rounded border border-gray-200 p-2 text-xs cursor-grab active:cursor-grabbing shadow-sm ${
                      draggingId === c.productId ? 'opacity-40' : ''
                    } ${isPending ? 'pointer-events-none' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <Link
                        href={`/admin/trend-radar/products/${c.productId}`}
                        className="font-medium text-black hover:underline line-clamp-2"
                      >
                        {c.canonicalName}
                      </Link>
                      {c.slaBreached && (
                        <span className="shrink-0 text-[10px] bg-red-600 text-white rounded px-1.5 py-0.5">
                          정체
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500">
                      <span>{c.categoryTop}</span>
                      <span className={c.slaBreached ? 'text-red-600 font-semibold' : ''}>
                        {c.dwellDays.toFixed(1)}d
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <Sparkline values={c.scoreHistory} />
                      {c.latestScore !== null && (
                        <span className="text-[10px] font-mono text-gray-600">
                          {c.latestScore.toFixed(1)}
                        </span>
                      )}
                    </div>
                    {c.notes && (
                      <div className="mt-1 text-[10px] text-gray-500 line-clamp-2">{c.notes}</div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {isPending && (
        <div className="text-xs text-gray-500">단계 전환 중…</div>
      )}
    </div>
  )
}
