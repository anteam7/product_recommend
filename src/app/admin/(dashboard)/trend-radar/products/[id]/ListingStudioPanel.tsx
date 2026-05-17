'use client'

import { useState, useTransition } from 'react'

export interface ExistingDraft {
  variant_idx: number
  kind: string
  content_md: string
  llm_model: string
  created_at: string
}

interface Props {
  productId: string
  initialDrafts: ExistingDraft[]
  initialPinStatus: string | null
}

type DraftMap = Record<string, string>

const KIND_LABEL: Record<string, string> = {
  title_short: '제목 (40자)',
  title_long: '제목 (100자)',
  tags: '태그 / 카테고리',
  detail_md: '상세 마크다운',
  thumb_hook: '썸네일 카피',
}
const KIND_ORDER = ['title_short', 'title_long', 'tags', 'detail_md', 'thumb_hook'] as const

function mapByKind(drafts: ExistingDraft[]): DraftMap {
  const m: DraftMap = {}
  for (const d of drafts) m[d.kind] = d.content_md
  return m
}

function latestVariantIdx(drafts: ExistingDraft[]): number | null {
  if (!drafts.length) return null
  return Math.max(...drafts.map((d) => d.variant_idx))
}

export default function ListingStudioPanel({ productId, initialDrafts, initialPinStatus }: Props) {
  const latestIdx = latestVariantIdx(initialDrafts)
  const latestOnly = latestIdx != null ? initialDrafts.filter((d) => d.variant_idx === latestIdx) : []

  const [drafts, setDrafts] = useState<DraftMap>(mapByKind(latestOnly))
  const [variantIdx, setVariantIdx] = useState<number | null>(latestIdx)
  const [pinStatus, setPinStatus] = useState<string>(initialPinStatus ?? 'pending')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('title_short')

  const hasDrafts = Object.keys(drafts).length > 0

  function generate() {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/trend-radar/products/${productId}/listing-studio/generate`, {
          method: 'POST',
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'failed')
        const map: DraftMap = {}
        for (const d of json.drafts as { kind: string; content_md: string }[]) {
          map[d.kind] = d.content_md
        }
        setDrafts(map)
        setVariantIdx(json.variantIdx)
        setPinStatus('drafted')
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  function markStatus(next: 'drafted' | 'published') {
    setError(null)
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/trend-radar/products/${productId}/listing-studio/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'failed')
        setPinStatus(next)
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  async function copy(kind: string) {
    const text = drafts[kind]
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // ignore
    }
  }

  return (
    <section className="rounded-lg border border-indigo-200 bg-indigo-50/30 p-5">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold flex items-center gap-2">
            🎨 Listing Studio
            {variantIdx != null && (
              <span className="text-xs font-mono text-indigo-600 bg-indigo-100 rounded px-2 py-0.5">
                v{variantIdx}
              </span>
            )}
            <span
              className={`text-xs rounded px-2 py-0.5 font-medium ${
                pinStatus === 'published'
                  ? 'bg-emerald-100 text-emerald-700'
                  : pinStatus === 'drafted'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-600'
              }`}
            >
              {pinStatus}
            </span>
          </h2>
          <p className="text-xs text-gray-600 mt-1">
            핀 컨텍스트 (페인포인트·검색의도·도매가·N-gram) 기반 SEO 상세 초안 5종 1클릭 생성. 운영자가 복사·수정·외부 채널 업로드.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={pending}
            className="text-sm bg-indigo-600 text-white rounded px-3 py-1.5 font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {pending ? '생성 중…' : hasDrafts ? '재생성 (새 variant)' : '초안 생성'}
          </button>
          {hasDrafts && (
            <button
              onClick={() => markStatus(pinStatus === 'published' ? 'drafted' : 'published')}
              disabled={pending}
              className="text-sm rounded px-3 py-1.5 font-medium border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              {pinStatus === 'published' ? '발행 해제' : '발행 완료'}
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">
          {error}
        </div>
      )}

      {!hasDrafts ? (
        <div className="text-sm text-gray-600 py-6 text-center bg-white rounded border border-dashed border-indigo-200">
          아직 초안이 없습니다. <strong>초안 생성</strong> 버튼을 누르면 핀 시그널 컨텍스트로 5종 초안을 즉시 생성합니다.
        </div>
      ) : (
        <>
          <div className="flex gap-1 mb-2 flex-wrap">
            {KIND_ORDER.filter((k) => drafts[k]).map((k) => (
              <button
                key={k}
                onClick={() => setActiveTab(k)}
                className={`text-xs px-2 py-1 rounded font-medium ${
                  activeTab === k
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {KIND_LABEL[k] ?? k}
              </button>
            ))}
          </div>
          <div className="bg-white rounded border border-gray-200">
            <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5">
              <span className="text-xs font-medium text-gray-600">
                {KIND_LABEL[activeTab] ?? activeTab}
              </span>
              <button
                onClick={() => copy(activeTab)}
                className="text-xs text-indigo-600 hover:underline"
              >
                클립보드 복사
              </button>
            </div>
            <pre className="text-xs p-3 whitespace-pre-wrap break-words font-sans text-gray-800 leading-relaxed max-h-[480px] overflow-y-auto">
              {drafts[activeTab] ?? ''}
            </pre>
          </div>
          <p className="text-[10px] text-gray-500 mt-2 font-mono">
            엔진: rule_engine_v1 (결정론적 템플릿) · LLM 스왑은 후속 PR.
            스마트스토어 등록 시 제목·태그·상세를 각각 복사해서 양식에 매핑.
          </p>
        </>
      )}
    </section>
  )
}
