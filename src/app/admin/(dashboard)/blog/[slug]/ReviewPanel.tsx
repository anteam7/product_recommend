'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DEFAULT_REVIEW_PERSPECTIVES,
  GROUNDING_PRESET_PERSPECTIVES,
  type BlogPostReview,
  type ReviewPerspectivePreset,
} from '@/lib/blog'

type Props = {
  slug: string
  reviews: BlogPostReview[]
  savedPerspectives: ReviewPerspectivePreset[]
}

export default function ReviewPanel({ slug, reviews, savedPerspectives }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [selected, setSelected] = useState<Set<string>>(
    new Set<string>(DEFAULT_REVIEW_PERSPECTIVES),
  )
  const [customInput, setCustomInput] = useState('')
  const [presets, setPresets] = useState(savedPerspectives)
  const [useGrounding, setUseGrounding] = useState<boolean>(
    DEFAULT_REVIEW_PERSPECTIVES.some((p) => GROUNDING_PRESET_PERSPECTIVES.includes(p)),
  )
  const [groundingTouched, setGroundingTouched] = useState(false)

  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [reverting, setReverting] = useState<string | null>(null)

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      // 사용자가 grounding 토글을 아직 직접 안 건드렸으면, 팩트 검증 선택 여부에 맞춰 자동 토글
      if (!groundingTouched) {
        const hasGroundingPerspective = Array.from(next).some((n) =>
          GROUNDING_PRESET_PERSPECTIVES.includes(n),
        )
        setUseGrounding(hasGroundingPerspective)
      }
      return next
    })
  }

  const groundingRequired = Array.from(selected).some((n) =>
    GROUNDING_PRESET_PERSPECTIVES.includes(n),
  )

  async function addCustom() {
    const name = customInput.trim()
    if (!name) return
    if (name.length > 40) {
      setMsg({ type: 'error', text: '관점 이름은 40자 이내' })
      return
    }
    try {
      const res = await fetch('/api/admin/blog/review-perspectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '추가 실패')
      setPresets((prev) => [data.perspective, ...prev.filter((p) => p.name !== name)])
      setSelected((prev) => new Set(prev).add(name))
      setCustomInput('')
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    }
  }

  async function deletePreset(id: string, name: string) {
    if (!confirm(`"${name}" 관점 프리셋을 삭제합니다. 과거 검토 로그는 유지됩니다.`)) return
    try {
      const res = await fetch(`/api/admin/blog/review-perspectives?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error((await res.json()).error ?? '삭제 실패')
      setPresets((prev) => prev.filter((p) => p.id !== id))
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    }
  }

  async function runReview() {
    const perspectives = Array.from(selected)
    if (perspectives.length === 0) {
      setMsg({ type: 'error', text: '관점을 최소 1개 선택하세요' })
      return
    }
    if (
      !confirm(
        `${perspectives.length}개 관점으로 검토하고 결과를 본문에 자동 반영합니다.\n관점: ${perspectives.join(', ')}\n\n기존 본문은 스냅샷으로 남아 원복 가능합니다. 계속할까요?`,
      )
    )
      return
    setRunning(true)
    setMsg({ type: 'info', text: 'AI가 본문을 검토·수정 중… (30~60초)' })
    try {
      const res = await fetch(`/api/admin/blog/${slug}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perspectives, useGrounding }),
      })
      const data = await res.json()
      if (!res.ok) {
        const detail = data.finishReason ? ` [${data.finishReason}]` : ''
        throw new Error(`${data.error ?? '검토 실패'}${detail}`)
      }
      const changed = data.changed as { title: boolean; description: boolean; content: boolean }
      const changedFields = [
        changed.title && '제목',
        changed.description && '메타',
        changed.content && '본문',
      ]
        .filter(Boolean)
        .join(', ')
      setMsg({
        type: 'success',
        text: changedFields
          ? `검토 완료 — ${changedFields} 반영됨.`
          : '검토 완료 — 수정할 만한 부분이 없어 원문 유지.',
      })
      startTransition(() => router.refresh())
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setRunning(false)
    }
  }

  async function revertReview(reviewId: string) {
    if (!confirm('이 검토로 반영된 변경을 원복합니다. 현재 본문은 그 이전 스냅샷으로 되돌아갑니다. 계속할까요?'))
      return
    setReverting(reviewId)
    try {
      const res = await fetch(
        `/api/admin/blog/${slug}/reviews/${reviewId}/revert`,
        { method: 'POST' },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '원복 실패')
      setMsg({ type: 'success', text: '원복 완료.' })
      startTransition(() => router.refresh())
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setReverting(null)
    }
  }

  const allOptions: { name: string; isDefault: boolean; presetId?: string }[] = [
    ...DEFAULT_REVIEW_PERSPECTIVES.map((n) => ({ name: n, isDefault: true })),
    ...presets.map((p) => ({ name: p.name, isDefault: false, presetId: p.id })),
  ]

  return (
    <section className="bg-white border rounded-lg p-5 space-y-4">
      <header className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-gray-900">🧐 AI 검토·자동 수정</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            선택한 관점에서만 글을 검토하고 본문·제목·메타에 즉시 반영합니다. 반영된 변경은 언제든 원복할 수 있어요.
          </p>
        </div>
        <Button
          size="sm"
          onClick={runReview}
          disabled={running || selected.size === 0}
          className="bg-indigo-600 hover:bg-indigo-700"
        >
          {running ? '검토 중…' : `🔍 검토 실행 (${selected.size})`}
        </Button>
      </header>

      {/* 관점 선택 */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-gray-700">검토 관점</div>
        <div className="flex flex-wrap gap-1.5">
          {allOptions.map((opt) => {
            const active = selected.has(opt.name)
            return (
              <span
                key={opt.name}
                className={`inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1.5 py-1 text-xs transition ${
                  active
                    ? 'bg-indigo-600 border-indigo-600 text-white'
                    : 'bg-white border-gray-300 text-gray-700 hover:border-indigo-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggle(opt.name)}
                  disabled={running}
                  className="font-medium"
                >
                  {opt.name}
                </button>
                {!opt.isDefault && opt.presetId && (
                  <button
                    type="button"
                    onClick={() => deletePreset(opt.presetId!, opt.name)}
                    disabled={running}
                    className={`ml-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
                      active ? 'hover:bg-white/20' : 'hover:bg-gray-200'
                    }`}
                    title="이 프리셋 삭제"
                  >
                    ×
                  </button>
                )}
              </span>
            )
          })}
        </div>

        <div className="flex gap-1.5 pt-1">
          <Input
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCustom()
              }
            }}
            placeholder="새 관점 추가 (예: 법적 리스크, 광고 친화도…)"
            disabled={running}
            className="text-xs h-8"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={addCustom}
            disabled={running || !customInput.trim()}
          >
            + 추가
          </Button>
        </div>

        <label className="flex items-center gap-2 pt-1 text-xs text-gray-700 select-none">
          <input
            type="checkbox"
            checked={useGrounding}
            onChange={(e) => {
              setUseGrounding(e.target.checked)
              setGroundingTouched(true)
            }}
            disabled={running}
            className="accent-indigo-600"
          />
          <span>
            🔎 웹 검색 결합 (Google Search grounding)
            {groundingRequired && (
              <span className="ml-1 text-[10px] text-indigo-600">
                — 팩트 검증 선택 시 자동 권장
              </span>
            )}
          </span>
        </label>
      </div>

      {msg && (
        <div
          className={`text-xs rounded px-3 py-2 border ${
            msg.type === 'success'
              ? 'bg-green-50 border-green-100 text-green-700'
              : msg.type === 'error'
                ? 'bg-red-50 border-red-100 text-red-700'
                : 'bg-blue-50 border-blue-100 text-blue-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* 검토 이력 */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-gray-700">
          검토 이력 ({reviews.length})
        </div>
        {reviews.length === 0 ? (
          <div className="text-xs text-gray-400 bg-gray-50 rounded px-3 py-3">
            아직 검토 이력이 없습니다.
          </div>
        ) : (
          <div className="space-y-2">
            {reviews.map((r, idx) => (
              <details
                key={r.id}
                open={idx === 0}
                className="border rounded-md"
              >
                <summary className="cursor-pointer list-none px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <span className="text-xs font-mono text-gray-500 shrink-0">
                      #{reviews.length - idx}
                    </span>
                    {r.reverted_at ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        원복됨
                      </span>
                    ) : r.applied ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                        반영됨
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        변경 없음
                      </span>
                    )}
                    <span className="text-[11px] text-gray-500 truncate">
                      {r.perspectives.join(', ')}
                    </span>
                    {r.summary && (
                      <span className="text-[11px] text-gray-600 truncate">— {r.summary}</span>
                    )}
                  </div>
                  <span className="text-[11px] text-gray-400 shrink-0">
                    {new Date(r.created_at).toLocaleString('ko-KR', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
                  </span>
                </summary>
                <div className="px-3 py-3 border-t space-y-3 bg-gray-50/50">
                  {r.findings.length > 0 && (
                    <div className="space-y-2">
                      {r.findings.map((f, i) => (
                        <div key={i} className="bg-white border rounded px-2.5 py-2">
                          <div className="text-xs font-semibold text-indigo-700 mb-1">
                            {f.perspective}
                          </div>
                          {f.issues.length > 0 && (
                            <div className="mb-1">
                              <div className="text-[11px] font-medium text-gray-600">문제</div>
                              <ul className="list-disc list-inside text-xs text-gray-700 space-y-0.5">
                                {f.issues.map((it, j) => (
                                  <li key={j}>{it}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {f.suggestions.length > 0 && (
                            <div>
                              <div className="text-[11px] font-medium text-gray-600">반영</div>
                              <ul className="list-disc list-inside text-xs text-gray-700 space-y-0.5">
                                {f.suggestions.map((it, j) => (
                                  <li key={j}>{it}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {r.grounding_urls && r.grounding_urls.length > 0 && (
                    <div className="bg-white border rounded px-2.5 py-2">
                      <div className="text-[11px] font-semibold text-gray-700 mb-1">
                        🔎 참고한 웹 출처 ({r.grounding_urls.length})
                      </div>
                      <ul className="space-y-0.5">
                        {r.grounding_urls.slice(0, 10).map((u, i) => (
                          <li key={i} className="text-[11px] truncate">
                            <a
                              href={u}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline break-all"
                            >
                              {u}
                            </a>
                          </li>
                        ))}
                        {r.grounding_urls.length > 10 && (
                          <li className="text-[11px] text-gray-400">
                            …외 {r.grounding_urls.length - 10}개
                          </li>
                        )}
                      </ul>
                    </div>
                  )}

                  <div className="flex items-center gap-2 text-[11px] text-gray-500">
                    <span>모델: {r.model ?? '—'}</span>
                    {r.reverted_at && (
                      <span>
                        · 원복 시각{' '}
                        {new Date(r.reverted_at).toLocaleString('ko-KR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                    )}
                    {r.applied && !r.reverted_at && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => revertReview(r.id)}
                        disabled={reverting === r.id}
                        className="ml-auto text-xs h-7 text-red-600"
                      >
                        {reverting === r.id ? '원복 중…' : '이 변경 원복'}
                      </Button>
                    )}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
