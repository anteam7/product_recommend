'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

type Row = {
  id: string
  version: number
  label: string
  is_active: boolean
  parent_version_id: string | null
  change_summary: string | null
  derived_from_review_ids: string[]
  char_count: number
  created_at: string
  created_by: string | null
}

type Props = { prompts: Row[]; mode: 'seed' | 'list' }

export default function PromptListClient({ prompts, mode }: Props) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  async function seedV1() {
    if (!confirm('현재 코드 기본값을 v1 으로 시드하고 active 로 설정합니다. 진행할까요?')) return
    setSeeding(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/blog/prompts/seed', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '시드 실패')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
    } finally {
      setSeeding(false)
    }
  }

  async function clone(parent: Row) {
    setBusyId(parent.id)
    setError(null)
    try {
      const label = window.prompt(
        `v${parent.version} 을 베이스로 새 버전을 만듭니다. 새 버전 라벨:`,
        `v? — ${parent.label} 복제`,
      )
      if (!label) {
        setBusyId(null)
        return
      }
      const res = await fetch('/api/admin/blog/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_id: parent.id, label, change_summary: null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '복제 실패')
      router.push(`/admin/blog/prompts/${data.prompt.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
      setBusyId(null)
    }
  }

  async function activate(row: Row) {
    if (row.is_active) return
    if (!confirm(`v${row.version} (${row.label}) 을 active 로 전환합니다. 진행할까요?`)) return
    setBusyId(row.id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/blog/prompts/${row.id}/activate`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '활성화 실패')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(row: Row) {
    if (row.is_active) return
    if (!confirm(`v${row.version} (${row.label}) 을 영구 삭제합니다. 진행할까요?`)) return
    setBusyId(row.id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/blog/prompts/${row.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '삭제 실패')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
    } finally {
      setBusyId(null)
    }
  }

  if (mode === 'seed') {
    return (
      <div className="space-y-2">
        <Button onClick={seedV1} disabled={seeding} className="bg-amber-600 hover:bg-amber-700">
          {seeding ? '시드 중…' : '코드 기본값으로 v1 시드 + active'}
        </Button>
        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
            {error}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">버전</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">라벨</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">변경 사유</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">자수</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">생성</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase"></th>
            </tr>
          </thead>
          <tbody>
            {prompts.map((p) => {
              const busy = busyId === p.id
              return (
                <tr key={p.id} className="border-b last:border-b-0 hover:bg-gray-50/50">
                  <td className="px-4 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-gray-900">v{p.version}</span>
                      {p.is_active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
                          active
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 align-top">
                    <Link
                      href={`/admin/blog/prompts/${p.id}`}
                      className="font-medium text-gray-900 hover:text-blue-600 hover:underline"
                    >
                      {p.label}
                    </Link>
                    {p.derived_from_review_ids.length > 0 && (
                      <div className="text-[10px] text-indigo-700 mt-0.5">
                        검토 {p.derived_from_review_ids.length}건 반영
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top text-xs text-gray-600 max-w-[320px]">
                    <div className="line-clamp-2">{p.change_summary || '—'}</div>
                  </td>
                  <td className="px-4 py-2 align-top text-right font-mono text-xs text-gray-700">
                    {p.char_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 align-top text-xs text-gray-500 whitespace-nowrap">
                    {new Date(p.created_at).toLocaleDateString('ko-KR', {
                      year: '2-digit',
                      month: '2-digit',
                      day: '2-digit',
                    })}
                    {p.created_by && (
                      <div className="text-[10px] text-gray-400 truncate max-w-[120px]" title={p.created_by}>
                        {p.created_by}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top text-right whitespace-nowrap">
                    <div className="inline-flex flex-wrap gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => clone(p)}
                        disabled={busy}
                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        복제
                      </button>
                      {!p.is_active && (
                        <button
                          type="button"
                          onClick={() => activate(p)}
                          disabled={busy}
                          className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          active
                        </button>
                      )}
                      {!p.is_active && (
                        <button
                          type="button"
                          onClick={() => remove(p)}
                          disabled={busy}
                          className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          삭제
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
