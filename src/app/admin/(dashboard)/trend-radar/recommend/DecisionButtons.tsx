'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export const REASON_OPTIONS: { code: string; label: string }[] = [
  { code: 'margin', label: '마진부족' },
  { code: 'red_ocean', label: '레드오션' },
  { code: 'cert_burden', label: '인증부담' },
  { code: 'season_end', label: '계절끝물' },
  { code: 'brand_lock', label: '브랜드종속' },
  { code: 'no_supplier', label: '도매없음' },
  { code: 'other', label: '기타' },
]

export type CurrentDecision = {
  decision: string
  reason_code: string | null
  expires_at: string | null
} | null

export default function DecisionButtons({
  goodsNo,
  cateCd,
  title,
  current,
}: {
  goodsNo: string
  cateCd: string | null
  title: string
  current: CurrentDecision
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [pickReason, setPickReason] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function send(payload: Record<string, unknown>) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/trends/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goods_no: goodsNo, cate_cd: cateCd, title, ...payload }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setErr(json.error ?? '실패')
        return
      }
      setPickReason(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (current) {
    const label =
      current.decision === 'rejected'
        ? `기각됨${current.reason_code ? ` · ${reasonLabel(current.reason_code)}` : ''}`
        : current.decision === 'snoozed'
          ? `스누즈 (${current.expires_at?.slice(0, 10) ?? ''}까지)`
          : current.decision
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs rounded bg-gray-200 text-gray-700 px-2 py-0.5">{label}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => send({ clear: true })}
          className="text-xs text-blue-600 hover:underline disabled:opacity-50"
        >
          복원
        </button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
    )
  }

  if (pickReason) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {REASON_OPTIONS.map((r) => (
          <button
            key={r.code}
            type="button"
            disabled={busy}
            onClick={() => send({ decision: 'rejected', reason_code: r.code })}
            className="text-xs rounded bg-rose-50 text-rose-700 hover:bg-rose-100 px-2 py-0.5 disabled:opacity-50"
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPickReason(false)}
          className="text-xs text-gray-400 hover:text-gray-600 px-1"
        >
          취소
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => setPickReason(true)}
        className="text-xs rounded bg-rose-100 text-rose-700 hover:bg-rose-200 px-2 py-0.5 disabled:opacity-50"
      >
        기각(사유)
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => send({ decision: 'snoozed', snooze_days: 14 })}
        className="text-xs rounded bg-amber-100 text-amber-700 hover:bg-amber-200 px-2 py-0.5 disabled:opacity-50"
      >
        스누즈 14일
      </button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  )
}

export function reasonLabel(code: string): string {
  return REASON_OPTIONS.find((r) => r.code === code)?.label ?? code
}
