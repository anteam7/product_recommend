'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export default function DedupRowActions({
  productAId,
  productBId,
  productAName,
  productBName,
}: {
  productAId: string
  productBId: string
  productAName: string
  productBName: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  async function merge(targetId: string, sourceId: string, targetName: string, sourceName: string) {
    if (!confirm(`머지 진행?\n\n유지: ${targetName}\n흡수: ${sourceName}\n\nalias/image/score 가 유지 product 로 이관되고 흡수 쪽은 삭제됩니다.`)) return
    setMsg('머지 중…')
    try {
      const res = await fetch('/api/admin/trend-radar/dedup/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: targetId, source_id: sourceId }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setMsg(`실패: ${json.error ?? res.statusText}`)
        return
      }
      setMsg(`✓ 머지 완료 · alias ${json.moved_aliases ?? 0}, image ${json.moved_images ?? 0}`)
      startTransition(() => router.refresh())
    } catch (e) {
      setMsg(`실패: ${(e as Error).message}`)
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      {msg && <span className="text-gray-600">{msg}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() => merge(productAId, productBId, productAName, productBName)}
        className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
      >
        ← A 유지
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => merge(productBId, productAId, productBName, productAName)}
        className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
      >
        B 유지 →
      </button>
    </div>
  )
}
