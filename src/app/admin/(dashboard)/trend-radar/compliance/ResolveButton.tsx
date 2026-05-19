'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ResolveButton({ findingId }: { findingId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')

  async function submit() {
    if (!note.trim()) {
      alert('해제 사유를 입력하세요.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/compliance/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finding_id: findingId, resolution_note: note }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        alert(`해제 실패: ${j.error ?? res.status}`)
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1 text-xs rounded border border-red-300 text-red-700 hover:bg-red-50"
      >
        해제
      </button>
    )
  }

  return (
    <div className="space-y-1">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="해제 사유 (예: 면책문구 추가 완료, 룰 오탐)"
        className="w-full text-xs border border-gray-300 rounded px-2 py-1"
        rows={2}
      />
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 py-0.5 text-xs text-gray-500 hover:text-black"
          disabled={busy}
        >
          취소
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="px-2 py-0.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? '...' : '확정'}
        </button>
      </div>
    </div>
  )
}
