'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { STAGES, DROP_REASONS, type StageKey, type PipelineCard } from './stages'

function daysSince(iso: string | null): string {
  if (!iso) return ''
  const d = (Date.now() - new Date(iso).getTime()) / 86400000
  if (d < 1) return '오늘'
  return `${Math.floor(d)}일 체류`
}

export default function PipelineBoard({
  initialCards,
  stageCounts,
}: {
  initialCards: PipelineCard[]
  stageCounts: Record<string, number>
}) {
  const router = useRouter()
  const [cards, setCards] = useState<PipelineCard[]>(initialCards)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<StageKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // dropped 로 이동 시 사유 선택 모달
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  async function move(productId: string, stage: StageKey, droppedReason?: string) {
    setBusy(true)
    setError(null)
    // 낙관적 업데이트
    const prev = cards
    setCards((cs) =>
      cs.map((c) =>
        c.product_id === productId
          ? {
              ...c,
              stage,
              stage_changed_at: new Date().toISOString(),
              dropped_reason: stage === 'dropped' ? droppedReason ?? c.dropped_reason : null,
              virtual: false,
            }
          : c,
      ),
    )
    try {
      const res = await fetch('/api/admin/trend-radar/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, stage, dropped_reason: droppedReason ?? null }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      // 분석 패널 갱신
      router.refresh()
    } catch (e) {
      setCards(prev) // 롤백
      setError(e instanceof Error ? e.message : '저장 실패')
    } finally {
      setBusy(false)
    }
  }

  function handleDrop(stage: StageKey) {
    setOverStage(null)
    const id = dragId
    setDragId(null)
    if (!id) return
    const card = cards.find((c) => c.product_id === id)
    if (!card || card.stage === stage) return
    if (stage === 'dropped') {
      setDropTarget(id) // 사유 모달
      return
    }
    void move(id, stage)
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">📋 칸반 보드 (드래그로 단계 이동)</h2>
        {busy && <span className="text-xs text-gray-400">저장 중…</span>}
      </div>
      {error && (
        <div className="mb-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {STAGES.map((s) => {
          const colCards = cards.filter((c) => c.stage === s.key)
          const isOver = overStage === s.key
          return (
            <div
              key={s.key}
              onDragOver={(e) => {
                e.preventDefault()
                setOverStage(s.key)
              }}
              onDragLeave={() => setOverStage((cur) => (cur === s.key ? null : cur))}
              onDrop={() => handleDrop(s.key)}
              className={`rounded-lg border min-h-[160px] p-2 transition-colors ${
                isOver ? 'border-blue-400 bg-blue-50/50' : 'border-gray-200 bg-gray-50/50'
              }`}
            >
              <div className="flex items-center justify-between mb-2 px-1">
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${s.tone}`}>
                  {s.label}
                </span>
                <span className="text-[11px] text-gray-400 font-mono">{colCards.length}</span>
              </div>
              <div className="space-y-1.5">
                {colCards.map((c) => (
                  <div
                    key={c.product_id}
                    draggable
                    onDragStart={() => setDragId(c.product_id)}
                    onDragEnd={() => setDragId(null)}
                    className={`rounded border bg-white p-2 cursor-grab active:cursor-grabbing text-xs shadow-sm hover:shadow ${
                      dragId === c.product_id ? 'opacity-40' : ''
                    } ${c.virtual ? 'border-dashed border-gray-300' : 'border-gray-200'}`}
                  >
                    <Link
                      href={`/admin/trend-radar/products/${c.product_id}`}
                      className="font-medium leading-snug hover:underline line-clamp-2"
                      title={c.name}
                    >
                      {c.name}
                    </Link>
                    <div className="flex items-center justify-between mt-1 text-[10px] text-gray-400">
                      <span>{c.category}</span>
                      {c.final_score != null && (
                        <span className="font-mono text-amber-700">{c.final_score.toFixed(0)}</span>
                      )}
                    </div>
                    {c.dropped_reason && (
                      <div className="mt-1 text-[10px] text-rose-600">사유: {c.dropped_reason}</div>
                    )}
                    {c.stage_changed_at && !c.virtual && (
                      <div className="mt-0.5 text-[10px] text-gray-300">{daysSince(c.stage_changed_at)}</div>
                    )}
                  </div>
                ))}
                {colCards.length === 0 && (
                  <div className="text-[10px] text-gray-300 text-center py-4">비어 있음</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 이탈 사유 모달 */}
      {dropTarget && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-5 w-full max-w-sm space-y-3">
            <h3 className="font-semibold text-sm">이탈 사유 선택</h3>
            <p className="text-xs text-gray-500">
              {cards.find((c) => c.product_id === dropTarget)?.name}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {DROP_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    const id = dropTarget
                    setDropTarget(null)
                    void move(id, 'dropped', r)
                  }}
                  className="px-3 py-2 text-xs rounded border border-gray-200 hover:bg-rose-50 hover:border-rose-300"
                >
                  {r}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setDropTarget(null)}
              className="w-full text-xs text-gray-500 hover:text-black pt-1"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
