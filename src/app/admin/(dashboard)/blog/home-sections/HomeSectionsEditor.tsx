'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export type Layout = 'hero4' | 'row3'

export type Section = {
  category: string
  active: boolean
  layout: Layout
  display_order: number
}

const LAYOUT_LABEL: Record<Layout, string> = {
  hero4: '1대4 (큰 카드 + 작은 4)',
  row3: '1줄 3 (균등)',
}

export default function HomeSectionsEditor({
  initialSections,
  pinnedCounts,
}: {
  initialSections: Section[]
  pinnedCounts: Record<string, number>
}) {
  const router = useRouter()
  const [sections, setSections] = useState<Section[]>(initialSections)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  function patch(category: string, patchFn: (s: Section) => Section) {
    setSections((arr) => arr.map((s) => (s.category === category ? patchFn(s) : s)))
  }

  async function handleSave() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/admin/blog/home-sections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '저장 실패')
      setMsg({ type: 'success', text: '저장됨 — 메인 페이지 캐시 갱신됨' })
      router.refresh()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '오류' })
    } finally {
      setBusy(false)
    }
  }

  const sorted = [...sections].sort((a, b) => a.display_order - b.display_order)

  return (
    <div className="space-y-4">
      {msg && (
        <div
          className={`rounded-md px-4 py-2 text-sm border ${
            msg.type === 'success'
              ? 'bg-green-50 border-green-100 text-green-700'
              : 'bg-red-50 border-red-100 text-red-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                카테고리
              </th>
              <th className="text-center px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                활성
              </th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                레이아웃
              </th>
              <th className="text-center px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                순서
              </th>
              <th className="text-center px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                📌 핀된 글
              </th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const count = pinnedCounts[s.category] ?? 0
              return (
                <tr
                  key={s.category}
                  className={`border-b last:border-b-0 hover:bg-gray-50/50 ${
                    !s.active ? 'opacity-50' : ''
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{s.category}</td>
                  <td className="px-4 py-3 text-center">
                    <label className="inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={s.active}
                        onChange={(e) => patch(s.category, (x) => ({ ...x, active: e.target.checked }))}
                        className="h-4 w-4 cursor-pointer"
                      />
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={s.layout}
                      onChange={(e) =>
                        patch(s.category, (x) => ({ ...x, layout: e.target.value as Layout }))
                      }
                      className="border rounded-md px-2 py-1.5 text-sm"
                    >
                      {(Object.keys(LAYOUT_LABEL) as Layout[]).map((l) => (
                        <option key={l} value={l}>
                          {LAYOUT_LABEL[l]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <input
                      type="number"
                      value={s.display_order}
                      onChange={(e) =>
                        patch(s.category, (x) => ({
                          ...x,
                          display_order: Number(e.target.value) || 0,
                        }))
                      }
                      className="w-16 rounded-md border px-2 py-1 text-center text-sm"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        count === 0
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {count}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/blog?filter=home`}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      글 관리 →
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button onClick={handleSave} disabled={busy} className="bg-blue-600 hover:bg-blue-700">
          {busy ? '저장 중…' : '저장'}
        </Button>
      </div>
    </div>
  )
}
