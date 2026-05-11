'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { BlogGenerationPrompt } from '@/lib/blog-prompts'

type ParentLite = {
  id: string
  version: number
  label: string
  system_prompt: string
}

type Props = {
  prompt: BlogGenerationPrompt
  parent: ParentLite | null
}

export default function PromptEditor({ prompt, parent }: Props) {
  const router = useRouter()

  const [label, setLabel] = useState(prompt.label)
  const [systemPrompt, setSystemPrompt] = useState(prompt.system_prompt)
  const [changeSummary, setChangeSummary] = useState(prompt.change_summary ?? '')
  const [showParent, setShowParent] = useState(false)

  const [saving, setSaving] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const charCount = systemPrompt.length
  const dirty =
    label !== prompt.label ||
    systemPrompt !== prompt.system_prompt ||
    (changeSummary || null) !== (prompt.change_summary ?? null)

  const charDelta = useMemo(
    () => systemPrompt.length - prompt.system_prompt.length,
    [systemPrompt, prompt.system_prompt],
  )
  const parentDelta = useMemo(
    () => (parent ? systemPrompt.length - parent.system_prompt.length : 0),
    [systemPrompt, parent],
  )

  // 토큰 추정: 한국어 혼합 텍스트는 대략 1토큰 ≈ 2.5자
  const estTokens = Math.round(charCount / 2.5)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/blog/prompts/${prompt.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          system_prompt: systemPrompt,
          change_summary: changeSummary,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '저장 실패')
      setSavedAt(new Date().toLocaleTimeString('ko-KR'))
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
    } finally {
      setSaving(false)
    }
  }

  async function activate() {
    if (prompt.is_active) return
    if (!confirm(`v${prompt.version} 을 active 로 전환합니다. 진행할까요?`)) return
    setActivating(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/blog/prompts/${prompt.id}/activate`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '활성화 실패')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
    } finally {
      setActivating(false)
    }
  }

  async function saveAsNewVersion() {
    const newLabel = window.prompt(
      '새 버전 라벨을 입력하세요',
      `v? — ${prompt.label} 분기`,
    )
    if (!newLabel) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/blog/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newLabel,
          system_prompt: systemPrompt,
          parent_id: prompt.id,
          change_summary: changeSummary || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '버전 생성 실패')
      router.push(`/admin/blog/prompts/${data.prompt.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류')
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="자수" value={charCount.toLocaleString()} />
        <Stat
          label="이전 저장 대비"
          value={`${charDelta >= 0 ? '+' : ''}${charDelta.toLocaleString()}`}
          tone={charDelta === 0 ? 'neutral' : charDelta > 0 ? 'pos' : 'neg'}
        />
        <Stat
          label="parent 대비"
          value={parent ? `${parentDelta >= 0 ? '+' : ''}${parentDelta.toLocaleString()}` : '—'}
          tone={
            !parent ? 'neutral' : parentDelta === 0 ? 'neutral' : parentDelta > 0 ? 'pos' : 'neg'
          }
        />
        <Stat
          label="추정 토큰"
          value={`~${estTokens.toLocaleString()}`}
          tone={estTokens > 6000 ? 'warn' : 'neutral'}
        />
      </div>

      {parent && (
        <div className="bg-white border rounded-lg">
          <button
            type="button"
            onClick={() => setShowParent((v) => !v)}
            className="w-full text-left px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 flex justify-between items-center"
          >
            <span>
              📎 parent: v{parent.version} · {parent.label}
            </span>
            <span className="text-gray-400">{showParent ? '접기' : '펼치기'}</span>
          </button>
          {showParent && (
            <pre className="px-4 py-3 border-t text-xs whitespace-pre-wrap font-mono bg-gray-50 max-h-96 overflow-y-auto">
              {parent.system_prompt}
            </pre>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">라벨</label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">변경 사유</label>
        <Input
          value={changeSummary}
          onChange={(e) => setChangeSummary(e.target.value)}
          placeholder="예: AI 문체 검토 12건 반영, '결론적으로' 등 금지어 추가"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium text-gray-700">System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          spellCheck={false}
          className="w-full min-h-[600px] border rounded-md px-3 py-2 text-xs font-mono leading-relaxed"
        />
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 sticky bottom-0 bg-gray-50/95 backdrop-blur border-t pt-3">
        <div className="text-xs text-gray-500">
          {savedAt ? `저장됨 ${savedAt}` : dirty ? '저장되지 않은 변경 있음' : '변경 없음'}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={saveAsNewVersion}
            disabled={saving || !dirty}
            title="현재 편집 내용으로 새 버전을 만들고 이 버전을 parent 로 연결"
          >
            새 버전으로 저장
          </Button>
          <Button onClick={save} disabled={saving || !dirty} className="bg-blue-600 hover:bg-blue-700">
            {saving ? '저장 중…' : '같은 버전에 저장'}
          </Button>
          {!prompt.is_active && (
            <Button
              onClick={activate}
              disabled={activating}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {activating ? '전환 중…' : 'active 로 전환'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'pos' | 'neg' | 'warn'
}) {
  const color =
    tone === 'pos'
      ? 'text-emerald-700'
      : tone === 'neg'
        ? 'text-rose-700'
        : tone === 'warn'
          ? 'text-amber-700'
          : 'text-gray-900'
  return (
    <div className="bg-white border rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  )
}
