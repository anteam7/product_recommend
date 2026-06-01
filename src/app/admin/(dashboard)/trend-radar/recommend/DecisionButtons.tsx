'use client'

import { useState } from 'react'

export interface ScoreSnapshot {
  final_score: number
  tv_score: number
  search_score: number
  price_krw: number | null
  is_imminent: boolean
  ggsan_status?: string | null
}

type Decision = 'adopted' | 'deferred' | 'rejected'

const DECISIONS: { v: Decision; label: string; active: string; idle: string }[] = [
  { v: 'adopted', label: '채택', active: 'bg-emerald-600 text-white', idle: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' },
  { v: 'deferred', label: '보류', active: 'bg-amber-500 text-white', idle: 'bg-amber-50 text-amber-700 hover:bg-amber-100' },
  { v: 'rejected', label: '반려', active: 'bg-rose-600 text-white', idle: 'bg-rose-50 text-rose-700 hover:bg-rose-100' },
]

// 사유코드 — 회고 보드의 편향 집계 단위. 적을수록 통계가 또렷해진다.
const REASONS: { v: string; label: string }[] = [
  { v: 'too_competitive', label: '경쟁심함' },
  { v: 'low_margin', label: '마진박함' },
  { v: 'thin_demand', label: '수요약함' },
  { v: 'risky_supplier', label: '공급불안' },
  { v: 'good_fit', label: '핏좋음' },
  { v: 'imminent', label: '임박기회' },
  { v: 'other', label: '기타' },
]

export default function DecisionButtons({
  goodsNo,
  snapshot,
  initialDecision,
  initialReason,
}: {
  goodsNo: string
  snapshot: ScoreSnapshot
  initialDecision?: string | null
  initialReason?: string | null
}) {
  const [decision, setDecision] = useState<string | null>(initialDecision ?? null)
  const [reason, setReason] = useState<string>(initialReason ?? '')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(d: Decision) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/trend-radar/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goodsNo,
          decision: d,
          reasonCode: reason || null,
          note: note || null,
          scoreSnapshot: snapshot,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? '저장 실패')
      } else {
        setDecision(d)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '네트워크 오류')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white"
        aria-label="사유"
      >
        <option value="">사유…</option>
        {REASONS.map((r) => (
          <option key={r.v} value={r.v}>
            {r.label}
          </option>
        ))}
      </select>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="메모 1줄"
        className="text-xs border border-gray-200 rounded px-2 py-1 w-32 sm:w-44"
      />
      {DECISIONS.map((d) => (
        <button
          key={d.v}
          type="button"
          disabled={saving}
          onClick={() => submit(d.v)}
          className={`text-xs px-2.5 py-1 rounded font-medium transition-colors disabled:opacity-50 ${
            decision === d.v ? d.active : d.idle
          }`}
        >
          {d.label}
        </button>
      ))}
      {decision && (
        <span className="text-[11px] text-gray-500">
          ✓ 기록됨: <strong>{labelOf(decision)}</strong>
        </span>
      )}
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </div>
  )
}

function labelOf(d: string): string {
  return DECISIONS.find((x) => x.v === d)?.label ?? d
}
