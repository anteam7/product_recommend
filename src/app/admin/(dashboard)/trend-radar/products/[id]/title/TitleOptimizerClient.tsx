'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

interface Candidate {
  id: string
  batch_id: string
  title: string
  score: number
  covered_keywords: string[]
  covered_volume: number
  char_len: number
  blocked_terms: string[]
  notes: string | null
  llm_model: string | null
  generated_at: string
}

const MAX_TITLE_LEN = 50

export default function TitleOptimizerClient({
  productId,
  initialLatest,
  initialOlder,
  initialPinnedCandidateId,
}: {
  productId: string
  initialLatest: Candidate[]
  initialOlder: Candidate[]
  initialPinnedCandidateId: string | null
}) {
  const router = useRouter()
  const [latest, setLatest] = useState<Candidate[]>(initialLatest)
  const [older, setOlder] = useState<Candidate[]>(initialOlder)
  const [pinnedId, setPinnedId] = useState<string | null>(initialPinnedCandidateId)
  const [error, setError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [pinning, startPinning] = useTransition()

  async function generate() {
    setError(null)
    setIsGenerating(true)
    try {
      const res = await fetch(
        `/api/admin/trend-radar/products/${productId}/generate-titles`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? '생성 실패')
        return
      }
      const newCands = (json.candidates ?? []) as Candidate[]
      // 기존 latest 는 older 로 이동
      setOlder((prev) => [...latest, ...prev].slice(0, 50))
      setLatest(newCands)
    } catch (e) {
      setError(e instanceof Error ? e.message : '네트워크 오류')
    } finally {
      setIsGenerating(false)
    }
  }

  async function copyToClipboard(c: Candidate) {
    try {
      await navigator.clipboard.writeText(c.title)
      setCopied(c.id)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setError('클립보드 복사 실패 — 권한 확인')
    }
  }

  function pin(c: Candidate) {
    setError(null)
    startPinning(async () => {
      const res = await fetch(`/api/admin/trend-radar/products/${productId}/pin-title`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidate_id: c.id }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? '선택 실패')
        return
      }
      setPinnedId(c.id)
      router.refresh()
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={isGenerating}
          className="px-4 py-2 rounded bg-black text-white text-sm font-medium disabled:opacity-50"
        >
          {isGenerating ? '생성 중...' : latest.length === 0 ? '제목 후보 생성' : '재생성'}
        </button>
        <span className="text-xs text-gray-500">
          Gemini Flash · alias 풀 + 최근 30일 검색 트렌드 + 금지어 게이트
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {latest.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          아직 생성된 후보가 없습니다. 위 버튼을 눌러 4~6개 후보를 받아보세요.
        </div>
      ) : (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            최신 batch — {latest[0]?.llm_model ?? '-'} ·{' '}
            {latest[0]?.generated_at?.slice(0, 19).replace('T', ' ')}
          </h2>
          <ul className="space-y-3">
            {latest.map((c) => (
              <CandidateCard
                key={c.id}
                cand={c}
                isPinned={pinnedId === c.id}
                onCopy={() => copyToClipboard(c)}
                copied={copied === c.id}
                onPin={() => pin(c)}
                pinning={pinning}
              />
            ))}
          </ul>
        </section>
      )}

      {older.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-500 hover:text-black">
            이전 batch ({older.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {older.map((c) => (
              <li
                key={c.id}
                className="rounded border border-gray-200 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate">{c.title}</div>
                  <div className="text-[10px] text-gray-400 font-mono mt-1">
                    {c.generated_at.slice(0, 19).replace('T', ' ')} · {c.char_len}자 · score{' '}
                    {c.score}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(c.title)}
                  className="text-xs text-gray-500 hover:text-black shrink-0"
                >
                  복사
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function CandidateCard({
  cand,
  isPinned,
  onCopy,
  copied,
  onPin,
  pinning,
}: {
  cand: Candidate
  isPinned: boolean
  onCopy: () => void
  copied: boolean
  onPin: () => void
  pinning: boolean
}) {
  const overLimit = cand.char_len > MAX_TITLE_LEN
  const hasBlocked = cand.blocked_terms.length > 0
  const isValid = !overLimit && !hasBlocked

  return (
    <li
      className={[
        'rounded border p-4',
        isPinned
          ? 'border-emerald-400 bg-emerald-50'
          : isValid
            ? 'border-gray-200'
            : 'border-amber-300 bg-amber-50',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-semibold break-words">{cand.title}</div>
          <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
            <span
              className={
                overLimit
                  ? 'font-mono text-red-600 font-semibold'
                  : 'font-mono text-gray-500'
              }
            >
              {cand.char_len}/{MAX_TITLE_LEN}자
            </span>
            <span className="font-mono text-gray-500">score {cand.score}</span>
            <span className="font-mono text-gray-500">
              volume {cand.covered_volume.toFixed(1)}
            </span>
            {hasBlocked && (
              <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                금지어: {cand.blocked_terms.join(', ')}
              </span>
            )}
            {overLimit && (
              <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-medium">
                50자 초과
              </span>
            )}
          </div>
          {cand.covered_keywords.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {cand.covered_keywords.map((kw, i) => (
                <span
                  key={i}
                  className="text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-700"
                >
                  {kw}
                </span>
              ))}
            </div>
          )}
          {cand.notes && (
            <p className="mt-2 text-xs text-gray-600 leading-relaxed">{cand.notes}</p>
          )}
        </div>
        <div className="shrink-0 flex flex-col gap-2 items-end">
          <button
            type="button"
            onClick={onCopy}
            className="px-3 py-1.5 rounded border border-gray-300 text-xs font-medium hover:bg-gray-50"
          >
            {copied ? '복사됨' : '복사'}
          </button>
          <button
            type="button"
            onClick={onPin}
            disabled={!isValid || isPinned || pinning}
            className={[
              'px-3 py-1.5 rounded text-xs font-medium',
              isPinned
                ? 'bg-emerald-600 text-white'
                : isValid
                  ? 'bg-black text-white hover:bg-gray-800'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed',
            ].join(' ')}
          >
            {isPinned ? '선택됨' : pinning ? '...' : '선택'}
          </button>
        </div>
      </div>
    </li>
  )
}
