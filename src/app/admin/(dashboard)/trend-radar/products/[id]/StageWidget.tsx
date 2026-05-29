'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type StageKey = 'discovered' | 'reviewing' | 'sourcing' | 'listed' | 'selling' | 'dropped'

const STAGES: { key: StageKey; label: string; tone: string }[] = [
  { key: 'discovered', label: '발굴', tone: 'border-gray-300 text-gray-700' },
  { key: 'reviewing', label: '검토', tone: 'border-blue-300 text-blue-700' },
  { key: 'sourcing', label: '소싱확정', tone: 'border-indigo-300 text-indigo-700' },
  { key: 'listed', label: '등록', tone: 'border-violet-300 text-violet-700' },
  { key: 'selling', label: '판매', tone: 'border-emerald-300 text-emerald-700' },
  { key: 'dropped', label: '이탈', tone: 'border-rose-300 text-rose-700' },
]
const DROP_REASONS = ['마진부족', '반품위험', '소싱불가', '경쟁과포화', '인증장벽', '기타'] as const

export default function StageWidget({
  productId,
  initialStage,
  initialReason,
}: {
  productId: string
  initialStage: StageKey | null
  initialReason: string | null
}) {
  const router = useRouter()
  const [stage, setStage] = useState<StageKey | null>(initialStage)
  const [reason, setReason] = useState<string | null>(initialReason)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function setStageTo(next: StageKey, droppedReason?: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/trend-radar/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, stage: next, dropped_reason: droppedReason ?? null }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      setStage(next)
      setReason(next === 'dropped' ? droppedReason ?? null : null)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장 실패')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded border border-gray-200 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">🪜 파이프라인 단계</h2>
        {busy && <span className="text-xs text-gray-400">저장 중…</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {STAGES.filter((s) => s.key !== 'dropped').map((s) => (
          <button
            key={s.key}
            type="button"
            disabled={busy}
            onClick={() => setStageTo(s.key)}
            className={`px-3 py-1.5 text-xs rounded border font-medium disabled:opacity-50 ${
              stage === s.key ? `${s.tone} bg-gray-50` : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            {stage === s.key ? '● ' : ''}
            {s.label}
          </button>
        ))}
      </div>
      <div className="border-t border-gray-100 pt-2">
        <div className="text-xs text-gray-500 mb-1.5">이탈 처리 (사유 선택):</div>
        <div className="flex flex-wrap gap-1.5">
          {DROP_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              disabled={busy}
              onClick={() => setStageTo('dropped', r)}
              className={`px-2.5 py-1 text-xs rounded border disabled:opacity-50 ${
                stage === 'dropped' && reason === r
                  ? 'border-rose-300 bg-rose-50 text-rose-700 font-medium'
                  : 'border-gray-200 text-gray-500 hover:bg-rose-50 hover:border-rose-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {stage === 'dropped' && reason && (
        <div className="text-xs text-rose-600">현재: 이탈 · 사유 {reason}</div>
      )}
      {error && <div className="text-xs text-rose-600">{error}</div>}
    </section>
  )
}
