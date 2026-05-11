'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export type HeroPick = {
  position: number
  blog_slug: string | null
}

export type PostOption = {
  slug: string
  title: string
  category: string
}

export default function HeroPicksEditor({
  initialPicks,
  postOptions,
}: {
  initialPicks: HeroPick[]
  postOptions: PostOption[]
}) {
  const router = useRouter()
  const [picks, setPicks] = useState<HeroPick[]>(initialPicks)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  function patch(position: number, slug: string | null) {
    setPicks((arr) => arr.map((p) => (p.position === position ? { ...p, blog_slug: slug } : p)))
  }

  async function handleSave() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/admin/blog/hero-picks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ picks }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '저장 실패')
      setMsg({ type: 'success', text: '저장됨 — 메인 캐시 갱신됨' })
      router.refresh()
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : '오류' })
    } finally {
      setBusy(false)
    }
  }

  const sorted = [...picks].sort((a, b) => a.position - b.position)
  const filledCount = picks.filter((p) => p.blog_slug).length

  return (
    <div className="bg-white border rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">시뮬레이터 직하단 블로그 3선</h2>
          <p className="text-xs text-gray-500 mt-1">
            메인 페이지 시뮬레이터 검색바 바로 아래에 3개 노출. 비워두면 그 슬롯은 노출 안 됨. 모두 비우면 섹션 통째로 숨김.
          </p>
        </div>
        <span className="text-xs text-gray-500 font-mono">선택 {filledCount}/3</span>
      </div>

      {msg && (
        <div
          className={`rounded-md px-3 py-2 text-sm border ${
            msg.type === 'success'
              ? 'bg-green-50 border-green-100 text-green-700'
              : 'bg-red-50 border-red-100 text-red-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((p) => (
          <div key={p.position} className="flex items-center gap-3">
            <span className="text-xs font-mono text-gray-400 w-8">#{p.position}</span>
            <select
              value={p.blog_slug ?? ''}
              onChange={(e) => patch(p.position, e.target.value === '' ? null : e.target.value)}
              className="flex-1 border rounded-md px-3 py-2 text-sm"
            >
              <option value="">— 비움 —</option>
              {postOptions.map((opt) => (
                <option key={opt.slug} value={opt.slug}>
                  [{opt.category}] {opt.title}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={busy} className="bg-blue-600 hover:bg-blue-700">
          {busy ? '저장 중…' : '저장'}
        </Button>
      </div>
    </div>
  )
}
